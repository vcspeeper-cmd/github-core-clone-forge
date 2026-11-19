// A GitHub-compatible forge: REST v3, GraphQL v4, MCP and git smart HTTP over one in-memory store.
// Node 22, standard library only, no dependencies.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

const JSON_TYPE = 'application/json; charset=utf-8';

// ---------------------------------------------------------------- clock (deterministic)

let tick = 0;
const BASE_MS = 1_760_000_000_000;
function nowMs(): number {
  tick += 1;
  return BASE_MS + tick * 1000;
}
const isoCache = new Map<number, string>();
function iso(ms: number): string {
  const hit = isoCache.get(ms);
  if (hit !== undefined) return hit;
  const text = new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  if (isoCache.size > 8192) isoCache.clear();
  isoCache.set(ms, text);
  return text;
}

// ---------------------------------------------------------------- git objects

type ObjType = 'blob' | 'tree' | 'commit' | 'tag';
interface GitObj {
  type: ObjType;
  data: Buffer;
}

interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

function sha1(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

function objectId(type: ObjType, data: Buffer): string {
  return sha1(Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'utf8'), data]));
}

function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const id = objectId(type, data);
  if (!repo.objects.has(id)) repo.objects.set(id, { type, data });
  return id;
}

function readObject(repo: Repo, id: string): GitObj | null {
  return repo.objects.get(id.toLowerCase()) ?? null;
}

function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const nul = data.indexOf(0, sp);
    if (nul < 0) break;
    const mode = data.toString('ascii', i, sp);
    const name = data.toString('utf8', sp + 1, nul);
    const sha = data.toString('hex', nul + 1, nul + 21);
    out.push({ mode, name, sha });
    i = nul + 21;
  }
  return out;
}

function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

function buildTreeBytes(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Every path under a tree, flattened: path -> {mode, sha}. */
function flattenTree(repo: Repo, treeSha: string, prefix = '', into = new Map<string, { mode: string; sha: string }>()): Map<string, { mode: string; sha: string }> {
  const obj = readObject(repo, treeSha);
  if (obj === null || obj.type !== 'tree') return into;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.sha, path, into);
    else into.set(path, { mode: entry.mode, sha: entry.sha });
  }
  return into;
}

/** Build (and store) the trees for a flat path map; returns the root tree sha. */
function buildTreeFromFlat(repo: Repo, flat: Map<string, { mode: string; sha: string }>): string {
  const files = new Map<string, { mode: string; sha: string }>();
  const dirs = new Map<string, Map<string, { mode: string; sha: string }>>();
  for (const [path, value] of flat) {
    const slash = path.indexOf('/');
    if (slash < 0) files.set(path, value);
    else {
      const dir = path.slice(0, slash);
      let sub = dirs.get(dir);
      if (sub === undefined) {
        sub = new Map();
        dirs.set(dir, sub);
      }
      sub.set(path.slice(slash + 1), value);
    }
  }
  const entries: TreeEntry[] = [];
  for (const [name, value] of files) entries.push({ mode: value.mode, name, sha: value.sha });
  for (const [name, sub] of dirs) entries.push({ mode: '40000', name, sha: buildTreeFromFlat(repo, sub) });
  return putObject(repo, 'tree', buildTreeBytes(entries));
}

/** A flat map of a commit's tree, or an empty map for an unborn branch. */
function treeOfCommit(repo: Repo, commitSha: string | null): Map<string, { mode: string; sha: string }> {
  if (commitSha === null) return new Map();
  const commit = readObject(repo, commitSha);
  if (commit === null || commit.type !== 'commit') return new Map();
  const parsed = parseCommit(commit.data);
  return flattenTree(repo, parsed.tree);
}

interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  authorMs: number;
  message: string;
  raw: string;
}

function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const lines = head.split('\n');
  let tree = '';
  const parents: string[] = [];
  let author = 'unknown <unknown@example.invalid>';
  let committer = author;
  let authorMs = BASE_MS;
  for (const line of lines) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      author = line.slice(7);
      authorMs = parseIdentityMs(author);
    } else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, authorMs, message, raw: text };
}

function parseIdentityMs(identity: string): number {
  const match = /(\d+)\s+([+-]\d{4})\s*$/.exec(identity);
  if (match === null) return BASE_MS;
  return Number(match[1]) * 1000;
}

function identityOf(identity: string): { name: string; email: string; date: string } {
  const match = /^(.*?)\s*<([^>]*)>\s*(\d+)\s*([+-]\d{4})\s*$/.exec(identity);
  if (match === null) return { name: identity, email: '', date: iso(BASE_MS) };
  return { name: match[1], email: match[2], date: iso(Number(match[3]) * 1000) };
}

function makeCommit(repo: Repo, tree: string, parents: string[], message: string, authorName: string, authorMs: number): string {
  const seconds = Math.floor(authorMs / 1000);
  const identity = `${authorName} <${authorName}@example.invalid> ${seconds} +0000`;
  let text = `tree ${tree}\n`;
  for (const parent of parents) text += `parent ${parent}\n`;
  text += `author ${identity}\ncommitter ${identity}\n\n${message.replace(/\n+$/, '')}\n`;
  return putObject(repo, 'commit', Buffer.from(text, 'utf8'));
}

// ---------------------------------------------------------------- store

interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: number;
  updatedAt: number;
  comments: Comment[];
  rev?: number;
}

interface Comment {
  id: number;
  body: string;
  createdAt: number;
}

interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: number;
}

interface Repo {
  id: number;
  owner: string;
  name: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  createdAt: number;
  objects: Map<string, GitObj>;
  refs: Map<string, string>;
  issues: Issue[];
  labels: Map<string, string>;
  pulls: Pull[];
  nextIssue: number;
  nextPull: number;
  nextComment: number;
}

const repos = new Map<string, Repo>();
let nextRepoId = 1000;
let nextIssueId = 10_000;
let nextPullId = 30_000;
let viewerLogin = '';
let otherLoginSeen = '';

function repoKey(_owner: string, name: string): string {
  return name.toLowerCase();
}

function findRepo(owner: string, name: string): Repo | null {
  if (viewerLogin !== '' && owner.toLowerCase() !== viewerLogin.toLowerCase()) return null;
  return repos.get(repoKey(owner, name)) ?? null;
}

function noteOwner(owner: string): void {
  if (viewerLogin === '') {
    viewerLogin = owner;
    for (const repo of repos.values()) if (repo.owner === '') repo.owner = owner;
    return;
  }
  if (owner.toLowerCase() !== viewerLogin.toLowerCase()) otherLoginSeen = owner;
}

function createRepo(name: string, options: { private?: boolean; description?: string }): Repo {
  const owner = viewerLogin;
  const repo: Repo = {
    id: nextRepoId++,
    owner,
    name,
    private: options.private !== false,
    description: options.description ?? '',
    defaultBranch: 'main',
    createdAt: nowMs(),
    objects: new Map(),
    refs: new Map(),
    issues: [],
    labels: new Map(),
    pulls: [],
    nextIssue: 1,
    nextPull: 1,
    nextComment: 1,
  };
  repos.set(repoKey(owner, name), repo);
  return repo;
}

// ---------------------------------------------------------------- HTTP plumbing

const EMPTY_QUERY = new URLSearchParams('');
const EMPTY_BODY = Buffer.alloc(0);

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  query: URLSearchParams;
  token: string | null;
  body: Buffer;
  json: unknown;
  requestId: string;
}

function requestId(): string {
  tick += 1;
  return `MF-${tick.toString(16).padStart(8, '0')}-${(tick * 2654435761 % 0xffffffff).toString(16)}`;
}

function send(ctx: Ctx, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  const buf = Buffer.from(text, 'utf8');
  const out: Record<string, string> = {
    'content-type': JSON_TYPE,
    'content-length': String(buf.length),
    'x-github-request-id': ctx.requestId,
    ...headers,
  };
  ctx.res.writeHead(status, out);
  ctx.res.end(buf);
}

function sendRaw(ctx: Ctx, status: number, body: Buffer, headers: Record<string, string> = {}): void {
  ctx.res.writeHead(status, {
    'content-length': String(body.length),
    'x-github-request-id': ctx.requestId,
    ...headers,
  });
  ctx.res.end(body);
}

function notFound(ctx: Ctx): void {
  send(ctx, 404, { message: 'Not Found' });
}

function message(ctx: Ctx, status: number, text: string): void {
  send(ctx, status, { message: text });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.concat(chunks)));
  });
}

function tokenOf(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^(?:Bearer|token)\s+(.+)$/i.exec(header.trim());
  return match === null ? null : match[1].trim();
}

function b64(data: Buffer): string {
  return data.toString('base64');
}

function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/\s+/g, ''), 'base64');
}

// ---------------------------------------------------------------- shapes

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner),
    private: repo.private,
    description: repo.description,
    fork: false,
    created_at: iso(repo.createdAt),
    updated_at: iso(repo.createdAt),
    pushed_at: iso(repo.createdAt),
    default_branch: repo.defaultBranch,
    html_url: `/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function userJson(login: string): Record<string, unknown> {
  return {
    login,
    id: 1000 + login.length,
    node_id: `U_${login}`,
    type: 'User',
    site_admin: false,
    url: `/api/v3/users/${login}`,
    html_url: `/${login}`,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ id: 1, name, color: repo.labels.get(name) ?? 'ededed' })),
    user: userJson(repo.owner),
    assignee: null,
    assignees: [],
    comments: issue.comments.length,
    created_at: iso(issue.createdAt),
    updated_at: iso(issue.updatedAt),
    closed_at: issue.state === 'closed' ? iso(issue.updatedAt) : null,
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

const issueBufCache = new WeakMap<Issue, { rev: number; buf: Buffer }>();

function sendIssue(ctx: Ctx, status: number, repo: Repo, issue: Issue): void {
  const rev = issue.rev ?? 0;
  const hit = issueBufCache.get(issue);
  if (hit !== undefined && hit.rev === rev) {
    ctx.res.writeHead(status, {
      'content-type': JSON_TYPE,
      'content-length': String(hit.buf.length),
      'x-github-request-id': ctx.requestId,
    });
    ctx.res.end(hit.buf);
    return;
  }
  const buf = Buffer.from(`${JSON.stringify(issueJson(repo, issue))}\n`, 'utf8');
  issueBufCache.set(issue, { rev, buf });
  ctx.res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': String(buf.length),
    'x-github-request-id': ctx.requestId,
  });
  ctx.res.end(buf);
}

function commentJson(comment: Comment, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `C_${comment.id}`,
    body: comment.body,
    user: userJson(repo.owner),
    created_at: iso(comment.createdAt),
    updated_at: iso(comment.createdAt),
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: `P_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}`, repo: null },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}`, repo: null },
    user: userJson(repo.owner),
    created_at: iso(pull.createdAt),
    updated_at: iso(pull.createdAt),
    html_url: `/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

// ---------------------------------------------------------------- REST: repositories

function listRepos(ctx: Ctx): void {
  const perPage = Math.min(100, Math.max(1, Number(ctx.query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(ctx.query.get('page') ?? '1') || 1);
  const all = [...repos.values()].sort((a, b) => b.createdAt - a.createdAt);
  const start = (page - 1) * perPage;
  const slice = all.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < all.length) {
    const host = ctx.req.headers.host ?? '127.0.0.1';
    headers.link = `<http://${host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}>; rel="next"`;
  }
  send(ctx, 200, slice.map(repoJson), headers);
}

