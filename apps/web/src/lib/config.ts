/**
 * Server endpoints + auth fallback. The session cookie is the real auth for
 * signed-in humans; the bearer token is only a fallback (NEXT_PUBLIC_* values
 * are inlined at build time). No token ships in production builds — the
 * `dev-token` default applies to `next dev` only, matching the `dev:server`
 * script's MARKUP_TOKEN so zero-setup local dev keeps working.
 */
export const SERVER_HTTP =
  process.env.NEXT_PUBLIC_MARKUP_SERVER ?? 'http://localhost:4000';

export const SERVER_WS = SERVER_HTTP.replace(/^http/, 'ws');

export const TOKEN =
  process.env.NEXT_PUBLIC_MARKUP_TOKEN ??
  (process.env.NODE_ENV === 'development' ? 'dev-token' : undefined);

export function authHeaders(): HeadersInit {
  return TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
}
