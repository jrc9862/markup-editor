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

## Slice 2 — Backups + history retention (shipped)

Bounds the one genuinely unbounded growth vector and documents the backup
story. No new infrastructure.

**What actually grows.** Investigating the persistence model corrected the
original plan's premise: there is *no* append-only Yjs update log to squash.
Both backends store a **single merged snapshot per doc** — the Hocuspocus
`Database`/`SQLite` extensions hand us the fully-encoded (GC-on) `Y.Doc` state
on each `onStoreDocument` and we upsert it under a `UNIQUE(name)` row. Yjs GC
already collapses deleted content to tombstones in that snapshot, so
"compaction" of the doc state buys little and is a deliberate non-goal (see
below). The real unbounded vector is `doc_versions`: a full-content markdown
snapshot is appended every ~60s of active editing and never expires.

| Area | What |
|---|---|
| **History retention** | `MetaStore.pruneVersions(docId, policy)` drops unnamed `doc_versions` rows that breach a per-doc count cap and/or age cap, in one `DELETE`. Runs after each successful `maybeAddVersion` (only when a snapshot was actually added, so it stays off the no-op store path) and as a one-shot `pruneAllVersions` sweep at startup (so the age cap also reaches docs no longer being edited). `markup_versions_pruned_total` counts removals. |
| **Backups** | `scripts/backup.sh`: `pg_dump` (custom format) when `DATABASE_URL` is set, else a consistent SQLite `.backup` of both `markup-docs`/`markup-meta` files. Timestamped output, restore commands printed. |

**Retention invariants** (enforced identically in both backends, covered by the
shared `db.test.ts` contract):

- **User-named versions are never pruned** — naming a version pins it.
- **The single most-recent version is never pruned** — a doc always keeps at
  least one restorable point, even if it's old and unnamed.
- Each cap is independently disable-able (`<=0`); both off ⇒ a guaranteed no-op.

### Env (all optional)

| Var | Default | Effect |
|---|---|---|
| `MARKUP_VERSION_RETENTION_MAX` | `500` | max versions kept per doc; `0` disables the count cap |
| `MARKUP_VERSION_RETENTION_DAYS` | `0` (off) | drop versions older than N days; `0` disables the age cap |

### Deliberate decisions

- **No Yjs state compaction.** The stored state is already a single GC'd
  snapshot, not a replayable update log; the only further shrink would be
  re-encoding the doc under a fresh client id, which discards the CRDT history
  that lets offline peers (the CLI's `.markup/state`) merge on reconnect. Not
  worth breaking conflict-free offline sync for a marginal blob-size win.
- **Age cap applies on next write (plus the startup sweep).** A doc that goes
  idle is pruned by the startup sweep; between sweeps an idle doc keeps its
  history. A periodic in-process sweeper is deferred — restart is the cadence.
- **Restore-by-name still works after pruning.** Retention only touches
  *unnamed* versions, so any version a user cared enough to name (or the
  latest) survives indefinitely.

## Remaining Phase 2 slices

1. **Redis multi-node.** Hocuspocus Redis extension (gated by `REDIS_URL`,
   mirroring the `DATABASE_URL` pattern) for cross-node Yjs update + awareness
   fan-out. **Critical coupling:** the in-process `docEvents` bus *and* the
   `lastEditor` map (both in `apps/server/src/index.ts` / `events.ts`) must
   also move onto Redis pub/sub, or SSE delivery and version attribution break
   for connections served by a different node. Compose gains a `redis` service
   and a second server node behind a WS-aware load balancer.
2. **Load testing.** k6 WebSocket + REST scripts at ~2× expected peak, wired
   into a manual CI workflow.

## Backups (runbook)

- **Postgres (production).** `scripts/backup.sh` runs `pg_dump --format=custom`
  for a portable logical snapshot. For low RPO, layer continuous WAL archiving /
  PITR at the database/provider level (managed Postgres: enable automated
  backups + PITR; self-hosted: `archive_command` + `pg_basebackup`). Restore a
  dump with `pg_restore --clean --if-exists -d "$DATABASE_URL" <dump>`.
- **SQLite (local/self-hosted).** `scripts/backup.sh` uses the online `.backup`
  command (consistent against a running server, unlike `cp`). Restore by
  stopping the server and copying the files back into `MARKUP_DATA_DIR`.
- **What's covered.** `markup-docs` = Yjs document state (the live content);
  `markup-meta` = doc metadata, ACLs, tokens/sessions, and version history.
  Back up both together — a meta dump without the matching doc state restores
  names/permissions but not content.
