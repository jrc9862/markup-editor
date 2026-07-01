# Phase 3 · Slice 5: SCIM 2.0 provisioning — design

Goal (ENTERPRISE_PLAN.md §1 identity, the "SAML/SCIM" remaining item): let an
enterprise identity provider (Okta, Azure AD, OneLogin) **provision and
deprovision** users and groups over the standard SCIM 2.0 REST protocol
(RFC 7643/7644). This is the half of "SAML/SCIM" that governs *who exists* and
*what they belong to*; SAML SSO (how they sign in) is the final Phase-3 slice.

Everything is additive and **gated by `MARKUP_SCIM_TOKEN`**: unset (the dev
default) means the `/scim/v2` routes aren't mounted at all (404), exactly like
the `MARKUP_REPO_DIR` git routes. It reuses the Phase 3 membership model
wholesale — SCIM Users are rows in `users`, SCIM Groups are workspaces, and a
provisioned group member is a `workspace_members` row — so provisioning needs no
new access logic: `auth.roleFor` already gives a member the workspace's baseline
doc role.

## Mapping

| SCIM resource | Markup entity        | notes                                            |
|---------------|----------------------|--------------------------------------------------|
| User          | `users` row          | `userName` → email; `active` toggles access      |
| Group         | `workspaces` row     | `displayName` → name; new groups default to the `editor` baseline |
| Group member  | `workspace_members`  | always role `member` (SCIM has no role concept)  |
| `externalId`  | `users`/`workspaces` `external_id` | the IdP's own stable id, for idempotent lookup |

SCIM has no notion of workspace admin, so provisioned members are plain
`member`s; **in-app admin promotion is unchanged**. A SCIM-created workspace has
no in-app admin and is fully IdP-governed, which is the enterprise expectation.

## Deprovisioning — one enforcement point

Setting a user `active:false` (via `PATCH`/`PUT`, or `DELETE` which we
soft-delete) is the whole deprovisioning story. `resolvePrincipal` (auth.ts)
already resolves the `AuthUser` for both a session cookie and an API token; it
now returns `null` when `user.active === false`. Because the WS
`onAuthenticate` and every REST route funnel through that one function, a single
check locks a deprovisioned user out of **both** surfaces. On deactivate we also
`deleteUserSessions`, so live browser tabs drop on their next request rather than
riding an already-issued session to expiry. The row is kept (not hard-deleted) so
comment/suggestion/version attribution stays intact.

## Auth & transport

The router does its **own** static-bearer check (constant-time compare of
sha256 digests) — it sits outside the `/api` principal guard because the IdP
presents no session or user, just the shared SCIM token. It parses
`application/scim+json` (which `express.json()` ignores by default) and is
IP-rate-limited (`app.use('/scim', apiLimiter)`). Errors use the SCIM envelope
(`urn:ietf:params:scim:api:messages:2.0:Error`); resources carry `schemas`,
`id`, and `meta.{resourceType,location}`.

## Endpoints (`/scim/v2`)

- **Discovery** (IdPs probe before syncing): `GET /ServiceProviderConfig`,
  `/ResourceTypes`, `/Schemas`.
- **Users**: `GET /Users` (+ `filter=userName eq "…"` / `externalId eq "…"`),
  `POST /Users` (409 on duplicate `userName`), `GET/PUT/PATCH/DELETE /Users/:id`.
  `PATCH` handles the `active` op Okta/Azure send to deprovision; `DELETE` is a
  soft delete (deactivate + drop sessions, 204).
- **Groups**: `GET /Groups` (+ `filter=displayName eq "…"` / `externalId`),
  `POST /Groups`, `GET/PUT/PATCH/DELETE /Groups/:id`. `PATCH` `members`
  add/remove maps to `addMember`/`removeMember`; `PUT`/replace reconciles
  membership to exactly the presented set (never stripping an in-app admin);
  `DELETE` calls `deleteWorkspace` (which detaches docs, existing behavior).

## Audit-log synergy

Group create/rename and member add/remove change *workspace* access, so they're
recorded into the existing per-workspace `audit_log` (reusing
`workspace.create`/`workspace.update`/`member.add`/`member.remove`) with
`actorName: 'SCIM'`, `actorId` absent — so admins see IdP-driven changes in the
same slice-4 audit viewer as in-app ones, with no UI change. User-level
provisioning has no workspace scope, so those events go to the pino structured
log instead of the per-workspace audit log.

## Schema (additive, both backends)

- `users`: `active INTEGER NOT NULL DEFAULT 1`, `external_id TEXT`.
- `workspaces`: `external_id TEXT`.

SQLite adds them with the existing `PRAGMA table_info` + `ALTER TABLE ADD COLUMN`
guard; Postgres appends new `MIGRATIONS` entries (never editing a shipped one).
A missing `active` is read as active, so pre-SCIM rows and the whole test suite
are unaffected.

## Deliberately not in this slice

- **SAML SSO** — signed-assertion sign-in (needs a SAML library + IdP metadata),
  the final Phase-3 slice; plus retiring the legacy shared `MARKUP_TOKEN`.
- **Rich SCIM filtering / sorting / bulk** — we support the `attr eq "value"`
  filter IdPs use around create and advertise `bulk:false`; that's enough for
  Okta/Azure sync at these volumes.
- **A SCIM web UI** — provisioning is IdP-driven; there's nothing for a human to
  click in-app.