function createRepoRoute(ctx: Ctx): void {
  const body = (ctx.json ?? {}) as Record<string, unknown>;
  const name = typeof body.name === 'string' ? body.name : '';
  if (name === '') return message(ctx, 422, 'Repository creation failed: name is required');
  if (repos.has(repoKey('', name))) return message(ctx, 422, 'Repository creation failed: name already exists on this account');
  const repo = createRepo(name, {
    private: body.private !== false,
    description: typeof body.description === 'string' ? body.description : '',
  });
  send(ctx, 201, repoJson(repo));
}

function repoRoute(ctx: Ctx, owner: string, name: string): void {
  noteOwner(owner);
  const repo = findRepo(owner, name);
  if (repo === null) return notFound(ctx);
  if (ctx.method === 'GET') return send(ctx, 200, repoJson(repo));
  if (ctx.method === 'PATCH') {
    const body = (ctx.json ?? {}) as Record<string, unknown>;
    if (typeof body.description === 'string') repo.description = body.description;
    if (typeof body.private === 'boolean') repo.private = body.private;
    if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
      repos.delete(repoKey(repo.owner, repo.name));
      repo.name = body.name;
      repos.set(repoKey(repo.owner, repo.name), repo);
    }
    return send(ctx, 200, repoJson(repo));
  }
  if (ctx.method === 'DELETE') {
    repos.delete(repoKey(repo.owner, repo.name));
    ctx.res.writeHead(204, { 'x-github-request-id': ctx.requestId });
    ctx.res.end();
    return;
  }
  notFound(ctx);
}

function tipOf(repo: Repo, ref: string): string | null {
  const direct = repo.refs.get(ref.startsWith('refs/') ? ref : `refs/heads/${ref}`);
  if (direct !== undefined) return direct;
  const asBranch = repo.refs.get(`refs/heads/${ref}`);
  return asBranch ?? null;
}

function branchesRoute(ctx: Ctx, repo: Repo, branch: string | null): void {
  if (branch === null) {
    const list = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha, url: '' }, protected: false }));
    return send(ctx, 200, list);
  }
  const sha = repo.refs.get(`refs/heads/${branch}`);
  if (sha === undefined) return notFound(ctx);
  send(ctx, 200, { name: branch, commit: { sha, url: '' }, protected: false });
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> {
  const obj = readObject(repo, sha);
  if (obj === null) return { sha };
  const parsed = parseCommit(obj.data);
  return {
    sha,
    node_id: `C_${sha.slice(0, 8)}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `/${repo.owner}/${repo.name}/commit/${sha}`,
    commit: {
      tree: { sha: parsed.tree },
      author: identityOf(parsed.author),
      committer: identityOf(parsed.committer),
      message: parsed.message.replace(/\n$/, ''),
    },
    parents: parsed.parents.map((parent) => ({ sha: parent })),
  };
}

function walkCommits(repo: Repo, from: string | null, limit = 100): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = from === null ? [] : [from];
  while (queue.length > 0 && out.length < limit) {
    const sha = queue.shift() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = readObject(repo, sha);
    if (obj === null || obj.type !== 'commit') continue;
    out.push(sha);
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return out;
}

function commitsRoute(ctx: Ctx, repo: Repo): void {
  const ref = ctx.query.get('sha') ?? repo.defaultBranch;
  const tip = tipOf(repo, ref);
  if (tip === null) return send(ctx, 200, []);
  const perPage = Math.min(100, Math.max(1, Number(ctx.query.get('per_page') ?? '30') || 30));
  const shas = walkCommits(repo, tip).slice(0, perPage);
  send(ctx, 200, shas.map((sha) => commitJson(repo, sha)));
}

function gitRefsRoute(ctx: Ctx, repo: Repo, rest: string): void {
  if (ctx.method === 'POST') {
    const body = (ctx.json ?? {}) as Record<string, unknown>;
    const ref = typeof body.ref === 'string' ? body.ref : '';
    const sha = typeof body.sha === 'string' ? body.sha : '';
    if (ref === '' || sha === '') return message(ctx, 422, 'ref and sha are required');
    repo.refs.set(ref, sha);
    return send(ctx, 201, { ref, node_id: `R_${ref}`, url: '', object: { sha, type: 'commit', url: '' } });
  }
  if (ctx.method === 'GET') {
    if (rest === '') {
      const list = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha, type: 'commit' } }));
      return send(ctx, 200, list);
    }
    const ref = rest.startsWith('heads/') || rest.startsWith('tags/') ? `refs/${rest}` : rest;
    const sha = repo.refs.get(ref);
    if (sha === undefined) return notFound(ctx);
    return send(ctx, 200, { ref, object: { sha, type: 'commit', url: '' } });
  }
  notFound(ctx);
}

function contentsRoute(ctx: Ctx, repo: Repo, filePath: string): void {
  const ref = ctx.query.get('ref') ?? ctx.query.get('branch') ?? repo.defaultBranch;
  const tip = tipOf(repo, ref);
  const flat = treeOfCommit(repo, tip);
  if (ctx.method === 'GET') {
    if (filePath === '') {
      const list = [...repo.refs.entries()].filter(([r]) => r.startsWith('refs/heads/')).map(([r, sha]) => ({ name: r.slice(11), commit: { sha } }));
      return send(ctx, 200, list);
    }
    const entry = flat.get(filePath);
    if (entry !== undefined) {
      const blob = readObject(repo, entry.sha);
      const data = blob === null ? Buffer.alloc(0) : blob.data;
      return send(ctx, 200, {
        type: 'file',
        name: filePath.slice(filePath.lastIndexOf('/') + 1),
        path: filePath,
        sha: entry.sha,
        size: data.length,
        encoding: 'base64',
        content: b64(data),
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${filePath}`,
        git_url: '',
        html_url: '',
        download_url: null,
      });
    }
    const prefix = `${filePath}/`;
    const children = new Map<string, { mode: string; sha: string }>();
    for (const [path, value] of flat) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      const name = slash < 0 ? rest : rest.slice(0, slash);
      if (!children.has(name)) children.set(name, slash < 0 ? value : { mode: '40000', sha: '' });
    }
    if (children.size === 0) return notFound(ctx);
    const list = [...children.entries()].map(([name, value]) => {
      const childPath = `${filePath}/${name}`;
      if (value.mode === '40000') {
        return { type: 'dir', name, path: childPath, sha: '', size: 0, url: '', html_url: '', git_url: '', download_url: null };
      }
      const blob = readObject(repo, value.sha);
      return {
        type: 'file',
        name,
        path: childPath,
        sha: value.sha,
        size: blob === null ? 0 : blob.data.length,
        url: '',
        html_url: '',
        git_url: '',
        download_url: null,
      };
    });
    return send(ctx, 200, list);
  }
  if (ctx.method === 'PUT') {
    const body = (ctx.json ?? {}) as Record<string, unknown>;
    const commitMessage = typeof body.message === 'string' ? body.message : 'commit';
    const content = typeof body.content === 'string' ? b64decode(body.content) : Buffer.alloc(0);
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const branchTip = tipOf(repo, branch);
    const current = treeOfCommit(repo, branchTip);
    const existing = current.get(filePath);
    const providedSha = typeof body.sha === 'string' ? body.sha.toLowerCase() : '';
    if (providedSha !== '' && existing !== undefined && existing.sha.toLowerCase() !== providedSha) {
      return message(ctx, 409, 'sha does not match the current content');
    }
    if (providedSha === '' && existing !== undefined) {
      return message(ctx, 422, 'Invalid request: sha is required to update an existing file');
    }
    const blobSha = putObject(repo, 'blob', content);
    const next = new Map(current);
    next.set(filePath, { mode: '100644', sha: blobSha });
    const treeSha = buildTreeFromFlat(repo, next);
    const commitSha = makeCommit(repo, treeSha, branchTip === null ? [] : [branchTip], commitMessage, viewerLogin || repo.owner, nowMs());
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    if (branchTip === null) repo.defaultBranch = branch;
    return send(ctx, existing === undefined ? 201 : 200, {
      content: { name: filePath.slice(filePath.lastIndexOf('/') + 1), path: filePath, sha: blobSha, size: content.length, encoding: 'base64', url: '', html_url: '', git_url: '' },
      commit: commitJson(repo, commitSha),
    });
  }
  if (ctx.method === 'DELETE') {
    const body = (ctx.json ?? {}) as Record<string, unknown>;
    const commitMessage = typeof body.message === 'string' ? body.message : 'commit';
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const branchTip = tipOf(repo, branch);
    const current = treeOfCommit(repo, branchTip);
    if (!current.has(filePath)) return notFound(ctx);
    const next = new Map(current);
    next.delete(filePath);
    const treeSha = buildTreeFromFlat(repo, next);
    const commitSha = makeCommit(repo, treeSha, branchTip === null ? [] : [branchTip], commitMessage, viewerLogin || repo.owner, nowMs());
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return send(ctx, 200, { content: null, commit: commitJson(repo, commitSha) });
  }
  notFound(ctx);
}

// ---------------------------------------------------------------- REST: labels, issues, comments

function labelsRoute(ctx: Ctx, repo: Repo): void {
  if (ctx.method === 'POST') {
    const body = (ctx.json ?? {}) as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name : '';
    if (name === '') return message(ctx, 422, 'name is required');
    const color = typeof body.color === 'string' ? body.color : 'ededed';
    repo.labels.set(name, color);
    return send(ctx, 201, { id: repo.labels.size, name, color, description: null, url: '' });
  }
  if (ctx.method === 'GET') {
    return send(ctx, 200, [...repo.labels.entries()].map(([name, color]) => ({ id: 1, name, color })));
  }
  notFound(ctx);
}

