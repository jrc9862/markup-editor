import { createHash, randomBytes } from 'node:crypto';
import * as jose from 'jose';

/**
 * Provider-agnostic OIDC (authorization code + PKCE) via issuer discovery.
 * Configured entirely by env; works with Google, Okta, Auth0, Keycloak, etc.
 */
export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function oidcFromEnv(serverOrigin: string): OidcConfig | null {
  const issuer = process.env.OIDC_ISSUER;
  const clientId = process.env.OIDC_CLIENT_ID;
  const clientSecret = process.env.OIDC_CLIENT_SECRET;
  if (!issuer || !clientId || !clientSecret) return null;
  return {
    issuer: issuer.replace(/\/$/, ''),
    clientId,
    clientSecret,
    redirectUri:
      process.env.OIDC_REDIRECT_URI ?? `${serverOrigin}/auth/oidc/callback`,
  };
}

interface DiscoveryDoc {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

let discovery: DiscoveryDoc | null = null;
let jwks: ReturnType<typeof jose.createRemoteJWKSet> | null = null;

async function discover(cfg: OidcConfig): Promise<DiscoveryDoc> {
  if (discovery) return discovery;
  const res = await fetch(`${cfg.issuer}/.well-known/openid-configuration`);
  if (!res.ok) {
    throw new Error(`OIDC discovery failed: ${res.status} for ${cfg.issuer}`);
  }
  discovery = (await res.json()) as DiscoveryDoc;
  jwks = jose.createRemoteJWKSet(new URL(discovery.jwks_uri));
  return discovery;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

/** Per-login state carried in a short-lived httpOnly cookie. */
export interface OidcLoginState {
  state: string;
  nonce: string;
  verifier: string;
}

export function newLoginState(): OidcLoginState {
  return {
    state: base64url(randomBytes(16)),
    nonce: base64url(randomBytes(16)),
    verifier: base64url(randomBytes(32)),
  };
}

export async function buildAuthUrl(
  cfg: OidcConfig,
  login: OidcLoginState,
): Promise<string> {
  const doc = await discover(cfg);
  const challenge = base64url(
    createHash('sha256').update(login.verifier).digest(),
  );
  const url = new URL(doc.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', cfg.redirectUri);
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', login.state);
  url.searchParams.set('nonce', login.nonce);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/**
 * Exchange the authorization code, verify the id_token against the issuer
 * JWKS (iss/aud/nonce), and return the verified identity.
 */
export async function exchangeCode(
  cfg: OidcConfig,
  code: string,
  login: OidcLoginState,
): Promise<{ email: string; name: string }> {
  const doc = await discover(cfg);
  const res = await fetch(doc.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: cfg.redirectUri,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code_verifier: login.verifier,
    }),
  });
  if (!res.ok) {
    throw new Error(`OIDC token exchange failed: ${res.status}`);
  }
  const { id_token } = (await res.json()) as { id_token?: string };
  if (!id_token) throw new Error('OIDC token response missing id_token');

  const { payload } = await jose.jwtVerify(id_token, jwks!, {
    issuer: doc.issuer,
    audience: cfg.clientId,
  });
  if (payload.nonce !== login.nonce) throw new Error('OIDC nonce mismatch');
  const email = payload.email as string | undefined;
  if (!email) throw new Error('OIDC id_token has no email claim');
  const name = (payload.name as string | undefined) ?? email.split('@')[0];
  return { email, name };
}
