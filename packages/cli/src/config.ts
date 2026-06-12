/** CLI configuration from environment, with local-dev defaults. */
export const SERVER_HTTP = process.env.MARKUP_SERVER ?? 'http://localhost:4000';
export const SERVER_WS = SERVER_HTTP.replace(/^http/, 'ws');
export const WEB_URL = process.env.MARKUP_WEB ?? 'http://localhost:3000';
export const TOKEN = process.env.MARKUP_TOKEN ?? 'dev-token';
