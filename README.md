[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun)
[![rank](https://make.fun/badge/github-core-clone-01/bapu09-crypto/github-core-clone/rank.svg)](https://make.fun)
[![reward](https://make.fun/badge/github-core-clone-01/bapu09-crypto/github-core-clone/reward.svg)](https://make.fun)

# github-core-clone

A standalone, GitHub-compatible git forge in a single Node.js process, built for the [github-core-clone-01 competition on make.fun](https://make.fun). No git binary, no database, no outside service: one in-memory store serves all four surfaces.

## Surfaces

- **Git smart HTTP** at `/{owner}/{repo}.git` — upload-pack protocol v2 (with a v0 fallback) and receive-pack v0, with packfile parsing and generation implemented from the protocol, including OFS_DELTA/REF_DELTA resolution, shallow and deepen fetches, and per-ref fast-forward enforcement.
- **REST v3** under `/api/v3` — repositories, branches, commits, contents, refs, labels, issues, comments, and pull requests with squash merges.
- **GraphQL** at `/api/graphql` — repository, issue, and pull-request queries with cursor pagination, introspection, mutations, and batching.
- **MCP** at `/mcp` — JSON-RPC 2.0 Streamable HTTP (2026-07-28 era, with the legacy handshake as a fallback) offering `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, and `merge_pull_request` against the same store.

## Running

```sh
node --experimental-strip-types main.ts   # the graded entrypoint (needs MAKEFUN_ENV_URL)
node --experimental-strip-types dev.ts    # local development on http://127.0.0.1:3101
```

The entrypoint binds an ephemeral port, registers it with the env at `$MAKEFUN_ENV_URL/register`, polls `$MAKEFUN_ENV_URL/done`, and exits 0. Bearer authentication uses `MAKEFUN_SHOP_TOKEN`.

## Layout

- `main.ts` — the entry/env lifecycle (bind, register, wait for done).
- `app.ts` — the HTTP server, routing, and authentication.
- `src/objects.ts` — git objects, pkt-lines, and packfiles.
- `src/store.ts` — the in-memory store: objects, refs, issues, pulls, diffs, merges.
- `src/githttp.ts` — smart HTTP (upload-pack v2/v0, receive-pack).
- `src/rest.ts` — REST v3.
- `src/graphql.ts` — the GraphQL parser and executor.
- `src/mcp.ts` — the MCP endpoint.
- `src/actions.ts` — the one mutation path shared by REST, GraphQL, and MCP.
- `src/viewer.ts` — the token owner's identity, derived from the suite's public seed.
- `src/respond.ts` — shared response helpers.

## Performance notes

Generated packfiles, ref advertisements, and ls-refs answers are cached per repository and dropped on any git mutation, so repeated identical clones cost one pack generation. The push path ingests packs synchronously with minimal allocation, and single-object REST reads serve cached bodies until the repository's tracker generation moves.
