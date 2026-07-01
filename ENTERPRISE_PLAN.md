# Enterprise Readiness Plan (~10,000 users)

Where the app stands today: a single Node process, two SQLite files, one
shared bearer token for everyone, and anonymous localStorage identities.
That is the right MVP shape, and almost all of it has a clear upgrade path.
For ~10,000 users (realistically 500–1,500 concurrent WebSocket connections
at peak), the work falls into six tracks.

The architecture core — canonical `Y.Text`, annotations in the same Y.Doc,
REST-over-direct-connection — needs **no rework** for this scale. The work
is identity, Postgres, Redis, and ops discipline.

## 1. Identity & access control — the hard blocker

Everything else is incremental; this is the gap that makes the app unusable
by an enterprise today.

- **SSO**: OIDC/SAML sign-in (start with OIDC; enterprises will demand SAML
  + SCIM provisioning/deprovisioning eventually). Persistent user records
  replace the `guest-xxxx` localStorage names.
- **Per-user + per-agent API tokens** replacing `MARKUP_TOKEN`. Agents are
  first-class in this product, so agent principals get their own scoped
  tokens (read-only, comment-only, suggest-only). This is also what makes
  the agent surface enterprise-palatable: an agent that can *suggest* but
  not *write* is an easy security review.
- **Authorization model**: workspaces → docs, roles
  owner/editor/suggester/commenter/viewer. Enforcement is server-side in two
  choke points that already exist: Hocuspocus `onAuthenticate` (resolve
  identity + role, mark connections read-only for viewers, reject `content`
  writes from suggester/commenter roles in `beforeHandleMessage`) and an
  Express middleware on the REST surface. The suggester role is cheap to
  enforce because suggestions live in separate Y.Arrays from `content`.
- **Attribution**: every comment/suggestion/version stamped with a real user
  id, not a self-reported display name (named-versions/attribution roadmap
  item falls out of this for free).

## 2. Data layer

- **SQLite → Postgres** for both stores. Hocuspocus has a database extension
  interface, so the Yjs-update persistence swap is contained; `MetaStore` is
  one file. Keep the additive-migration discipline but move to a real
  migration tool (e.g. drizzle/knex migrations).
- ~~**Yjs update compaction**~~ (N/A under the current persistence model):
  this assumed an append-only update log, but the Hocuspocus
  `Database`/`SQLite` extensions store a single merged, GC'd snapshot per doc
  (upsert under `UNIQUE(name)`). There is no history to squash; the real
  unbounded vector is `doc_versions`, handled by Phase 2 slice 2 retention.
- **Backups + PITR**, encryption at rest.
- **Document size limit** — a 10 MB markdown file through diff-match-patch
  on every keystroke is a DoS on ourselves.

## 3. Scale-out & availability

- A single beefy node can genuinely hold ~1k Yjs connections, but HA
  requires ≥2 nodes, and Hocuspocus state is in-process. Use the **Redis
  extension** (pub/sub fan-out of updates + awareness between nodes) so any
  node can serve any doc, or do doc-sharded sticky routing at the load
  balancer (consistent-hash on `docId`). Redis is less clever and more
  robust.
- Stateless REST (it already operates through `openDirectConnection`, which
  works with the Redis layer), LB with WebSocket upgrade support, graceful
  shutdown that flushes `onStoreDocument` before exit.
- Rate limiting on REST and connection caps per user. Awareness fan-out is
  O(peers²) per doc, so cap concurrent editors per doc (~50) before it
  becomes a problem.

## 4. Security & compliance

- TLS everywhere, secrets in a manager (not env defaults like `dev-token`),
  CSRF/CORS tightening, input validation on REST bodies (zod).
- **Audit log**: who read/wrote/accepted what, exportable — SOC 2 will
  require it.
- Data retention/deletion policies (version history currently grows
  forever), tenant data isolation tests, dependency scanning + a
  pinned-versions policy (the TipTap v2 pin is already a taste of this).
- The CLI writes arbitrary paths from a manifest — needs path-traversal
  hardening before enterprise laptops run it.

## 5. Operations & observability

- Structured logs, metrics (connections, docs loaded, update throughput,
  persistence latency), tracing on REST, alerting. `/healthz` exists but
  needs a readiness vs. liveness split.
- CI: the test + `tsc --noEmit` matrix already documented in CLAUDE.md, plus
  Playwright e2e for the two-tab convergence loop and a k6 WebSocket load
  test at 2× expected peak.
- Staging environment, IaC, and an actual production build/deploy story for
  the Next.js app (it currently only runs in dev mode).
- **First prerequisite for all of it: `git init`.** The repo deliberately
  isn't one yet; nothing above is reviewable or deployable without version
  control and CI.

## 6. Product hardening enterprises will ask for

- Admin console (user/workspace management, usage).
- Share links with role baked in.
- Named versions.
- Webhooks/SSE for agent subscriptions and the MCP server (both already on
  the roadmap) — these become differentiators in an "agents + humans" pitch.

## Sequencing

1. **Phase 0 (foundation)**: git + CI + Postgres migration + production
   build/deploy. Everything depends on this.
2. **Phase 1 (identity)**: OIDC sign-in, per-user/agent tokens, roles +
   server-side enforcement, attribution.