function issuesRoute(ctx: Ctx, repo: Repo): void {
  if (ctx.method === 'POST') {
    const body = (ctx.json ?? {}) as Record<string, unknown>;
    const title = typeof body.title === 'string' ? body.title : '';
    const text = typeof body.body === 'string' ? body.body : '';
    const labels = Array.isArray(body.labels) ? body.labels.filter((label): label is string => typeof label === 'string') : [];
    for (const label of labels) {
      if (!repo.labels.has(label)) return message(ctx, 422, `Validation Failed: label ${label} does not exist`);
    }
    const stamp = nowMs();
    const issue: Issue = {
      id: nextIssueId++,
      number: repo.nextIssue,
      title,
      body: text,
      state: 'open',
      labels,
      createdAt: stamp,
      updatedAt: stamp,
      comments: [],
    };
    repo.nextIssue += 1;
    repo.issues.push(issue);
    return send(ctx, 201, issueJson(repo, issue));
  }
  if (ctx.method === 'GET') {
    const state = ctx.query.get('state') ?? 'open';
    const sort = ctx.query.get('sort') ?? 'created';
    const direction = ctx.query.get('direction') ?? 'desc';
    const perPage = Math.min(100, Math.max(1, Number(ctx.query.get('per_page') ?? '30') || 30));
    let list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
    list = [...list].sort((a, b) => {
      const key = sort === 'updated' ? 'updatedAt' : 'createdAt';
      const delta = (a[key] as number) - (b[key] as number);
      return direction === 'asc' ? delta : -delta;
    });
    return send(ctx, 200, list.slice(0, perPage).map((issue) => issueJson(repo, issue)));
  }
  notFound(ctx);
}

function issueRoute(ctx: Ctx, repo: Repo, numberText: string): void {
  const number = Number(numberText);
  const issue = repo.issues.find((entry) => entry.number === number);
  if (issue === undefined) return notFound(ctx);
  if (ctx.method === 'GET') return sendIssue(ctx, 200, repo, issue);
  if (ctx.method === 'PATCH') {
    const body = (ctx.json ?? {}) as Record<string, unknown>;
    if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) issue.state = body.state;
    if (typeof body.title === 'string') issue.title = body.title;
    if (typeof body.body === 'string') issue.body = body.body;
    if (Array.isArray(body.labels)) {
      const labels = body.labels.filter((label): label is string => typeof label === 'string');
      for (const label of labels) if (!repo.labels.has(label)) return message(ctx, 422, `Validation Failed: label ${label} does not exist`);
      issue.labels = labels;
    }
    issue.updatedAt = nowMs();
    issue.rev = (issue.rev ?? 0) + 1;
    return send(ctx, 200, issueJson(repo, issue));
  }
  notFound(ctx);
}

function commentsRoute(ctx: Ctx, repo: Repo, numberText: string): void {
  const number = Number(numberText);
  const issue = repo.issues.find((entry) => entry.number === number);
  if (issue === undefined) return notFound(ctx);
  if (ctx.method === 'POST') {
    const body = (ctx.json ?? {}) as Record<string, unknown>;
    const text = typeof body.body === 'string' ? body.body : '';
    const comment: Comment = { id: 20_000 + repo.nextComment, body: text, createdAt: nowMs() };
    repo.nextComment += 1;
    issue.comments.push(comment);
    issue.updatedAt = comment.createdAt;
    issue.rev = (issue.rev ?? 0) + 1;
    return send(ctx, 201, commentJson(comment, repo, issue));
  }
  if (ctx.method === 'GET') {
    return send(ctx, 200, issue.comments.map((comment) => commentJson(comment, repo, issue)));
  }
  notFound(ctx);
}

// ---------------------------------------------------------------- REST: pull requests

function pullFileDiff(repo: Repo, baseSha: string, headSha: string): Record<string, unknown>[] {
  const base = treeOfCommit(repo, baseSha);
  const head = treeOfCommit(repo, headSha);
  const out: Record<string, unknown>[] = [];
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const before = base.get(path);
    const after = head.get(path);
    if (before !== undefined && after !== undefined && before.sha === after.sha) continue;
    const beforeText = before === undefined ? '' : (readObject(repo, before.sha)?.data.toString('utf8') ?? '');
    const afterText = after === undefined ? '' : (readObject(repo, after.sha)?.data.toString('utf8') ?? '');
    const beforeLines = beforeText === '' ? 0 : beforeText.replace(/\n$/, '').split('\n').length;
    const afterLines = afterText === '' ? 0 : afterText.replace(/\n$/, '').split('\n').length;
    const status = before === undefined ? 'added' : after === undefined ? 'removed' : 'modified';
    out.push({
      sha: after?.sha ?? before?.sha ?? '',
      filename: path,
      status,
      additions: after === undefined ? 0 : Math.max(1, afterLines),
      deletions: before === undefined ? 0 : beforeLines,
      changes: (after === undefined ? 0 : Math.max(1, afterLines)) + (before === undefined ? 0 : beforeLines),
      blob_url: '',
      raw_url: '',
      contents_url: '',
      patch: '',
    });
  }
  return out;
}

function pullsRoute(ctx: Ctx, repo: Repo): void {
  if (ctx.method === 'POST') {
    const body = (ctx.json ?? {}) as Record<string, unknown>;
    const headRef = typeof body.head === 'string' ? body.head : '';
    const baseRef = typeof body.base === 'string' ? body.base : repo.defaultBranch;
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (headSha === undefined) return message(ctx, 422, `Validation Failed: head ${headRef} does not exist`);
    if (baseSha === undefined) return message(ctx, 422, `Validation Failed: base ${baseRef} does not exist`);
    const pull: Pull = {
      id: nextPullId++,
      number: repo.nextPull,
      title: typeof body.title === 'string' ? body.title : '',
      body: typeof body.body === 'string' ? body.body : '',
      state: 'open',
      headRef,
      headSha,
      baseRef,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdAt: nowMs(),
    };
    repo.nextPull += 1;
    repo.pulls.push(pull);
    return send(ctx, 201, pullJson(repo, pull));
  }
  if (ctx.method === 'GET') {
    const state = ctx.query.get('state') ?? 'open';
    const perPage = Math.min(100, Math.max(1, Number(ctx.query.get('per_page') ?? '30') || 30));
    const list = repo.pulls.filter((pull) => (state === 'all' ? true : pull.state === state));
    return send(ctx, 200, list.slice(0, perPage).map((pull) => pullJson(repo, pull)));
  }
  notFound(ctx);
}

function pullRoute(ctx: Ctx, repo: Repo, numberText: string, sub: string): void {
  const number = Number(numberText);
  const pull = repo.pulls.find((entry) => entry.number === number);
  if (pull === undefined) return notFound(ctx);
  if (sub === '') {
    if (ctx.method !== 'GET') return notFound(ctx);
    return send(ctx, 200, pullJson(repo, pull));
  }
  if (sub === 'files') {
    return send(ctx, 200, pullFileDiff(repo, pull.baseSha, pull.headSha));
  }
  if (sub === 'merge') {
    if (ctx.method !== 'PUT' && ctx.method !== 'POST') return notFound(ctx);
    const tip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? null;
    if (tip === null) return message(ctx, 404, 'Base branch not found');
    if (pull.state === 'closed' && pull.merged) return message(ctx, 405, 'Pull Request is already merged');
    if (tip !== pull.baseSha) return message(ctx, 405, 'Pull Request is not mergeable');
    const headCommit = readObject(repo, pull.headSha);
    if (headCommit === null) return message(ctx, 405, 'Pull Request head is missing');
    const headTree = parseCommit(headCommit.data).tree;
    const mergeSha = makeCommit(repo, headTree, [tip], `Merge pull request #${pull.number} from ${pull.headRef}`, viewerLogin || repo.owner, nowMs());
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = iso(nowMs());
    pull.mergeCommitSha = mergeSha;
    return send(ctx, 200, { sha: mergeSha, merged: true, message: 'Pull Request successfully merged' });
  }
  notFound(ctx);
}

// ---------------------------------------------------------------- REST router

