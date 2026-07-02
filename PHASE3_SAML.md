# Phase 3 · Slice 6: SAML 2.0 SSO — design

Goal (ENTERPRISE_PLAN.md §1 identity, the "SAML/SCIM" remaining item): let a
signed-in human authenticate through an enterprise SAML 2.0 identity provider
(Okta, Azure AD, OneLogin, ADFS). This is the *how they sign in* half of
"SAML/SCIM"; SCIM (slice 5) already governs *who exists*. Together they are the
last identity work before retiring the legacy shared `MARKUP_TOKEN`.

Everything is additive and **gated by env**: SAML is enabled only when both
`SAML_ENTRY_POINT` and `SAML_IDP_CERT` are set. Unset (the dev default) means
the `/auth/saml/*` routes 404 and `/auth/providers` reports `saml:false` — the
same gating shape as the OIDC (`OIDC_*`), SCIM (`MARKUP_SCIM_TOKEN`), and git
(`MARKUP_REPO_DIR`) surfaces.

## Shape

SP-initiated login over the **HTTP-POST binding**, via
[`@node-saml/node-saml`](https://www.npmjs.com/package/@node-saml/node-saml) v5:

1. `GET /auth/saml/login` — build a signed-less AuthnRequest and 302 the browser
   to the IdP `entryPoint` (HTTP-Redirect binding, `SAMLRequest` query param).
2. IdP authenticates the user and POSTs a signed SAML Response back to the
   Assertion Consumer Service.
3. `POST /auth/saml/callback` (`application/x-www-form-urlencoded`) — validate
   the response, extract the identity, JIT-provision the user, issue a session
   cookie, and 302 to the web origin.
4. `GET /auth/saml/metadata` — SP metadata XML for configuring the IdP
   (entity ID, ACS URL, NameID format, `WantAssertionsSigned`).

The design deliberately **mirrors OIDC** (`oidc.ts` + the OIDC routes in
`auth-routes.ts`): `saml.ts` owns config + the node-saml instance + turning a
validated assertion into an `{email, name}` identity; the HTTP glue lives beside
the OIDC routes so **both paths issue the same `markup_session` cookie** through
`startSession`/`sessionCookie`. Nothing downstream (WS `onAuthenticate`, REST
`resolvePrincipal`, per-doc roles, workspaces) knows or cares which SSO minted
the session.

## No state cookie (unlike OIDC)

OIDC carries a per-login `state`/`nonce`/PKCE `verifier` in a short-lived cookie
because the code exchange must be tied back to the browser that started it. SAML
needs none of that: the **assertion is self-verifying** — node-saml checks the
XML signature against `SAML_IDP_CERT` and the assertion conditions (audience
restriction, `NotBefore`/`NotOnOrAfter` within the default clock skew). We set
`wantAssertionsSigned:true` (the security-critical bit — a signed envelope alone
is not enough). `validateInResponseTo` is left at its default off, so login is
stateless and works across a multi-node deployment with no shared replay cache.

## Identity extraction (`identityFromProfile`)

IdPs disagree wildly on attribute names, so we probe common shapes in order and
throw if no email is found (email is our user key):

- **email**: `email`, `mail`, `emailAddress`, the WS-Fed claim URI, the
  `urn:oid:0.9.2342.19200300.100.1.3` (mail) OID, and finally the `NameID` when
  it is itself an email address (the default requested NameID format is
  `emailAddress`).
- **name**: `displayName`/`name` (+ claim URI + displayName OID), else
  `givenName` + `surname`/`sn` (+ URIs + OIDs), else the email local-part.

Email is lowercased so it matches whatever OIDC/SCIM/dev already stored.
Multi-valued attributes take the first usable string.

## JIT provisioning + interaction with SCIM

The callback calls the same `meta.upsertUser(uuid, email, name)` OIDC uses:
idempotent by email, so a returning user reuses their row (and any workspace
memberships, ACL grants, and attribution) rather than duplicating. A brand-new
asserted user is created on first sign-in.

SCIM deprovisioning still wins: if a user was set `active:false`, `upsertUser`
returns the existing inactive row and we happily start a session — but
`resolvePrincipal` rejects an inactive user on the very next request, so a
SAML-authenticated but SCIM-deprovisioned user is locked out of REST and WS
exactly as intended. (This is the identical code path OIDC already takes.)

## Config (env)

| Env | Required | Default | Meaning |
|-----|----------|---------|---------|
| `SAML_ENTRY_POINT` | yes | — | IdP SSO URL the browser is redirected to |
| `SAML_IDP_CERT` | yes | — | IdP token-signing cert (PEM; literal `\n` accepted for single-line secrets) |
| `SAML_ISSUER` | no | `MARKUP_SERVER_ORIGIN` | SP entity ID in the AuthnRequest/metadata |
| `SAML_CALLBACK_URL` | no | `<origin>/auth/saml/callback` | ACS URL the IdP POSTs to |
| `SAML_AUDIENCE` | no | `SAML_ISSUER` | expected `<Audience>` in the assertion |
| `SAML_IDENTIFIER_FORMAT` | no | `…nameid-format:emailAddress` | requested NameID format |

Both `SAML_ENTRY_POINT` and `SAML_IDP_CERT` are required to enable — without the
cert we could not verify the assertion, so we refuse to turn SAML on.

## Web

`fetchProviders()` now returns `{oidc, saml, dev}`; `UserMenu`'s Sign-in button
redirects to `/auth/saml/login` when `saml` is set (after OIDC, before the dev
prompt). Dev sign-in (`/auth/dev`) is disabled whenever *either* SSO is
configured. No other UI changes — post-callback the browser lands back on the
web origin already signed in, and every component refetches `/api/me` as before.

## Files

- `apps/server/src/saml.ts` — `samlFromEnv`, `createSaml`, `identityFromProfile`.
- `apps/server/src/auth-routes.ts` — the four `/auth/saml/*` routes + `saml`
  added to `AuthRouteOpts` and `/auth/providers`; dev sign-in gated on SSO.
- `apps/server/src/index.ts` — `samlFromEnv(SERVER_ORIGIN)` wired into
  `registerAuthRoutes`.
- `apps/web/src/lib/auth.ts`, `apps/web/src/components/UserMenu.tsx` — provider
  type + SAML sign-in button.
- `apps/server/src/saml.test.ts` — env gating/defaults/cert normalization +
  `identityFromProfile` attribute-probe cases.

## Tests / verification

- Unit (`saml.test.ts`, 8 cases): `samlFromEnv` gating (null unless both
  endpoint+cert), origin-derived defaults, explicit overrides + escaped-newline
  cert normalization; `identityFromProfile` across email/mail/OID/NameID and
  given+surname, multi-valued attributes, and the no-email throw.
- Runtime smoke (dev server, throwaway self-signed IdP cert): with SAML unset,
  `/auth/providers` → `saml:false` and `/auth/saml/{metadata,login}` → 404; with
  it set, `providers` → `saml:true,dev:false`, `/auth/dev` → 404, `/auth/saml/login`
  → 302 to the IdP with a `SAMLRequest`, `/auth/saml/metadata` → SP XML
  (`entityID=markup-sp`, `WantAssertionsSigned="true"`), and a bogus
  `/auth/saml/callback` → 401.

## Deliberately not in this slice

- **IdP-initiated login / SP-signed AuthnRequests / SAML SLO** — SP-initiated
  POST binding covers the enterprise sign-in case; no SP key is configured, so
  requests are unsigned (accepted by mainstream IdPs).
- **IdP metadata auto-import** — cert + endpoint are supplied directly by env;
  parsing IdP metadata XML is unnecessary complexity for this surface.
- **A SAML choice UI** — a deployment configures one SSO; the button routes to
  whichever is enabled.
