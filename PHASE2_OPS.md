# Phase 2 — Scale-out & Ops

Tracks the implementation of `ENTERPRISE_PLAN.md` Phase 2. Phases 0–1 (git/CI,
Postgres, Docker deploy, identity/roles/ACL — see `PHASE1_IDENTITY.md`) are
already shipped. Phase 2 lands in slices; this doc records what's done and
what's next.

## Slice 1 — Observability + self-protection limits (shipped)

Makes the single node observable and self-protecting ahead of the Redis
multi-node work. No new infrastructure; everything is env-tunable with safe
defaults so local dev and the test suite are unaffected. New server modules:
`apps/server/src/{logger,metrics,connections,limits}.ts`.

| Area | What |
|---|---|
| **Logging** | `pino` + `pino-http` (`logger.ts`). Each request is stamped with the resolved principal (`principalKind`/`principalId`); startup/shutdown logs moved off `console`. JSON by default; `pino-pretty` in dev when available. |
| **Metrics** | `prom-client` registry at `GET /metrics` (`metrics.ts`): `markup_ws_connections`, `markup_docs_loaded`, `markup_doc_updates_total`, `markup_persist_duration_seconds`, `markup_http_request_duration_seconds`, plus default Node process metrics. Wired into the Hocuspocus lifecycle hooks (`onConnect`-time auth, `onDisconnect`, `onLoadDocument`, `afterUnloadDocument`, `onChange`, `onStoreDocument`) and a REST timing middleware (route label kept low-cardinality — `:docId`, not literal ids). |
| **Health split** | `/healthz` = liveness (process up). `/readyz` = readiness: `MetaStore.ping()` succeeds **and** not shutting down. Readiness fails first during graceful SIGTERM so the load balancer drains the node before connections close. Added `ping()` to the `MetaStore` contract and both backends (`SELECT 1`). |
| **Rate limiting** | `express-rate-limit` on `/api` and `/auth`, keyed per authenticated principal (`u:<id>`) else per client IP. SSE (`/events`) and `/metrics` are exempt. |
| **Connection caps** | Per-user WebSocket cap (`ConnectionCounter` in `connections.ts`): a slot is reserved in `onAuthenticate` and released in `onDisconnect`. Legacy/anonymous principals (no stable id) are exempt. |
| **Doc-size guard** | Reject content over a byte budget on the content-**growing** routes (`PUT /content`, `POST /edits`, `POST /docs` seed) → `413`. The edits route simulates the resulting string to size-check before committing. |

### Env (all optional)

| Var | Default | Effect |
|---|---|---|
| `LOG_LEVEL` | `info` | pino level |
| `LOG_PRETTY` | unset | `0` forces JSON outside production |
| `MARKUP_METRICS_TOKEN` | unset | when set, `GET /metrics` requires `Authorization: Bearer <token>` |
| `MARKUP_RATE_WINDOW_MS` | `60000` | rate-limit window |
| `MARKUP_RATE_MAX` | `600` | requests/window; `0` disables |
| `MARKUP_MAX_DOC_BYTES` | `2000000` | max document bytes; `0` disables |
| `MARKUP_MAX_CONNECTIONS_PER_USER` | `20` | WS cap per principal; `0` = unlimited |

### Deliberate decisions

- **Restore is not size-guarded.** `POST /restore` replays already-stored
  (already-bounded) content, not new growth; guarding it would lock users out
  of their own history if the limit were later lowered. The real growth
  vectors are guarded instead.
- **Connection cap is per-node and in-process.** Correct for a single node;
  in the Redis multi-node world it becomes a per-node cap, which is still a
  useful guard. Cross-node accounting is deferred to the Redis slice.
- **`/metrics` is open by default.** Standard for an internal scrape target;
  restrict at the network layer, or set `MARKUP_METRICS_TOKEN` to require a
  bearer.

### Tests

`limits.test.ts`, `connections.test.ts`, `metrics.test.ts`, plus a `ping()`
case added to the shared `MetaStore` contract in `db.test.ts` (Postgres half
runs in CI, skips locally). `tsc --noEmit` clean across all workspaces.

## Remaining Phase 2 slices

1. **Redis multi-node.** Hocuspocus Redis extension (gated by `REDIS_URL`,
   mirroring the `DATABASE_URL` pattern) for cross-node Yjs update + awareness
   fan-out. **Critical coupling:** the in-process `docEvents` bus *and* the
   `lastEditor` map (both in `apps/server/src/index.ts` / `events.ts`) must
   also move onto Redis pub/sub, or SSE delivery and version attribution break
   for connections served by a different node. Compose gains a `redis` service
   and a second server node behind a WS-aware load balancer.
2. **Backups + Yjs compaction.** Periodic squash-to-snapshot of the per-doc
   update log (it grows unbounded today), a `doc_versions` retention policy,
   and a `pg_dump`/PITR runbook.
3. **Load testing.** k6 WebSocket + REST scripts at ~2× expected peak, wired
   into a manual CI workflow.