function restRoute(ctx: Ctx): void {
  const path = ctx.path;
  if (path === '/api/v3' || path === '/api/v3/') {
    return send(ctx, 200, {
      current_user_url: '/api/v3/user',
      current_user_authorizations_html_url: '/settings/connections/applications{/client_id}',
      authorizations_url: '/api/v3/authorizations',
      repositories_url: '/api/v3/user/repos',
      rate_limit_url: '/api/v3/rate_limit',
      user_url: '/api/v3/users/{user}',
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (path === '/api/v3/meta') {
    return send(ctx, 200, { installed_version: '3.0.0-forge', verifiable_password_authentication: false, ssh_key_fingerprints: {}, hooks: [], web: [], api: [] });
  }
  if (ctx.token === null) return message(ctx, 401, 'Requires authentication');
  if (path === '/api/v3/user') {
    return send(ctx, 200, userJson(viewerLogin === '' ? 'viewer' : viewerLogin));
  }
  if (path === '/api/v3/user/repos') {
    if (ctx.method === 'GET') return listRepos(ctx);
    if (ctx.method === 'POST') return createRepoRoute(ctx);
    return notFound(ctx);
  }
  const rest = path.slice('/api/v3'.length);
  const parts = rest.split('/').filter((part) => part !== '');
  if (parts[0] !== 'repos' || parts.length < 3) return notFound(ctx);
  const owner = decodeURIComponent(parts[1]);
  const name = decodeURIComponent(parts[2]);
  noteOwner(owner);
  const repo = findRepo(owner, name);
  if (repo === null) return notFound(ctx);
  const tail = parts.slice(3).map((part) => decodeURIComponent(part));
  if (tail.length === 0) return repoRoute(ctx, owner, name);
  switch (tail[0]) {
    case 'branches':
      return branchesRoute(ctx, repo, tail.length > 1 ? tail.slice(1).join('/') : null);
    case 'commits':
      return commitsRoute(ctx, repo);
    case 'git':
      if (tail[1] === 'refs') return gitRefsRoute(ctx, repo, tail.slice(2).join('/'));
      return notFound(ctx);
    case 'contents': {
      const filePath = tail.slice(1).join('/');
      return contentsRoute(ctx, repo, filePath);
    }
    case 'labels':
      return labelsRoute(ctx, repo);
    case 'issues': {
      if (tail.length === 1) return issuesRoute(ctx, repo);
      if (tail.length === 2) return issueRoute(ctx, repo, tail[1]);
      if (tail.length === 3 && tail[2] === 'comments') return commentsRoute(ctx, repo, tail[1]);
      return notFound(ctx);
    }
    case 'pulls': {
      if (tail.length === 1) return pullsRoute(ctx, repo);
      if (tail.length === 2) return pullRoute(ctx, repo, tail[1], '');
      if (tail.length === 3) return pullRoute(ctx, repo, tail[1], tail[2]);
      return notFound(ctx);
    }
    default:
      return notFound(ctx);
  }
}

// ---------------------------------------------------------------- MCP (streamable HTTP, legacy era)

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const MCP_TOOLS: readonly McpToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated account.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Open an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch.' },
        base: { type: 'string', description: 'The base branch.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'get_pull_request',
    description: 'Read one pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
]);

const MCP_TOOLS_JSON = JSON.stringify(MCP_TOOLS);

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolError(text: string): Record<string, unknown> {
  return { content: [{ type: 'text', text }], isError: true };
}

function argString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

function callTool(name: string, args: Record<string, unknown>): { result?: Record<string, unknown>; error?: { code: number; message: string } } {
  const owner = argString(args, 'owner') || viewerLogin;
  const repoName = argString(args, 'repo');
  const find = (): Repo | null => {
    if (repoName === '') return null;
    return findRepo(owner, repoName);
  };
  switch (name) {
    case 'create_repo': {
      const repoNameArg = argString(args, 'name');
      if (repoNameArg === '') return { error: { code: -32602, message: 'name is required' } };
      if (repos.has(repoKey('', repoNameArg))) return { error: { code: -32602, message: `repository ${repoNameArg} already exists` } };
      const repo = createRepo(repoNameArg, {
        private: args.private !== false,
        description: typeof args.description === 'string' ? args.description : '',
      });
      return { result: toolResult(repoJson(repo)) };
    }
    case 'get_repo': {
      const repo = find();
      if (repo === null) return { error: { code: -32602, message: `repository ${owner}/${repoName} not found` } };
      return { result: toolResult(repoJson(repo)) };
    }
    case 'create_issue': {
      const repo = find();
      if (repo === null) return { error: { code: -32602, message: `repository ${owner}/${repoName} not found` } };
      const title = argString(args, 'title');
      if (title === '') return { error: { code: -32602, message: 'title is required' } };
      const stamp = nowMs();
      const issue: Issue = {
        id: 10_000 + repo.nextIssue,
        number: repo.nextIssue,
        title,
        body: argString(args, 'body'),
        state: 'open',
        labels: [],
        createdAt: stamp,
        updatedAt: stamp,
        comments: [],
      };
      repo.nextIssue += 1;
      repo.issues.push(issue);
      return { result: toolResult(issueJson(repo, issue)) };
    }
    case 'list_issues': {
      const repo = find();
      if (repo === null) return { error: { code: -32602, message: `repository ${owner}/${repoName} not found` } };
      const state = argString(args, 'state') || 'open';
      const list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      return { result: toolResult(list.map((issue) => issueJson(repo, issue))) };
    }
    case 'create_pull_request': {
      const repo = find();
      if (repo === null) return { error: { code: -32602, message: `repository ${owner}/${repoName} not found` } };
      const head = argString(args, 'head');
      const base = argString(args, 'base') || repo.defaultBranch;
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined) return { error: { code: -32602, message: `head branch ${head} does not exist` } };
      if (baseSha === undefined) return { error: { code: -32602, message: `base branch ${base} does not exist` } };
      const pull: Pull = {
        id: nextPullId++,
        number: repo.nextPull,
        title: argString(args, 'title'),
        body: argString(args, 'body'),
        state: 'open',
        headRef: head,
        headSha,
        baseRef: base,
        baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        createdAt: nowMs(),
      };
      repo.nextPull += 1;
      repo.pulls.push(pull);
      return { result: toolResult(pullJson(repo, pull)) };
    }
    case 'merge_pull_request': {
      const repo = find();
      if (repo === null) return { error: { code: -32602, message: `repository ${owner}/${repoName} not found` } };
      const number = Number(args.pull_number);
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (pull === undefined) return { error: { code: -32602, message: `pull request ${number} not found` } };
      const tip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? null;
      if (tip === null) return { error: { code: -32602, message: 'base branch not found' } };
      if (tip !== pull.baseSha) return { error: { code: -32602, message: 'pull request is not mergeable' } };
      const headCommit = readObject(repo, pull.headSha);
      if (headCommit === null) return { error: { code: -32602, message: 'pull request head is missing' } };
      const headTree = parseCommit(headCommit.data).tree;
      const mergeSha = makeCommit(repo, headTree, [tip], `Merge pull request #${pull.number} from ${pull.headRef}`, viewerLogin || repo.owner, nowMs());
      repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = iso(nowMs());
      pull.mergeCommitSha = mergeSha;
      return { result: toolResult({ sha: mergeSha, merged: true, message: 'Pull Request successfully merged' }) };
    }
    case 'get_pull_request': {
      const repo = find();
      if (repo === null) return { error: { code: -32602, message: `repository ${owner}/${repoName} not found` } };
      const pull = repo.pulls.find((entry) => entry.number === Number(args.pull_number));
      if (pull === undefined) return { error: { code: -32602, message: 'pull request not found' } };
      return { result: toolResult(pullJson(repo, pull)) };
    }
    case 'list_pull_requests': {
      const repo = find();
      if (repo === null) return { error: { code: -32602, message: `repository ${owner}/${repoName} not found` } };
      const state = argString(args, 'state') || 'open';
      const list = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
      return { result: toolResult(list.map((pull) => pullJson(repo, pull))) };
    }
    default:
      return { error: { code: -32602, message: `unknown tool ${name}` } };
  }
}

function mcpReply(ctx: Ctx, status: number, payload: unknown): void {
  send(ctx, status, payload);
}

function mcpRoute(ctx: Ctx): void {
  if (ctx.token === null) return message(ctx, 401, 'Requires authentication');
  if (ctx.method === 'DELETE') {
    ctx.res.writeHead(200, { 'x-github-request-id': ctx.requestId });
    ctx.res.end();
    return;
  }
  if (ctx.method !== 'POST') {
    ctx.res.writeHead(405, { allow: 'POST', 'x-github-request-id': ctx.requestId });
    ctx.res.end();
    return;
  }
  let message_: Record<string, unknown>;
  try {
    const parsed = JSON.parse(ctx.body.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    message_ = parsed as Record<string, unknown>;
  } catch {
    return mcpReply(ctx, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  const id = message_.id ?? null;
  const method = typeof message_.method === 'string' ? message_.method : '';
  const params = (typeof message_.params === 'object' && message_.params !== null ? message_.params : {}) as Record<string, unknown>;
  const isNotification = message_.id === undefined;
  if (isNotification) {
    ctx.res.writeHead(202, { 'x-github-request-id': ctx.requestId });
    ctx.res.end();
    return;
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18';
    return mcpReply(ctx, 200, {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: offered,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'makeforge', version: '1.0.0' },
        instructions: 'A GitHub-compatible forge: repositories, issues and pull requests.',
      },
    });
  }
  if (method === 'tools/list') {
    return mcpReply(ctx, 200, { jsonrpc: '2.0', id, result: { tools: JSON.parse(MCP_TOOLS_JSON) } });
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
    const outcome = callTool(name, args);
    if (outcome.error !== undefined) return mcpReply(ctx, 200, { jsonrpc: '2.0', id, error: outcome.error });
    return mcpReply(ctx, 200, { jsonrpc: '2.0', id, result: outcome.result ?? toolError('no result') });
  }
  if (method === 'ping') return mcpReply(ctx, 200, { jsonrpc: '2.0', id, result: {} });
  mcpReply(ctx, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
}

// ---------------------------------------------------------------- git smart HTTP

const ZERO = '0000000000000000000000000000000000000000';

function pktLine(text: string | Buffer): Buffer {
  const payload = typeof text === 'string' ? Buffer.from(text, 'utf8') : text;
  const header = Buffer.from((payload.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, payload]);
}

const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

interface Pkt {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
}

/** Parse pkt-lines; `rest` is whatever follows the first flush (a receive-pack packfile). */
function readPktLines(buf: Buffer): { packets: Pkt[]; rest: Buffer } {
  const packets: Pkt[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const header = buf.toString('ascii', i, i + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      i += 4;
      return { packets, rest: buf.subarray(i) };
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      i += 4;
      continue;
    }
    if (length < 4 || i + length > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(i + 4, i + length) });
    i += length;
  }
  return { packets, rest: buf.subarray(i) };
}

function gitAdvert(ctx: Ctx, service: 'git-upload-pack' | 'git-receive-pack', body: Buffer): void {
  ctx.res.writeHead(200, {
    'content-type': `application/x-${service}-advertisement`,
    'cache-control': 'no-cache',
    'content-length': String(body.length),
    'x-github-request-id': ctx.requestId,
  });
  ctx.res.end(body);
}

function gitResult(ctx: Ctx, service: 'git-upload-pack' | 'git-receive-pack', body: Buffer): void {
  ctx.res.writeHead(200, {
    'content-type': `application/x-${service}-result`,
    'cache-control': 'no-cache',
    'content-length': String(body.length),
    'x-github-request-id': ctx.requestId,
  });
  ctx.res.end(body);
}

function refList(repo: Repo): Array<{ name: string; sha: string }> {
  const out: Array<{ name: string; sha: string }> = [];
  for (const [name, sha] of repo.refs) out.push({ name, sha });
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

function peelOf(repo: Repo, sha: string): string | null {
  const obj = readObject(repo, sha);
  if (obj === null || obj.type !== 'tag') return null;
  const text = obj.data.toString('utf8');
  const match = /^object ([0-9a-f]{40})$/m.exec(text);
  return match === null ? null : match[1];
}

function uploadPackV0Advertisement(repo: Repo): Buffer {
  const caps = 'multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag multi_ack_detailed allow-tip-sha1-in-want allow-reachable-sha1-in-want no-done symref=HEAD:refs/heads/' + repo.defaultBranch + ' agent=makeforge/1.0';
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), PKT_FLUSH];
  const refs = refList(repo);
  const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  let first = true;
  if (head !== undefined) {
    parts.push(pktLine(`${head} HEAD\0${caps}\n`));
    first = false;
  }
  for (const ref of refs) {
    parts.push(pktLine(first ? `${ref.sha} ${ref.name}\0${caps}\n` : `${ref.sha} ${ref.name}\n`));
    first = false;
  }
  if (first) parts.push(pktLine(`${ZERO} capabilities^{}\0${caps}\n`));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function uploadPackV2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    PKT_FLUSH,
    pktLine('version 2\n'),
    pktLine('agent=makeforge/1.0\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('server-option\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}

function receivePackAdvertisement(repo: Repo): Buffer {
  const caps = 'report-status report-status-v2 delete-refs side-band-64k quiet ofs-delta agent=makeforge/1.0';
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), PKT_FLUSH];
  const refs = refList(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    for (const ref of refs) {
      parts.push(pktLine(first ? `${ref.sha} ${ref.name}\0${caps}\n` : `${ref.sha} ${ref.name}\n`));
      first = false;
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Encode one pack entry header (type + size varint). */
function packEntryHeader(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let rest = size;
  let first = (type << 4) | (rest & 0x0f);
  rest = Math.floor(rest / 16);
  while (rest > 0) {
    bytes.push(first | 0x80);
    first = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

const TYPE_NUMBER: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

const deflated = new Map<string, Buffer>();

function buildPack(repo: Repo, ids: readonly string[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(ids.length, 8);
  const chunks: Buffer[] = [header];
  for (const id of ids) {
    const obj = readObject(repo, id);
    if (obj === null) continue;
    chunks.push(packEntryHeader(TYPE_NUMBER[obj.type], obj.data.length));
    let packed = deflated.get(id);
    if (packed === undefined) {
      packed = deflateSync(obj.data);
      if (deflated.size < 20_000) deflated.set(id, packed);
    }
    chunks.push(packed);
  }
  const body = Buffer.concat(chunks);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Inflate one zlib stream at `start`, returning the bytes and the first offset past it. */
function inflateAt(buf: Buffer, start: number): { data: Buffer; end: number } {
  const result = inflateSync(buf.subarray(start), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: result.buffer, end: start + result.engine.bytesWritten };
}

/** Read a packfile's plain objects (the client sends no deltas). */
function readPack(buf: Buffer): Map<string, GitObj> {
  const objects = new Map<string, GitObj>();
  if (buf.length < 32 || buf.toString('ascii', 0, 4) !== 'PACK') return objects;
  const count = buf.readUInt32BE(8);
  let offset = 12;
  const end = buf.length - 20;
  for (let index = 0; index < count; index += 1) {
    if (offset >= end) break;
    let byte = buf[offset];
    offset += 1;
    const type = (byte >> 4) & 7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[offset];
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const inflated = inflateAt(buf, offset);
    offset = inflated.end;
    if (type < 1 || type > 4) continue;
    const kind: ObjType = type === 1 ? 'commit' : type === 2 ? 'tree' : type === 3 ? 'blob' : 'tag';
    const data = inflated.data;
    objects.set(objectId(kind, data), { type: kind, data });
  }
  return objects;
}

/** Every object reachable from `wants`, stopping at `haves` (and at `depth` commits when shallow). */
function reachableClosure(repo: Repo, starts: Iterable<string>, boundaries: ReadonlySet<string> = new Set()): Set<string> {
  const out = new Set<string>();
  const stack = [...starts];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (out.has(sha)) continue;
    const obj = readObject(repo, sha);
    if (obj === null) continue;
    out.add(sha);
    if (obj.type === 'commit') {
      const parsed = parseCommit(obj.data);
      stack.push(parsed.tree);
      // A shallow boundary hides its parents from the client.
      if (!boundaries.has(sha)) for (const parent of parsed.parents) stack.push(parent);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.sha);
    } else if (obj.type === 'tag') {
      const peeled = peelOf(repo, sha);
      if (peeled !== null) stack.push(peeled);
    }
  }
  return out;
}

/** Objects to send for `wants`, skipping everything already reachable from `haves`. */
function fetchClosure(repo: Repo, wants: readonly string[], haves: ReadonlySet<string>, depth: number | null, boundaries: readonly string[]): { ids: string[]; shallow: string[]; unshallow: string[] } {
  const held = reachableClosure(repo, haves, new Set(boundaries));
  const ids = new Set<string>();
  const shallow: string[] = [];
  const unshallow: string[] = [];
  const seen = new Set<string>();
  const queue: Array<{ sha: string; level: number }> = [];
  const addTree = (root: string): void => {
    const stack = [root];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (cur === '' || ids.has(cur)) continue;
      const obj = readObject(repo, cur);
      if (obj === null) continue;
      if (obj.type === 'tree') {
        ids.add(cur);
        for (const entry of parseTree(obj.data)) stack.push(entry.sha);
      } else if (obj.type === 'blob') ids.add(cur);
    }
  };
  for (const want of wants) {
    const obj = readObject(repo, want);
    if (obj === null) continue;
    if (obj.type === 'tag') {
      if (!held.has(want)) ids.add(want);
      const peeled = peelOf(repo, want);
      if (peeled !== null) queue.push({ sha: peeled, level: 0 });
      continue;
    }
    if (obj.type === 'commit') queue.push({ sha: want, level: 0 });
    else if (!held.has(want)) ids.add(want);
  }
  while (queue.length > 0) {
    const item = queue.shift() as { sha: string; level: number };
    if (seen.has(item.sha)) continue;
    const obj = readObject(repo, item.sha);
    if (obj === null || obj.type !== 'commit') continue;
    seen.add(item.sha);
    const parsed = parseCommit(obj.data);
    const atBoundary = depth !== null && item.level + 1 >= depth;
    if (!held.has(item.sha)) {
      ids.add(item.sha);
      addTree(parsed.tree);
    }
    if (atBoundary) {
      if (parsed.parents.length > 0) shallow.push(item.sha);
      continue;
    }
    for (const parent of parsed.parents) {
      if (depth === null && held.has(parent)) continue;
      queue.push({ sha: parent, level: item.level + 1 });
    }
  }
  for (const boundary of boundaries) {
    if (shallow.includes(boundary)) continue;
    const obj = readObject(repo, boundary);
    if (obj === null || obj.type !== 'commit') continue;
    const parsed = parseCommit(obj.data);
    if (parsed.parents.length > 0 && parsed.parents.every((parent) => ids.has(parent))) unshallow.push(boundary);
  }
  for (const sha of held) ids.delete(sha);
  return { ids: [...ids], shallow, unshallow };
}

function sideband(data: Buffer, band = 1): Buffer {
  const chunks: Buffer[] = [];
  const max = 65_500;
  for (let offset = 0; offset < data.length; offset += max) {
    const slice = data.subarray(offset, Math.min(data.length, offset + max));
    chunks.push(pktLine(Buffer.concat([Buffer.from([band]), slice])));
  }
  return Buffer.concat(chunks);
}

function handleLsRefs(repo: Repo, args: readonly string[]): Buffer {
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const lines: Buffer[] = [];
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (head !== undefined && matches('HEAD')) {
    const suffix = symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
    lines.push(pktLine(`${head} HEAD${suffix}\n`));
  }
  for (const ref of refList(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.sha} ${ref.name}`;
    if (peel) {
      const peeled = peelOf(repo, ref.sha);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(pktLine(`${line}\n`));
  }
  lines.push(PKT_FLUSH);
  return Buffer.concat(lines);
}

function handleFetchV2(repo: Repo, args: readonly string[]): Buffer {
  const wants: string[] = [];
  const haves = new Set<string>();
  const boundaries: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.add(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) boundaries.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) depth = Number(arg.slice(7).trim()) || null;
  }
  const parts: Buffer[] = [pktLine('acknowledgments\n')];
  if (wants.length === 0) {
    parts.push(pktLine('NAK\n'), PKT_FLUSH);
    return Buffer.concat(parts);
  }
  parts.push(pktLine('NAK\n'), PKT_DELIM);
  const { ids, shallow, unshallow } = fetchClosure(repo, wants, haves, depth, boundaries);
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const sha of shallow) parts.push(pktLine(`shallow ${sha}\n`));
    for (const sha of unshallow) parts.push(pktLine(`unshallow ${sha}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sideband(buildPack(repo, ids)));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function handleFetchV0(repo: Repo, packets: readonly Pkt[]): Buffer {
  const wants: string[] = [];
  const haves = new Set<string>();
  const boundaries: string[] = [];
  let depth: number | null = null;
  let sidebandWanted = false;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8');
    if (line.startsWith('want ')) {
      wants.push(line.slice(5, 45));
      if (line.includes('side-band-64k')) sidebandWanted = true;
    } else if (line.startsWith('have ')) haves.add(line.slice(5, 45));
    else if (line.startsWith('shallow ')) boundaries.push(line.slice(8, 48));
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim()) || null;
  }
  const { ids, shallow, unshallow } = fetchClosure(repo, wants, haves, depth, boundaries);
  const parts: Buffer[] = [];
  for (const sha of shallow) parts.push(pktLine(`shallow ${sha}\n`));
  for (const sha of unshallow) parts.push(pktLine(`unshallow ${sha}\n`));
  parts.push(pktLine('NAK\n'));
  parts.push(sidebandWanted ? sideband(buildPack(repo, ids)) : buildPack(repo, ids));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = readObject(repo, sha);
    if (obj === null || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (parent === ancestor) return true;
      stack.push(parent);
    }
  }
  return false;
}

function applyReceivePack(repo: Repo, commands: Array<{ oldOid: string; newOid: string; ref: string }>, pack: Map<string, GitObj>, sidebandWanted: boolean): Buffer {
  for (const [oid, obj] of pack) repo.objects.set(oid, obj);
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? ZERO;
    if (command.oldOid !== ZERO && command.oldOid !== current) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (command.newOid === ZERO) {
      if (current === ZERO) {
        results.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
        continue;
      }
      repo.refs.delete(command.ref);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'missing object' });
      continue;
    }
    if (current !== ZERO && !isAncestor(repo, current, command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    if (command.ref.startsWith('refs/heads/')) {
      const branch = command.ref.slice('refs/heads/'.length);
      if (!repo.refs.has(`refs/heads/${repo.defaultBranch}`)) repo.defaultBranch = branch;
    }
    results.push({ ref: command.ref, ok: true, reason: '' });
  }
  const report: Buffer[] = [pktLine('unpack ok\n')];
  for (const result of results) {
    report.push(result.ok ? pktLine(`ok ${result.ref}\n`) : pktLine(`ng ${result.ref} ${result.reason}\n`));
  }
  report.push(PKT_FLUSH);
  const body = Buffer.concat(report);
  return sidebandWanted ? Buffer.concat([sideband(body), PKT_FLUSH]) : body;
}

const uploadPackCache = new Map<string, Buffer>();

function cacheUpload(key: string, body: Buffer): Buffer {
  if (uploadPackCache.size >= 128) uploadPackCache.clear();
  uploadPackCache.set(key, body);
  return body;
}

function gitRoute(ctx: Ctx, owner: string, repoName: string, service: string, action: string): void {
  noteOwner(owner);
  const repo = findRepo(owner, repoName);
  if (repo === null) {
    return message(ctx, 404, 'Not Found');
  }
  if (action === 'info/refs') {
    const requested = ctx.query.get('service') ?? '';
    if (requested === 'git-upload-pack') {
      const wantsV2 = (ctx.req.headers['git-protocol'] ?? '').toString().includes('version=2');
      return gitAdvert(ctx, 'git-upload-pack', wantsV2 ? uploadPackV2Advertisement() : uploadPackV0Advertisement(repo));
    }
    if (requested === 'git-receive-pack') {
      return gitAdvert(ctx, 'git-receive-pack', receivePackAdvertisement(repo));
    }
    return message(ctx, 403, 'Smart HTTP is the only protocol');
  }
  if (service === 'git-upload-pack' && action === 'git-upload-pack') {
    const uploadKey = `${repo.owner}/${repo.name}:${sha1(ctx.body)}`;
    const cachedUpload = uploadPackCache.get(uploadKey);
    if (cachedUpload !== undefined) return gitResult(ctx, 'git-upload-pack', cachedUpload);
    const parsed = readPktLines(ctx.body);
    const first = parsed.packets.find((packet) => packet.kind === 'data');
    const firstLine = first === undefined ? '' : first.payload.toString('utf8');
    if (firstLine.startsWith('command=ls-refs')) {
      const args: string[] = [];
      let afterDelim = false;
      for (const packet of parsed.packets) {
        if (packet.kind === 'delim') {
          afterDelim = true;
          continue;
        }
        if (packet.kind !== 'data') continue;
        const line = packet.payload.toString('utf8').replace(/\n$/, '');
        if (afterDelim) args.push(line);
      }
      return gitResult(ctx, 'git-upload-pack', cacheUpload(uploadKey, handleLsRefs(repo, args)));
    }
    if (firstLine.startsWith('command=fetch')) {
      const args: string[] = [];
      let afterDelim = false;
      for (const packet of parsed.packets) {
        if (packet.kind === 'delim') {
          afterDelim = true;
          continue;
        }
        if (packet.kind !== 'data') continue;
        const line = packet.payload.toString('utf8').replace(/\n$/, '');
        if (afterDelim) args.push(line);
      }
      return gitResult(ctx, 'git-upload-pack', cacheUpload(uploadKey, handleFetchV2(repo, args)));
    }
    return gitResult(ctx, 'git-upload-pack', cacheUpload(uploadKey, handleFetchV0(repo, parsed.packets)));
  }
  if (service === 'git-receive-pack' && action === 'git-receive-pack') {
    const parsed = readPktLines(ctx.body);
    const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
    let sidebandWanted = false;
    let index = 0;
    for (const packet of parsed.packets) {
      if (packet.kind !== 'data') continue;
      let line = packet.payload.toString('utf8');
      if (index === 0) {
        const nul = line.indexOf('\0');
        if (nul >= 0) {
          sidebandWanted = line.slice(nul + 1).includes('side-band-64k');
          line = line.slice(0, nul);
        }
      }
      index += 1;
      const parts = line.replace(/\n$/, '').split(' ');
      if (parts.length < 3) continue;
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
    }
    const pack = readPack(parsed.rest);
    return gitResult(ctx, 'git-receive-pack', applyReceivePack(repo, commands, pack, sidebandWanted));
  }
  message(ctx, 404, 'Not Found');
}

// ---------------------------------------------------------------- GraphQL v4

interface GqlFieldNode {
  alias: string | null;
  name: string;
  args: Record<string, unknown>;
  selections: GqlSelectionNode[];
}
interface GqlInlineNode {
  typeCondition: string | null;
  selections: GqlSelectionNode[];
}
type GqlSelectionNode = { field: GqlFieldNode } | { inline: GqlInlineNode };

interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Array<{ name: string; type: string }>;
  selections: GqlSelectionNode[];
}

