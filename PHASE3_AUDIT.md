# Phase 3 · Slice 3: Audit log — design

Goal (ENTERPRISE_PLAN.md §4 enterprise polish): a per-workspace **audit log** so
a workspace admin can review who did what. It is *scoped to a workspace* (the
unit built in slice 1) and covers the security-relevant, administrative actions
on that workspace — its settings, its membership, and which docs belong to it.

**Deliberately out of scope: content edits.** Every keystroke is already
captured two other ways — server-side edit history (`doc_versions`, with
per-author attribution) and the realtime event stream (`GET
/api/docs/:id/events`). Re-logging content here would duplicate those and make
the table unbounded; the audit log stays a low-frequency administrative record.

Everything is additive: a new `audit_log` table on both backends, no change to
any existing route's behavior — the workspace mutation routes gain a
best-effort `audit(...)` side-call.

## What's recorded

| action             | when                                    | targetType | detail                    |
|--------------------|-----------------------------------------|------------|---------------------------|
| `workspace.create` | `POST /api/workspaces`                  | workspace  | `{name, defaultRole}`     |
| `workspace.update` | `PATCH /api/workspaces/:id`             | workspace  | changed fields            |
| `member.add`       | `POST .../members`                      | member     | `{email, role}`           |
| `member.update`    | `PATCH .../members/:userId`             | member     | `{from, to}` (role)       |
| `member.remove`    | `DELETE .../members/:userId`            | member     | `{role}`                  |
| `doc.attach`       | `PATCH /api/docs/:id {workspaceId}` in  | doc        | `{name, from}`            |
| `doc.detach`       | `PATCH /api/docs/:id {workspaceId}` out | doc        | `{name, to}`              |

Moving a doc between two workspaces records a `doc.detach` on the source *and* a
`doc.attach` on the destination — each workspace's log tells its own complete
story. The actor is the request principal (workspace routes always carry a real
user; legacy is rejected upstream), denormalized as `actorId` + `actorName` so
history is stable even if the user is later renamed or deleted.

There is no `workspace.delete` entry: deleting a workspace **cascade-deletes its
audit rows** (they're only ever readable by that workspace's admins, who cease
to exist), so a terminal delete entry would be immediately unreadable. Export
first, then delete.

## Schema (both backends, ISO-8601 TEXT timestamps)

```
audit_log (
  id           autoincrement / BIGSERIAL PK,   -- also the pagination cursor
  workspace_id TEXT NOT NULL,
  ts           TEXT NOT NULL,                   -- ISO-8601
  actor_id     TEXT,  actor_name TEXT,          -- denormalized actor
  action       TEXT NOT NULL,
  target_type  TEXT NOT NULL,  target_id TEXT,
  detail       TEXT                             -- JSON, parsed on read
)
INDEX (workspace_id, id)                        -- scoped keyset pagination
```

- **SQLite** (`db.ts` `init()`): `CREATE TABLE IF NOT EXISTS` + the index;
  `deleteWorkspace`'s transaction gains a `DELETE FROM audit_log`.
- **Postgres** (`db-postgres.ts`): two appended `MIGRATIONS` entries (table +
  index); `deleteWorkspace`'s client transaction gains the same delete.

`detail` is stored as a JSON string on both backends (not `JSONB`) to keep the
two stores byte-symmetric; `toAudit()` parses it back to an object.

## Store interface (`MetaStore`)

- `appendAudit(entry: Omit<AuditEntry,'id'>): Promise<AuditEntry>` — assigns and
  returns the `id`.
- `listAudit(workspaceId, {limit?, before?}): Promise<AuditEntry[]>` — newest
  first (descending `id`); `limit` defaults to 100, clamped to 1000; `before` is
  an id cursor (`id < before`) for keyset pagination.

## REST

`GET /api/workspaces/:wsId/audit` — `needs('read')` + `wsAccess('admin')`
(admins only; a non-admin member gets 403, a non-member 404). Query params:
`?limit` (default 100, max 1000), `?before=<id>` (keyset page), and
`?format=csv` to stream a downloadable export (`text/csv` +
`Content-Disposition: attachment`) instead of JSON. CSV is RFC-4180 quoted;
`detail` is emitted as its JSON string.

The `audit(...)` helper (`index.ts`) is fire-and-forget: a logging failure is
logged (`logger.error`) but never fails the action that triggered it.

## Types (`packages/sync-core/src/types.ts`)

`AuditAction` (the union above), `AuditTargetType = 'workspace' | 'member' |
'doc'`, and `AuditEntry { id, workspaceId, ts, actorId?, actorName?, action,
targetType, targetId?, detail? }`.

## Tests

`db.test.ts` contract (SQLite always; Postgres-gated like the rest of the
suite): append + newest-first ordering + object round-trip of `detail`,
`limit`/`before` pagination, cross-workspace isolation, and cascade-delete with
the workspace. Route behavior (emit on each action, admin-only gate, CSV export,
delete cascade) verified end-to-end with curl + dev sessions.

## Not in this slice

Audit-log **web UI** (rides with the admin-console slice), retention/size caps
(the table is low-frequency; can borrow the Phase 2 version-retention pattern
later), and auditing beyond workspace administration (e.g. per-doc ACL/link-role
changes on personal docs, which have no workspace to scope to).
