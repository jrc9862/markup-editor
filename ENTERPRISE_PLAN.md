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
- **Yjs update compaction**: the update log grows unboundedly per doc; add
  periodic squash-to-snapshot (encode state vector, discard history older
  than N days) or hot docs get slow to load.
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
4. **Phase 3 (enterprise polish)**: SAML/SCIM, audit log export, admin
   console, retention policies, compliance paperwork.