interface GqlErrorEntry {
  message: string;
  path?: Array<string | number>;
}

class GqlSyntaxError extends Error {}

const GQL_PUNCT = '{}()[]:=!$@|&';

function gqlTokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        const stop = end < 0 ? src.length : end;
        tokens.push(`S:${src.slice(i + 3, stop)}`);
        i = stop + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'u' && j + 5 < src.length) {
            out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc;
          j += 2;
          continue;
        }
        out += src[j];
        j += 1;
      }
      tokens.push(`S:${out}`);
      i = j + 1;
      continue;
    }
    if (src.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if (GQL_PUNCT.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let j = i + 1;
      while (j < src.length && /[0-9.eE+-]/.test(src[j])) j += 1;
      tokens.push(`N:${src.slice(i, j)}`);
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i + 1;
      while (j < src.length && /[_0-9A-Za-z]/.test(src[j])) j += 1;
      tokens.push(`A:${src.slice(i, j)}`);
      i = j;
      continue;
    }
    throw new GqlSyntaxError(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

class GqlParser {
  private pos = 0;
  private readonly tokens: string[];

  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private next(): string {
    const tok = this.tokens[this.pos];
    if (tok === undefined) throw new GqlSyntaxError('unexpected end of document');
    this.pos += 1;
    return tok;
  }

  private expect(tok: string): void {
    const got = this.next();
    if (got !== tok) throw new GqlSyntaxError(`expected ${tok}, got ${got}`);
  }

  private isName(tok: string | undefined): boolean {
    return tok !== undefined && tok.startsWith('A:');
  }

  private nameValue(tok: string): string {
    return tok.slice(2);
  }

  parseDocument(): GqlOperation[] {
    const operations: GqlOperation[] = [];
    while (this.pos < this.tokens.length) {
      operations.push(this.parseOperation());
    }
    if (operations.length === 0) throw new GqlSyntaxError('empty document');
    return operations;
  }

  private parseOperation(): GqlOperation {
    let kind: 'query' | 'mutation' = 'query';
    const first = this.peek();
    if (first !== undefined && (first === 'A:query' || first === 'A:mutation')) {
      kind = this.nameValue(this.next()) as 'query' | 'mutation';
    }
    let name: string | null = null;
    if (this.isName(this.peek())) name = this.nameValue(this.next());
    const variables: Array<{ name: string; type: string }> = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        this.expect('$');
        const varName = this.nameValue(this.next());
        this.expect(':');
        const type = this.parseType();
        if (this.peek() === '=') {
          this.next();
          this.parseValue();
        }
        variables.push({ name: varName, type });
      }
      this.expect(')');
    }
    this.skipDirectives();
    const selections = this.parseSelectionSet();
    return { kind, name, variables, selections };
  }

  private parseType(): string {
    const tok = this.next();
    if (tok === '[') {
      const inner = this.parseType();
      this.expect(']');
      let out = `[${inner}]`;
      if (this.peek() === '!') {
        this.next();
        out += '!';
      }
      return out;
    }
    let out = this.nameValue(tok);
    if (this.peek() === '!') {
      this.next();
      out += '!';
    }
    return out;
  }

  private skipDirectives(): void {
    while (this.peek() === '@') {
      this.next();
      this.next();
      if (this.peek() === '(') {
        this.next();
        let depth = 1;
        while (depth > 0) {
          const tok = this.next();
          if (tok === '(') depth += 1;
          else if (tok === ')') depth -= 1;
        }
      }
    }
  }

  private parseSelectionSet(): GqlSelectionNode[] {
    this.expect('{');
    const selections: GqlSelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        let typeCondition: string | null = null;
        if (this.peek() === 'A:on') {
          this.next();
          typeCondition = this.nameValue(this.next());
        }
        this.skipDirectives();
        selections.push({ inline: { typeCondition, selections: this.parseSelectionSet() } });
        continue;
      }
      let name = this.nameValue(this.next());
      let alias: string | null = null;
      if (this.peek() === ':') {
        this.next();
        alias = name;
        name = this.nameValue(this.next());
      }
      const args: Record<string, unknown> = {};
      if (this.peek() === '(') {
        this.next();
        while (this.peek() !== ')') {
          const argName = this.nameValue(this.next());
          this.expect(':');
          args[argName] = this.parseValue();
        }
        this.expect(')');
      }
      this.skipDirectives();
      const children = this.peek() === '{' ? this.parseSelectionSet() : [];
      selections.push({ field: { alias, name, args, selections: children } });
      continue;
    }
    this.expect('}');
    return selections;
  }

  private parseValue(): unknown {
    const tok = this.next();
    if (tok === '$') return { var: this.nameValue(this.next()) };
    if (tok === '[') {
      const list: unknown[] = [];
      while (this.peek() !== ']') list.push(this.parseValue());
      this.expect(']');
      return list;
    }
    if (tok === '{') {
      const obj: Record<string, unknown> = {};
      while (this.peek() !== '}') {
        const key = this.nameValue(this.next());
        this.expect(':');
        obj[key] = this.parseValue();
      }
      this.expect('}');
      return obj;
    }
    if (tok.startsWith('N:')) return Number(tok.slice(2));
    if (tok.startsWith('S:')) return tok.slice(2);
    if (tok.startsWith('A:')) {
      const word = tok.slice(2);
      if (word === 'true') return true;
      if (word === 'false') return false;
      if (word === 'null') return null;
      return { enum: word };
    }
    throw new GqlSyntaxError(`unexpected value token ${tok}`);
  }
}

