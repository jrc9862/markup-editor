/** Server endpoints + auth for the MVP (single shared token). */
export const SERVER_HTTP =
  process.env.NEXT_PUBLIC_MARKUP_SERVER ?? 'http://localhost:4000';

export const SERVER_WS = SERVER_HTTP.replace(/^http/, 'ws');

export const TOKEN =
  process.env.NEXT_PUBLIC_MARKUP_TOKEN ?? 'dev-token';

export function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${TOKEN}` };
}
