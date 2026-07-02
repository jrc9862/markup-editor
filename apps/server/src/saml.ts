import { SAML, type Profile } from '@node-saml/node-saml';

/**
 * SAML 2.0 single sign-on (SP-initiated, HTTP-POST binding). The counterpart
 * to OIDC in oidc.ts: this module owns config + the node-saml instance +
 * turning a validated assertion into an identity; the HTTP glue (redirect,
 * ACS, session issuance) lives in auth-routes.ts alongside the OIDC routes, so
 * both sign-in paths issue the same session cookie.
 *
 * Configured entirely by env and gated the same way OIDC/SCIM/git routes are:
 * unset ⇒ no SAML routes and `/auth/providers` reports `saml:false`. A signed
 * assertion is self-verifying (validated against the IdP cert), so unlike OIDC
 * there is no PKCE/nonce state cookie — node-saml checks the signature and the
 * assertion conditions (audience, NotBefore/NotOnOrAfter within clock skew).
 */
export interface SamlConfig {
  /** IdP SSO endpoint the browser is redirected to (HTTP-Redirect binding). */
  entryPoint: string;
  /** IdP token-signing certificate(s), PEM. Verifies the assertion signature. */
  idpCert: string | string[];
  /** SP entity ID we present to the IdP (issuer of the AuthnRequest). */
  issuer: string;
  /** Assertion Consumer Service URL the IdP POSTs the response back to. */
  callbackUrl: string;
  /** Expected <Audience> in the assertion; defaults to `issuer`. */
  audience: string;
  /** Requested NameID format, or null to leave it unspecified. */
  identifierFormat: string | null;
}

/** Env may hold PEM with literal `\n` (single-line secrets) — normalize it. */
function normalizeCert(raw: string): string {
  return raw.replace(/\\n/g, '\n').trim();
}

export function samlFromEnv(serverOrigin: string): SamlConfig | null {
  const entryPoint = process.env.SAML_ENTRY_POINT;
  const idpCert = process.env.SAML_IDP_CERT;
  // Both the IdP endpoint and its signing cert are required — without the cert
  // we could not verify the assertion, so we refuse to enable SAML.
  if (!entryPoint || !idpCert) return null;
  const issuer = process.env.SAML_ISSUER ?? serverOrigin;
  return {
    entryPoint,
    idpCert: normalizeCert(idpCert),
    issuer,
    callbackUrl:
      process.env.SAML_CALLBACK_URL ?? `${serverOrigin}/auth/saml/callback`,
    audience: process.env.SAML_AUDIENCE ?? issuer,
    identifierFormat:
      process.env.SAML_IDENTIFIER_FORMAT ??
      'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  };
}

/** Build the node-saml instance from our config (constructed once, reused). */
export function createSaml(cfg: SamlConfig): SAML {
  return new SAML({
    entryPoint: cfg.entryPoint,
    idpCert: cfg.idpCert,
    issuer: cfg.issuer,
    callbackUrl: cfg.callbackUrl,
    audience: cfg.audience,
    identifierFormat: cfg.identifierFormat,
    // Require the assertion itself to be signed (the security-critical bit);
    // a signed top-level response alone is not enough.
    wantAssertionsSigned: true,
    // We don't sign our AuthnRequests (no SP key configured) — most IdPs accept
    // unsigned requests. wantAuthnResponseSigned stays default.
    wantAuthnResponseSigned: false,
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** First usable string from a SAML attribute value (string or array). */
function firstString(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (Array.isArray(v)) {
    for (const x of v) {
      const s = firstString(x);
      if (s) return s;
    }
  }
  return undefined;
}

function pick(profile: Profile, keys: string[]): string | undefined {
  for (const k of keys) {
    const s = firstString((profile as Record<string, unknown>)[k]);
    if (s) return s;
  }
  return undefined;
}

/**
 * Resolve an email + display name from a validated assertion. IdPs vary wildly
 * in how they name attributes, so we probe the common shapes: node-saml's
 * canonical `email`/`mail`, the standard OIDs, friendly names, and finally the
 * NameID when it is an emailAddress. Throws if no email can be found — email is
 * our user key, so an assertion without one is unusable.
 */
export function identityFromProfile(profile: Profile): {
  email: string;
  name: string;
} {
  const nameID = firstString(profile.nameID);
  const email =
    pick(profile, [
      'email',
      'mail',
      'emailAddress',
      'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
      'urn:oid:0.9.2342.19200300.100.1.3', // mail
    ]) ?? (nameID && EMAIL_RE.test(nameID) ? nameID : undefined);
  if (!email) throw new Error('SAML assertion has no email attribute or NameID');

  const displayName = pick(profile, [
    'displayName',
    'name',
    'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
    'urn:oid:2.16.840.1.113730.3.1.241', // displayName
  ]);
  const given = pick(profile, [
    'givenName',
    'firstName',
    'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname',
    'urn:oid:2.5.4.42', // givenName
  ]);
  const surname = pick(profile, [
    'surname',
    'sn',
    'lastName',
    'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname',
    'urn:oid:2.5.4.4', // sn
  ]);
  const fullName = [given, surname].filter(Boolean).join(' ').trim();
  const name = displayName || fullName || email.split('@')[0];

  return { email: email.toLowerCase(), name };
}