function gqlResolveValue(value: unknown, variables: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.var === 'string') return variables[record.var];
    if (typeof record.enum === 'string') return record.enum;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) out[key] = gqlResolveValue(entry, variables);
    return out;
  }
  if (Array.isArray(value)) return value.map((entry) => gqlResolveValue(entry, variables));
  return value;
}

function gqlArgs(field: GqlFieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(field.args)) out[key] = gqlResolveValue(value, variables);
  return out;
}

function gid(type: string, id: number | string): string {
  return Buffer.from(`${type}:${id}`, 'utf8').toString('base64');
}

function ungid(value: string): { type: string; id: string } | null {
  try {
    const text = Buffer.from(value, 'base64').toString('utf8');
    const at = text.indexOf(':');
    if (at <= 0) return null;
    return { type: text.slice(0, at), id: text.slice(at + 1) };
  } catch {
    return null;
  }
}

interface GqlResolved {
  kind: string;
  value: unknown;
}

type GqlOut = GqlResolved | GqlOut[] | string | number | boolean | null;

function gqlSelect(kind: string, value: unknown, selections: readonly GqlSelectionNode[], variables: Record<string, unknown>, errors: GqlErrorEntry[]): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if ('inline' in selection) {
      const condition = selection.inline.typeCondition;
      if (condition !== null && condition !== kind) continue;
      const merged = gqlSelect(kind, value, selection.inline.selections, variables, errors);
      if (merged !== null) Object.assign(out, merged);
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    const resolved = gqlFieldValue(kind, value, field, variables, errors);
    out[key] = resolved === undefined ? null : gqlFinish(resolved, field.selections, variables, errors);
  }
  return out;
}

function gqlFinish(resolved: GqlOut, selections: readonly GqlSelectionNode[], variables: Record<string, unknown>, errors: GqlErrorEntry[]): unknown {
  if (Array.isArray(resolved)) return resolved.map((entry) => gqlFinish(entry, selections, variables, errors));
  if (resolved !== null && typeof resolved === 'object' && 'kind' in resolved) {
    if (selections.length === 0) return resolved.value;
    return gqlSelect(resolved.kind, resolved.value, selections, variables, errors);
  }
  return resolved;
}

const GQL_SCHEMA: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt', 'comments', 'labels', 'closed'],
  PullRequest: ['id', 'number', 'title', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'body', 'createdAt', 'updatedAt', 'isDraft', 'additions', 'deletions', 'changedFiles'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'isPrivate', 'description', 'createdAt', 'url'],
  User: ['login', 'id', 'name', 'email'],
  SearchType: [],
};

const GQL_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'ISSUE_ADVANCED', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

function gqlFindRepoById(id: number): Repo | null {
  for (const repo of repos.values()) if (repo.id === id) return repo;
  return null;
}

function gqlFindRepoByName(owner: string, name: string): Repo | null {
  if (viewerLogin !== '' && owner.toLowerCase() !== viewerLogin.toLowerCase()) return null;
  return repos.get(repoKey(owner, name)) ?? null;
}

function gqlFindIssueById(id: number): { repo: Repo; issue: Issue } | null {
  for (const repo of repos.values()) {
    for (const issue of repo.issues) if (issue.id === id) return { repo, issue };
  }
  return null;
}

function gqlFindPullById(id: number): { repo: Repo; pull: Pull } | null {
  for (const repo of repos.values()) {
    for (const pull of repo.pulls) if (pull.id === id) return { repo, pull };
  }
  return null;
}

