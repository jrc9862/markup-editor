# Phase 3 · Slice 1: Workspaces — design

Goal (ENTERPRISE_PLAN.md §1 authorization model, deferred to Phase 3): a
**workspace → docs** membership layer above the per-doc owner/ACL model.
Workspaces are the prerequisite for the rest of Phase 3 — SCIM provisions users
*into* a workspace, the admin console *manages* one, the audit log is *scoped*
to one. This slice ships workspaces alone (server + REST + tests); a workspace
web UI is deferred to the admin-console slice.

Everything is additive: a doc with no workspace behaves exactly as before, and
the legacy shared `MARKUP_TOKEN` path is untouched (it has no user identity, so
it belongs to no workspace and `GET /api/workspaces` returns `[]`).

## Model

A **workspace** is an org/membership container that can own docs. Membership is
`admin | member`. A doc may belong to at most one workspace (`doc_meta.
workspace_id`, nullable).

Access impact is centralized in **`roleFor()`** (`apps/server/src/auth.ts`) —
the single function both `effectiveScope()` (every REST `docAccess` gate) and
the WS `onAuthenticate` read-only decision already call, so workspace roles flow
to REST and live WebSocket connections with no per-route changes. New
precedence:

1. legacy principal → `owner` (unchanged)
2. `doc.ownerId === user` → `owner` (the doc owner keeps control inside a workspace)
3. workspace **admin** of `doc.workspaceId` → `owner` (admin override)
4. otherwise the **stronger** of {explicit ACL grant, workspace baseline}, where
   baseline = the workspace's `defaultRole` for a plain member — so an owner's
   ACL grant *promotes* a member above the baseline, and a weaker grant never
   demotes below it (`strongerRole()` ranks by `roleScope`)
5. no `ownerId` → `editor` (legacy open doc, unchanged)
6. else `doc.linkRole ?? 'editor'` (unchanged)

The extra work is at most two store reads (`getMembership`, `getWorkspace`) and
only when the doc carries a `workspaceId`.

## Schema (both backends, ISO-8601 TEXT timestamps)

```
workspaces        (id pk, name, slug unique, default_role, created_at)
workspace_members (workspace_id, user_id, role['admin'|'member'], created_at,
                   PRIMARY KEY (workspace_id, user_id))
doc_meta.workspace_id TEXT   -- nullable; null = personal/legacy doc
```

SQLite: `CREATE TABLE IF NOT EXISTS` + the existing `PRAGMA table_info` /
`ALTER TABLE ADD COLUMN` migration guard for `workspace_id`. Postgres: one new
appended `MIGRATIONS` entry (two `CREATE TABLE`s + `ALTER TABLE doc_meta ADD
COLUMN`); never edit a shipped migration. Deleting a workspace **detaches** its
docs (`workspace_id → NULL`) rather than orphaning them, in one transaction.

## Surface (REST)

A real user identity is required (agents count — they carry a user; the legacy
token does not). `wsAccess('admin'|'member')` mirrors `ownerOnly`/`docAccess`:
404 if the workspace is missing, 403 below the required membership level.

- `GET  /api/workspaces` — workspaces the caller belongs to (`[]` for legacy)
- `POST /api/workspaces` `{name, slug?, defaultRole?}` — creator becomes the
  first admin (slug auto-derived + unique, `409` on collision)
- `GET    /api/workspaces/:id` — member
- `PATCH  /api/workspaces/:id` `{name?, defaultRole?}` — admin (a `defaultRole`
  change kicks the workspace's docs so members re-resolve live)
- `DELETE /api/workspaces/:id` — admin (detaches docs, then deletes)
- `GET    /api/workspaces/:id/members` — member
- `POST   /api/workspaces/:id/members` `{email|userId, role?}` — admin (resolves
  an existing user, exactly like `POST .../permissions`)
- `PATCH  /api/workspaces/:id/members/:userId` `{role}` — admin (promote/demote)
- `DELETE /api/workspaces/:id/members/:userId` — admin
- `PATCH /api/docs/:id` gains `workspaceId` (string | null): only the doc owner
  (or a workspace admin, who resolves as owner) may move a doc, and only into a
  workspace they belong to; kicks the doc's connections so roles re-resolve.

Guards: promoting/demoting or removing an admin refuses (`409`) if it would drop
the workspace's **last admin**. Membership and `defaultRole` changes reuse the
existing live-permission mechanism — `kickDocConnections` on the affected docs;
providers reconnect, `onAuthenticate` re-resolves, and the web client refetches
`myRole`.

Read routes require `read` scope, mutations require `write` scope (a read-only
agent token can't reshape a workspace), on top of the membership gate.

## Not in this slice

Workspace web UI (switcher, member management), SCIM auto-provisioning into a
workspace, SAML, the audit log, and the admin console — all later Phase 3
slices. This slice is exercisable end-to-end via curl + two dev sessions
(`POST /auth/dev`), since the legacy `dev-token` principal has no membership.
