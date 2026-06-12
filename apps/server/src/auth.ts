import { createHash, randomBytes } from 'node:crypto';
import type { AuthUser, MeResponse, TokenScope } from '@markup/sync-core';
import type { MetaStore } from './db.js';

/** Ordered scopes: each implies the ones before it. */
export const SCOPES: TokenScope[] = ['read', 'comment', 'suggest', 'write'];

export function isScope(s: unknown): s is TokenScope {
  return SCOPES.includes(s as TokenScope);
}

export function scopeAllows(have: TokenScope, need: TokenScope): boolean {
  return SCOPES.indexOf(have) >= SCOPES.indexOf(need);
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** API tokens are `mkp_` + 48 hex chars; sessions are bare 64 hex chars. */
export const API_TOKEN_PREFIX = 'mkp_';

export function newApiTokenSecret(): string {
  return API_TOKEN_PREFIX + randomBytes(24).toString('hex');
}

export function newSessionSecret(): string {
  return randomBytes(32).toString('hex');
}

export const SESSION_COOKIE = 'markup_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Who a request is acting as.
 * - user: a signed-in human (session cookie) — full scope until per-doc
 *   roles land (milestone 2).
 * - agent: an API token (per-user CLI token or per-agent automation token).
 * - legacy: the shared MARKUP_TOKEN; no identity. Deprecated.
 */
export type Principal =
  | { kind: 'user'; user: AuthUser; scope: 'write' }
  | { kind: 'agent'; user: AuthUser; tokenName: string; scope: TokenScope }
  | { kind: 'legacy'; scope: 'write' };

export function toMeResponse(p: Principal): MeResponse {
  return {
    kind: p.kind,
    scope: p.scope,
    user: p.kind === 'legacy' ? undefined : p.user,
    tokenName: p.kind === 'agent' ? p.tokenName : undefined,
  };
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

/**
 * Resolve credentials to a principal: session cookie first, then bearer
 * (API token or the legacy shared token). Returns null when nothing matches.
 */
export async function resolvePrincipal(
  meta: MetaStore,
  opts: {
    bearer?: string;
    cookieHeader?: string;
    legacyToken?: string;
  },
): Promise<Principal | null> {
  const sessionSecret = parseCookies(opts.cookieHeader)[SESSION_COOKIE];
  if (sessionSecret) {
    const session = await meta.getSession(sha256(sessionSecret));
    if (session && Date.parse(session.expiresAt) > Date.now()) {
      const user = await meta.getUser(session.userId);
      if (user) return { kind: 'user', user, scope: 'write' };
    }
  }

  if (opts.bearer) {
    if (opts.bearer.startsWith(API_TOKEN_PREFIX)) {
      const token = await meta.getApiTokenByHash(sha256(opts.bearer));
      if (token) {
        const user = await meta.getUser(token.userId);
        if (user) {
          return { kind: 'agent', user, tokenName: token.name, scope: token.scope };
        }
      }
    } else if (opts.legacyToken && opts.bearer === opts.legacyToken) {
      return { kind: 'legacy', scope: 'write' };
    }
  }

  return null;
}

/** Create a session for a user; returns the plaintext secret for the cookie. */
export async function startSession(
  meta: MetaStore,
  userId: string,
): Promise<{ secret: string; expiresAt: string }> {
  const secret = newSessionSecret();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await meta.createSession(sha256(secret), userId, expiresAt);
  return { secret, expiresAt };
}

export function sessionCookie(secret: string, opts: { secure: boolean }): string {
  const parts = [
    `${SESSION_COOKIE}=${secret}`,
    'HttpOnly',
    'Path=/',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    'SameSite=Lax',
  ];
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`;
}