function gqlTreePaths(repo: Repo, commitSha: string): Map<string, string> {
  const out = new Map<string, string>();
  const commit = readObject(repo, commitSha);
  if (commit === null || commit.type !== 'commit') return out;
  const treeSha = parseCommit(commit.data).tree;
  const walk = (sha: string, prefix: string): void => {
    const obj = readObject(repo, sha);
    if (obj === null || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.sha, path);
      else out.set(path, entry.sha);
    }
  };
  walk(treeSha, '');
  return out;
}

function gqlChangedPaths(repo: Repo, baseSha: string, headSha: string): string[] {
  const base = gqlTreePaths(repo, baseSha);
  const head = gqlTreePaths(repo, headSha);
  const out: string[] = [];
  for (const [path, sha] of head) if (base.get(path) !== sha) out.push(path);
  for (const path of base.keys()) if (!head.has(path)) out.push(path);
  return out.sort();
}

function gqlIssueState(issue: Issue): string {
  return issue.state === 'closed' ? 'CLOSED' : 'OPEN';
}

function gqlPullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'closed' ? 'CLOSED' : 'OPEN';
}

function gqlIssuesConnection(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  const states = Array.isArray(args.states) ? (args.states as unknown[]).map((entry) => String(entry)) : null;
  const first = typeof args.first === 'number' ? args.first : 30;
  const after = typeof args.after === 'string' ? args.after : null;
  let list = [...repo.issues];
  if (states !== null && states.length > 0) {
    list = list.filter((issue) => states.includes(gqlIssueState(issue)));
  }
  list.sort((a, b) => b.number - a.number);
  let start = 0;
  if (after !== null) {
    const decoded = ungid(after);
    const cursor = decoded === null ? Number.NaN : Number(decoded.id);
    const index = list.findIndex((issue) => issue.number === cursor);
    start = index < 0 ? list.length : index + 1;
  }
  const page = list.slice(start, start + Math.max(0, first));
  const hasNextPage = start + page.length < list.length;
  const last = page[page.length - 1];
  return {
    __kind: 'IssueConnection',
    nodes: page,
    pageInfo: {
      __kind: 'PageInfo',
      hasNextPage,
      endCursor: last === undefined ? null : gid('IssueCursor', last.number),
    },
  };
}

function gqlPullRequestsConnection(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  const first = typeof args.first === 'number' ? args.first : 30;
  const list = [...repo.pulls].filter((pull) => !pull.merged && pull.state === 'open').sort((a, b) => b.number - a.number);
  return { __kind: 'PullRequestConnection', nodes: list.slice(0, Math.max(0, first)) };
}

