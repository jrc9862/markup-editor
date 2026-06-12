# Phase 1: Identity & Access Control — design

Goal (ENTERPRISE_PLAN.md §1): real user identity, per-user/per-agent API
tokens, per-doc roles with server-side enforcement, and attribution.
Everything lands additively: the legacy shared `MARKUP_TOKEN` keeps working
until enforcement flips on, so the dev loop and existing CLI/web never break
mid-migration.

## Principals

Three ways a request can be authenticated, resolved in this order:

1. **Session cookie** (`markup_session`, httpOnly) — a signed-in human.
   Full `write` scope; per-doc roles narrow this in milestone 2.
2. **API token** (`Authorization: Bearer mkp_...`) — a per-user or per-agent
   token with a scope. This is also CLI auth: set `MARKUP_TOKEN=mkp_...`.
3. **Legacy shared token** (`MARKUP_TOKEN` env, default `dev-token`) — a
   full-access principal with no user identity. Deprecated; removed when
   milestone 2 enforcement ships.

Scopes are ordered: `read < comment < suggest < write`. A token's scope is
checked per route (e.g. accepting a suggestion mutates content → `write`;
proposing one → `suggest`). An agent that can suggest but not write is the
enterprise-palatable default for automation.

## Sign-in

- **OIDC** (authorization code + PKCE), provider-agnostic via discovery:
  `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, optional
  `OIDC_REDIRECT_URI`. id_token verified with the issuer JWKS (jose).
  Users are upserted by verified email.
- **Dev sign-in** (`POST /auth/dev {email, name}`) — enabled only when OIDC
  is not configured; keeps the zero-setup loop. Configuring OIDC disables it.
- Sessions: 32-byte random token, sha256 hash stored, 30-day expiry,
  httpOnly SameSite=Lax cookie (localhost:3000 → :4000 is same-site).
  REST from the web app sends `credentials: 'include'`; CORS is locked to
  `MARKUP_WEB_ORIGIN` (default `http://localhost:3000`).
- WebSocket: `onAuthenticate` accepts the session cookie from the upgrade
  request headers, an API token, or the legacy token via the provider's
  `token` param.

## Schema (both backends, ISO-8601 TEXT timestamps)

```
users      (id uuid pk, email unique, name, created_at)
sessions   (token_hash pk, user_id, created_at, expires_at)
api_tokens (id uuid pk, user_id, name, scope, token_hash unique,
            created_at, last_used_at)
```

Tokens/sessions store only sha256 hashes; plaintext is shown once at
creation (`mkp_` + 48 hex chars).

## Surface

- `GET /auth/providers` → which sign-in methods exist (web renders sign-in)
- `GET /auth/oidc/login` → redirect to IdP · `GET /auth/oidc/callback`
- `POST /auth/dev` (dev only) · `POST /auth/logout`
- `GET /api/me` → current principal
- `GET|POST /api/tokens` · `DELETE /api/tokens/:id` (session-only)

Attribution: when the principal is a user, the server stamps comments and
suggestions with the real name + `authorId` (ignoring self-reported names);
agent tokens stamp the token's name. Version/named-version attribution is a
later milestone (plan §1 last bullet).

## Milestones

1. **Identity core** (this milestone): schema, sessions, OIDC + dev sign-in,
   API tokens with scopes, `/api/me`, scope checks on REST, attribution on
   annotations, web sign-in + identity-aware presence. Legacy token still
   full-access.
2. **Roles & enforcement**: `doc_acl` (owner/editor/suggester/commenter/
   viewer), share/default roles, Hocuspocus read-only connections for
   non-editors (suggester/commenter act through REST), role checks on every
   route, `MARKUP_REQUIRE_AUTH=1` to disable the legacy token, sharing UI.
3. **Workspaces + SAML/SCIM** (Phase 3 territory).
