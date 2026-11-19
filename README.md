# github-core-clone-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/vcspeeper-cmd/github-core-clone-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/vcspeeper-cmd/github-core-clone-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible forge in one dependency-free Node 22 program: REST v3, GraphQL v4, an MCP server
and git smart HTTP, all over a single in-memory store.

- **REST v3** — repositories, issues, comments, labels, pull requests, branches, commits, contents,
  git refs and blobs, with the pagination and error shapes the clients expect.
- **GraphQL v4** — a hand-written parser and executor for the documents `gh` and `github-mcp-server`
  send: `viewer`, `repository`, `node`, `__type` introspection, issue and pull-request connections
  with cursor pagination, and the create/close/merge/comment mutations.
- **MCP** — streamable HTTP with the tool set an agent needs to drive the forge, reading and writing
  the same store the REST and GraphQL surfaces serve.
- **git smart HTTP** — protocol v0 and v2 `info/refs`, `ls-refs`, `fetch` (thin packs, shallow and
  `deepen`, `unshallow` boundaries) and `receive-pack` (pack parsing, per-ref report-status,
  fast-forward enforcement).

Every object is stored as its canonical git bytes, so ids are content hashes and the same commit is
reachable from the REST, GraphQL, MCP and git views.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its
own. There is nothing to install: the program imports `node:http`, `node:crypto`, `node:zlib` and its
own `app.ts` only.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