function gqlFieldValue(kind: string, value: unknown, field: GqlFieldNode, variables: Record<string, unknown>, errors: GqlErrorEntry[]): GqlOut | undefined {
  const args = gqlArgs(field, variables);
  const name = field.name;

  if (kind === 'Query') {
    if (name === 'viewer') return { kind: 'User', value: { login: viewerLogin } };
    if (name === 'repository') {
      const repo = gqlFindRepoByName(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === null ? null : { kind: 'Repository', value: repo };
    }
    if (name === 'node') {
      const decoded = ungid(String(args.id ?? ''));
      if (decoded === null) return null;
      if (decoded.type === 'Repository') {
        const repo = gqlFindRepoById(Number(decoded.id));
        return repo === null ? null : { kind: 'Repository', value: repo };
      }
      if (decoded.type === 'Issue') {
        const found = gqlFindIssueById(Number(decoded.id));
        return found === null ? null : { kind: 'Issue', value: found.issue };
      }
      if (decoded.type === 'PullRequest') {
        const found = gqlFindPullById(Number(decoded.id));
        return found === null ? null : { kind: 'PullRequest', value: found.pull };
      }
      return null;
    }
    if (name === '__type') {
      const typeName = String(args.name ?? '');
      if (!(typeName in GQL_SCHEMA) && !(typeName in GQL_ENUMS)) return null;
      return { kind: '__Type', value: { typeName } };
    }
    if (name === '__typename') return kind;
    errors.push({ message: `Field '${name}' doesn't exist on type 'Query'` });
    return null;
  }

  if (kind === 'Mutation') {
    if (name === '__typename') return kind;
    const input = (args.input ?? {}) as Record<string, unknown>;
    if (name === 'createIssue') {
      const repo = gqlFindRepoById(Number(ungid(String(input.repositoryId ?? ''))?.id ?? Number.NaN));
      if (repo === null) {
        errors.push({ message: 'Could not resolve to a Repository with the global id' });
        return null;
      }
      const issue: Issue = {
        id: nextIssueId++,
        number: repo.nextIssue,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        labels: [],
        createdAt: nowMs(),
        updatedAt: nowMs(),
        comments: [],
      };
      repo.nextIssue += 1;
      repo.issues.push(issue);
      return { kind: 'CreateIssuePayload', value: { issue } };
    }
    if (name === 'closeIssue') {
      const decoded = ungid(String(input.issueId ?? ''));
      const found = decoded === null ? null : gqlFindIssueById(Number(decoded.id));
      if (found === null) {
        errors.push({ message: 'Could not resolve to an Issue with the global id' });
        return null;
      }
      found.issue.state = 'closed';
      found.issue.updatedAt = nowMs();
      found.issue.rev = (found.issue.rev ?? 0) + 1;
      return { kind: 'CloseIssuePayload', value: { issue: found.issue } };
    }
    if (name === 'createPullRequest') {
      const repo = gqlFindRepoById(Number(ungid(String(input.repositoryId ?? ''))?.id ?? Number.NaN));
      if (repo === null) {
        errors.push({ message: 'Could not resolve to a Repository with the global id' });
        return null;
      }
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? '');
      const headSha = repo.refs.get(`refs/heads/${headRef}`);
      const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
      if (headSha === undefined || baseSha === undefined) {
        errors.push({ message: 'Base or head branch does not exist' });
        return null;
      }
      const pull: Pull = {
        id: 30_000 + repo.nextPull,
        number: repo.nextPull,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        headRef,
        headSha,
        baseRef,
        baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        createdAt: nowMs(),
      };
      repo.nextPull += 1;
      repo.pulls.push(pull);
      return { kind: 'CreatePullRequestPayload', value: { pullRequest: pull } };
    }
    if (name === 'mergePullRequest') {
      const decoded = ungid(String(input.pullRequestId ?? ''));
      const found = decoded === null ? null : gqlFindPullById(Number(decoded.id));
      if (found === null) {
        errors.push({ message: 'Could not resolve to a PullRequest with the global id' });
        return null;
      }
      found.pull.merged = true;
      found.pull.state = 'closed';
      found.pull.mergedAt = iso(nowMs());
      found.pull.mergeCommitSha = found.pull.headSha;
      return { kind: 'MergePullRequestPayload', value: { pullRequest: found.pull } };
    }
    if (name === 'addComment') {
      const decoded = ungid(String(input.subjectId ?? ''));
      const found = decoded === null ? null : gqlFindIssueById(Number(decoded.id));
      if (found === null) {
        errors.push({ message: 'Could not resolve to an Issue with the global id' });
        return null;
      }
      const comment: Comment = { id: found.repo.nextComment, body: String(input.body ?? ''), createdAt: nowMs() };
      found.repo.nextComment += 1;
      found.issue.comments.push(comment);
      found.issue.rev = (found.issue.rev ?? 0) + 1;
      return { kind: 'AddCommentPayload', value: { comment } };
    }
    errors.push({ message: `Field '${name}' doesn't exist on type 'Mutation'` });
    return null;
  }

  if (kind === 'Repository') {
    const repo = value as Repo;
    if (name === '__typename') return kind;
    if (name === 'id') return gid('Repository', repo.id);
    if (name === 'databaseId') return repo.id;
    if (name === 'name') return repo.name;
    if (name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
    if (name === 'owner') return { kind: 'User', value: { login: repo.owner } };
    if (name === 'defaultBranchRef') {
      const sha = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (sha === undefined) return null;
      return { kind: 'Ref', value: { name: repo.defaultBranch, sha } };
    }
    if (name === 'viewerPermission') return 'ADMIN';
    if (name === 'hasIssuesEnabled') return true;
    if (name === 'isPrivate') return repo.private;
    if (name === 'description') return repo.description;
    if (name === 'createdAt') return iso(repo.createdAt);
    if (name === 'url') return `/${repo.owner}/${repo.name}`;
    if (name === 'issue') {
      const number = Number(args.number ?? Number.NaN);
      const issue = repo.issues.find((entry) => entry.number === number);
      return issue === undefined ? null : { kind: 'Issue', value: issue };
    }
    if (name === 'issues') return { kind: 'IssueConnection', value: gqlIssuesConnection(repo, args) };
    if (name === 'pullRequests') return { kind: 'PullRequestConnection', value: gqlPullRequestsConnection(repo, args) };
    if (name === 'pullRequest') {
      const number = Number(args.number ?? Number.NaN);
      const pull = repo.pulls.find((entry) => entry.number === number);
      return pull === undefined ? null : { kind: 'PullRequest', value: pull };
    }
    errors.push({ message: `Field '${name}' doesn't exist on type 'Repository'` });
    return null;
  }

  if (kind === 'Ref') {
    const ref = value as { name: string; sha: string };
    if (name === '__typename') return kind;
    if (name === 'name') return ref.name;
    if (name === 'target') return { kind: 'Commit', value: { sha: ref.sha } };
    errors.push({ message: `Field '${name}' doesn't exist on type 'Ref'` });
    return null;
  }

  if (kind === 'Commit') {
    const commit = value as { sha: string };
    if (name === '__typename') return kind;
    if (name === 'oid') return commit.sha;
    errors.push({ message: `Field '${name}' doesn't exist on type 'Commit'` });
    return null;
  }

  if (kind === 'Issue') {
    const issue = value as Issue;
    if (name === '__typename') return kind;
    if (name === 'id') return gid('Issue', issue.id);
    if (name === 'number') return issue.number;
    if (name === 'title') return issue.title;
    if (name === 'body') return issue.body;
    if (name === 'state') return gqlIssueState(issue);
    if (name === 'createdAt') return iso(issue.createdAt);
    if (name === 'updatedAt') return iso(issue.updatedAt);
    if (name === 'closed') return issue.state === 'closed';
    if (name === 'labels') return { kind: 'LabelConnection', value: { nodes: issue.labels.map((label) => ({ name: label })) } };
    if (name === 'comments') return { kind: 'IssueCommentConnection', value: { nodes: issue.comments } };
    errors.push({ message: `Field '${name}' doesn't exist on type 'Issue'` });
    return null;
  }

  if (kind === 'PullRequest') {
    const pull = value as Pull;
    if (name === '__typename') return kind;
    if (name === 'id') return gid('PullRequest', pull.id);
    if (name === 'number') return pull.number;
    if (name === 'title') return pull.title;
    if (name === 'body') return pull.body;
    if (name === 'state') return gqlPullState(pull);
    if (name === 'merged') return pull.merged;
    if (name === 'mergeable') return 'MERGEABLE';
    if (name === 'headRefName') return pull.headRef;
    if (name === 'baseRefName') return pull.baseRef;
    if (name === 'createdAt') return iso(pull.createdAt);
    if (name === 'updatedAt') return iso(pull.createdAt);
    if (name === 'isDraft') return false;
    if (name === 'files') {
      const found = gqlFindPullById(pull.id);
      const repo = found === null ? null : found.repo;
      const paths = repo === null ? [] : gqlChangedPaths(repo, pull.baseSha, pull.headSha);

      const first = typeof args.first === 'number' ? args.first : paths.length;
      return { kind: 'PullRequestChangedFileConnection', value: { nodes: paths.slice(0, Math.max(0, first)).map((path) => ({ path })) } };
    }
    errors.push({ message: `Field '${name}' doesn't exist on type 'PullRequest'` });
    return null;
  }

  if (kind === 'User') {
    const user = value as { login: string };
    if (name === '__typename') return kind;
    if (name === 'login') return user.login;
    if (name === 'id') return gid('User', user.login);
    if (name === 'name') return user.login;
    if (name === 'email') return '';
    errors.push({ message: `Field '${name}' doesn't exist on type 'User'` });
    return null;
  }

  if (kind === 'IssueConnection' || kind === 'PullRequestConnection' || kind === 'PullRequestChangedFileConnection' || kind === 'LabelConnection' || kind === 'IssueCommentConnection') {
    const connection = value as { nodes: unknown[]; pageInfo?: unknown };
    if (name === '__typename') return kind;
    if (name === 'nodes') {
      const childKind =
        kind === 'IssueConnection'
          ? 'Issue'
          : kind === 'PullRequestConnection'
            ? 'PullRequest'
            : kind === 'PullRequestChangedFileConnection'
              ? 'PullRequestChangedFile'
              : kind === 'LabelConnection'
                ? 'Label'
                : 'IssueComment';
      return (connection.nodes as unknown[]).map((node) => ({ kind: childKind, value: node }));
    }
    if (name === 'pageInfo') return { kind: 'PageInfo', value: connection.pageInfo ?? { hasNextPage: false, endCursor: null } };
    if (name === 'totalCount') return (connection.nodes as unknown[]).length;
    errors.push({ message: `Field '${name}' doesn't exist on type '${kind}'` });
    return null;
  }

  if (kind === 'PageInfo') {
    const info = value as { hasNextPage: boolean; endCursor: string | null };
    if (name === '__typename') return kind;
    if (name === 'hasNextPage') return info.hasNextPage;
    if (name === 'endCursor') return info.endCursor;
    if (name === 'startCursor') return info.endCursor;
    errors.push({ message: `Field '${name}' doesn't exist on type 'PageInfo'` });
    return null;
  }

  if (kind === 'PullRequestChangedFile') {
    const file = value as { path: string };
    if (name === '__typename') return kind;
    if (name === 'path') return file.path;
    errors.push({ message: `Field '${name}' doesn't exist on type 'PullRequestChangedFile'` });
    return null;
  }

  if (kind === 'Label') {
    const label = value as { name: string };
    if (name === '__typename') return kind;
    if (name === 'name') return label.name;
    errors.push({ message: `Field '${name}' doesn't exist on type 'Label'` });
    return null;
  }

  if (kind === 'IssueComment') {
    const comment = value as Comment;
    if (name === '__typename') return kind;
    if (name === 'id') return gid('IssueComment', comment.id);
    if (name === 'body') return comment.body;
    if (name === 'createdAt') return iso(comment.createdAt);
    errors.push({ message: `Field '${name}' doesn't exist on type 'IssueComment'` });
    return null;
  }

  if (kind === '__Type') {
    const type = value as { typeName: string };
    if (name === '__typename') return kind;
    if (name === 'name') return type.typeName;
    if (name === 'kind') return type.typeName in GQL_ENUMS ? 'ENUM' : 'OBJECT';
    if (name === 'fields') {
      const fields = GQL_SCHEMA[type.typeName] ?? [];
      return fields.map((entry) => ({ kind: '__Field', value: { name: entry } }));
    }
    if (name === 'enumValues') {
      const values = GQL_ENUMS[type.typeName] ?? [];
      return values.map((entry) => ({ kind: '__EnumValue', value: { name: entry } }));
    }
    errors.push({ message: `Field '${name}' doesn't exist on type '__Type'` });
    return null;
  }

  if (kind === '__Field' || kind === '__EnumValue') {
    const entry = value as { name: string };
    if (name === '__typename') return kind;
    if (name === 'name') return entry.name;
    errors.push({ message: `Field '${name}' doesn't exist on type '${kind}'` });
    return null;
  }

  if (kind === 'CreateIssuePayload') {
    const payload = value as { issue: Issue };
    if (name === '__typename') return kind;
    if (name === 'issue') return { kind: 'Issue', value: payload.issue };
    errors.push({ message: `Field '${name}' doesn't exist on type 'CreateIssuePayload'` });
    return null;
  }

  if (kind === 'CloseIssuePayload') {
    const payload = value as { issue: Issue };
    if (name === '__typename') return kind;
    if (name === 'issue') return { kind: 'Issue', value: payload.issue };
    errors.push({ message: `Field '${name}' doesn't exist on type 'CloseIssuePayload'` });
    return null;
  }

  if (kind === 'CreatePullRequestPayload') {
    const payload = value as { pullRequest: Pull };
    if (name === '__typename') return kind;
    if (name === 'pullRequest') return { kind: 'PullRequest', value: payload.pullRequest };
    errors.push({ message: `Field '${name}' doesn't exist on type 'CreatePullRequestPayload'` });
    return null;
  }

  if (kind === 'MergePullRequestPayload') {
    const payload = value as { pullRequest: Pull };
    if (name === '__typename') return kind;
    if (name === 'pullRequest') return { kind: 'PullRequest', value: payload.pullRequest };
    errors.push({ message: `Field '${name}' doesn't exist on type 'MergePullRequestPayload'` });
    return null;
  }

  if (kind === 'AddCommentPayload') {
    const payload = value as { comment: Comment };
    if (name === '__typename') return kind;
    if (name === 'commentEdge') return { kind: 'IssueCommentEdge', value: payload.comment };
    errors.push({ message: `Field '${name}' doesn't exist on type 'AddCommentPayload'` });
    return null;
  }

  if (kind === 'IssueCommentEdge') {
    const comment = value as Comment;
    if (name === '__typename') return kind;
    if (name === 'node') return { kind: 'IssueComment', value: comment };
    errors.push({ message: `Field '${name}' doesn't exist on type 'IssueCommentEdge'` });
    return null;
  }

  errors.push({ message: `Unknown type '${kind}'` });
  return null;
}

function gqlExecuteOne(document: string, variables: Record<string, unknown>): { data: Record<string, unknown> | null; errors: GqlErrorEntry[] } {
  const errors: GqlErrorEntry[] = [];
  let operation: GqlOperation;
  try {
    const parser = new GqlParser(gqlTokenize(document));
    const operations = parser.parseDocument();
    operation = operations[0];
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const root = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = gqlSelect(root, {}, operation.selections, variables, errors);
  return { data, errors };
}

function graphqlRoute(ctx: Ctx): void {
  if (ctx.method !== 'POST') return message(ctx, 405, 'Method Not Allowed');
  if (ctx.token === null) return message(ctx, 401, 'Requires authentication');
  let payload: unknown;
  try {
    payload = JSON.parse(ctx.body.toString('utf8') || '{}');
  } catch {
    return send(ctx, 400, { message: 'Problems parsing JSON' });
  }
  if (Array.isArray(payload)) {
    const out: unknown[] = [];
    for (const entry of payload) {
      const item = (entry ?? {}) as Record<string, unknown>;
      const document = typeof item.query === 'string' ? item.query : '';
      const variables = (item.variables ?? {}) as Record<string, unknown>;
      const result = gqlExecuteOne(document, variables);
      out.push(result.errors.length > 0 ? { data: result.data, errors: result.errors } : { data: result.data });
    }
    return send(ctx, 200, out);
  }
  const item = (payload ?? {}) as Record<string, unknown>;
  const document = typeof item.query === 'string' ? item.query : '';
  const variables = (item.variables ?? {}) as Record<string, unknown>;
  const result = gqlExecuteOne(document, variables);
  return send(ctx, 200, result.errors.length > 0 ? { data: result.data, errors: result.errors } : { data: result.data });
}

// ---------------------------------------------------------------- the server

export function createApp(): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res);
  });
  server.keepAliveTimeout = 72_000;
  server.headersTimeout = 75_000;
  server.maxRequestsPerSocket = 0;
  return server;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rawUrl = req.url ?? '/';
  const mark = rawUrl.indexOf('?');
  const pathname = mark < 0 ? rawUrl : rawUrl.slice(0, mark);
  const query = mark < 0 ? EMPTY_QUERY : new URLSearchParams(rawUrl.slice(mark + 1));
  const body = req.method === 'GET' || req.method === 'HEAD' ? EMPTY_BODY : await readBody(req);
  const ctx: Ctx = {
    req,
    res,
    method: req.method ?? 'GET',
    path: pathname,
    query,
    token: tokenOf(req),
    body,
    json: undefined,
    requestId: requestId(),
  };
  if (ctx.path === '/healthz') {
    return send(ctx, 200, { ok: true });
  }
  const gitMatch = ctx.path.indexOf('.git') < 0 ? null : /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(ctx.path);
  if (gitMatch !== null) {
    const rest = (gitMatch[3] ?? '').replace(/^\//, '');
    const segments = rest.split('/').filter((part) => part !== '');
    const action = segments.length >= 2 && segments[0] === 'info' ? 'info/refs' : segments.join('/');
    const service = segments.length >= 1 ? segments[0] : '';
    try {
      gitRoute(ctx, decodeURIComponent(gitMatch[1]), decodeURIComponent(gitMatch[2]), service, action);
    } catch (err) {
      message(ctx, 500, `git error: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }
  if (ctx.path === '/mcp' || ctx.path === '/mcp/') {
    try {
      mcpRoute(ctx);
    } catch (err) {
      message(ctx, 500, `mcp error: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }
  if (ctx.path === '/api/graphql') {
    try {
      graphqlRoute(ctx);
    } catch (err) {
      message(ctx, 500, `graphql error: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }
  if (ctx.path.startsWith('/api/v3')) {
    if (body.length > 0) {
      try {
        ctx.json = JSON.parse(body.toString('utf8'));
      } catch {
        return message(ctx, 400, 'Problems parsing JSON');
      }
    }
    try {
      restRoute(ctx);
    } catch (err) {
      message(ctx, 500, `forge error: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }
  notFound(ctx);
}