3. **Phase 2 (scale/ops)**: Redis multi-node, observability, backups, rate
   limits, load testing.
   - **Slice 1 — observability + limits (shipped; see PHASE2_OPS.md).**
     Structured logging
     (pino/pino-http with per-request principal attribution), Prometheus
     `/metrics` (ws connections, docs loaded, update throughput, persistence
     + REST latency), liveness `/healthz` vs readiness `/readyz`
     (`MetaStore.ping()`, fails during graceful shutdown so the LB drains
     first), REST rate limiting (`express-rate-limit`, per-principal/per-IP),
     per-user WebSocket connection caps, and a document byte-size guard on the
     content-growing routes. All env-tunable, no new infra.
   - **Slice 2 — backups + history retention (shipped; see PHASE2_OPS.md).**
     `doc_versions` retention caps (per-doc count + age, sparing user-named and
     latest snapshots; pruned on write and via a startup sweep) and
     `scripts/backup.sh` (pg_dump / SQLite online `.backup`, PITR runbook).
     Note: the persistence model stores a single GC'd Yjs snapshot per doc
     (upsert, not an append-only update log), so there is no update log to
     squash — "Yjs update compaction" above is moot under the current
     extension and was dropped as a deliberate non-goal.
   - **Slice 3 — Redis multi-node (shipped; see PHASE2_OPS.md).** Hocuspocus
     Redis extension (gated by `REDIS_URL`, mirroring `DATABASE_URL`) for
     cross-node Yjs update + awareness fan-out, plus the two in-process pieces
     that would otherwise break across nodes: the `docEvents` SSE bus (bridged
     onto a Redis channel via a transport seam on `DocEventBus`) and the
     `lastEditor` version-attribution map (moved into Redis with a TTL). LB
     topology in `docker-compose.scale.yml` + `deploy/nginx.conf` (a `redis`
     service, scaled `server` replicas with no host port, and a WS-aware nginx
     `lb` owning `:4000`); `MARKUP_TRUST_PROXY` for correct client IPs behind
     the LB. The per-user WS connection cap stays in-process (a per-node guard).
   - **Slice 4 — k6 load testing (shipped; see PHASE2_OPS.md).** `k6/ws.js`
     (connection capacity) + `k6/rest.js` (throughput) over a hand-rolled
     minimal Hocuspocus wire codec, with a manual `workflow_dispatch` CI job.
     Phase 2 is complete.
4. **Phase 3 (enterprise polish)**: workspaces, SAML/SCIM, audit log export,
   admin console, retention policies, compliance paperwork.
   - **Slice 1 — workspaces (shipped; see PHASE3_WORKSPACES.md).** A
     workspace → docs membership layer: `workspaces` + `workspace_members`
     tables, `doc_meta.workspace_id`, and the whole access impact centralized
     in `auth.roleFor` (workspace admins act as owner over the workspace's
     docs; members get the workspace's `default_role` baseline, promotable by
     an owner's ACL grant). `/api/workspaces` route family + a `workspaceId`
     branch on `PATCH /api/docs/:id`. Server + REST + tests.
   - **Slice 2 — workspace web UI (shipped).** Home-page Workspaces section
     (list/create, admin-gated member management + `defaultRole`, delete) and
     a Workspace selector in the owner's Share popover to move a doc into/out
     of a workspace (`lib/workspaces.ts`, `WorkspacesPanel.tsx`, `SharePanel`).
     Web only — drives the slice-1 routes unchanged.
   - **Slice 3 — audit log (shipped; see PHASE3_AUDIT.md).** Per-workspace
     `audit_log` table on both backends recording administrative actions
     (workspace/member changes, doc attach/detach) via a best-effort `audit()`
     side-call; `MetaStore.appendAudit`/`listAudit` (newest-first, keyset
     pagination); `GET /api/workspaces/:id/audit` (admin only, `?format=csv`
     export); cascade-deletes with its workspace. Content edits stay out of
     scope (covered by `doc_versions` + the event stream). Server + REST +
     tests; audit-log web UI rides with the admin console.
   - **Slice 4 — admin console web UI (shipped).** An admin-only "Audit log"
     viewer inside each `WorkspacesPanel` card: newest-first entries with
     human-readable summaries, keyset "Load more" pagination, and a CSV export
     (blob download). New `listAudit`/`fetchAuditCsv` in `lib/workspaces.ts`;
     drives the slice-3 route unchanged. Web only.
   - **Slice 5 — SCIM 2.0 provisioning (shipped; see PHASE3_SCIM.md).** An IdP
     (Okta/Azure AD) provisions/deprovisions users + groups at `/scim/v2/*`
     under a static bearer (`MARKUP_SCIM_TOKEN`; unset ⇒ routes 404). SCIM Users
     map onto `users`, Groups onto workspaces + members — so it rides the Phase
     3 membership model unchanged. Deprovisioning is `active:false`, enforced at
     the single `resolvePrincipal` choke point (locks the user out of REST + WS,
     drops their sessions); the row is kept for attribution. Additive schema
     (`users.active`/`users.external_id`, `workspaces.external_id`); group
     changes reuse the per-workspace audit log with actor `SCIM`. Server + REST
     + tests.
   - Remaining: SAML SSO (signed-assertion sign-in), then retiring the legacy
     shared `MARKUP_TOKEN`.
