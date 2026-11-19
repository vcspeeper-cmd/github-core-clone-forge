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
function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
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
  const out: Record<string, string> = {
    'content-type': JSON_TYPE,
    'content-length': String(Buffer.byteLength(text)),
    'x-github-request-id': ctx.requestId,
    ...headers,
  };
  ctx.res.writeHead(status, out);
  ctx.res.end(text);
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
      id: 10_000 + repo.nextIssue,
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
  if (ctx.method === 'GET') return send(ctx, 200, issueJson(repo, issue));
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
      id: 30_000 + repo.nextPull,
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
        id: 30_000 + repo.nextPull,
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

// ---------------------------------------------------------------- the server

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    url = new URL('http://entry/');
  }
  const body = await readBody(req);
  const ctx: Ctx = {
    req,
    res,
    method: req.method ?? 'GET',
    path: url.pathname,
    query: url.searchParams,
    token: tokenOf(req),
    body,
    json: undefined,
    requestId: requestId(),
  };
  if (ctx.path === '/healthz') {
    return send(ctx, 200, { ok: true });
  }
  if (ctx.path === '/mcp' || ctx.path === '/mcp/') {
    try {
      mcpRoute(ctx);
    } catch (err) {
      message(ctx, 500, `mcp error: ${err instanceof Error ? err.message : String(err)}`);
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
