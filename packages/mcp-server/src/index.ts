#!/usr/bin/env node
/**
 * markup-mcp — an MCP server that exposes the Markup agent REST surface as
 * native tools, so Claude Code / other MCP clients can read docs, comment,
 * suggest, and review without hand-rolled curl.
 *
 * This file is just the boot: read config from env, build the client and the
 * tool-registered server (see server.ts), and serve over stdio.
 *
 * Config (env):
 *   MARKUP_SERVER  REST base URL          (default http://localhost:4000)
 *   MARKUP_TOKEN   bearer token           (default dev-token)
 *   MARKUP_AUTHOR  fallback display name on comments/suggestions, used only
 *                  when the token is the legacy shared token (signed-in users
 *                  and per-agent tokens are attributed server-side).
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { MarkupClient } from './client.js';
import { createMcpServer } from './server.js';

const serverUrl = (process.env.MARKUP_SERVER ?? 'http://localhost:4000').replace(/\/$/, '');

const client = new MarkupClient({
  server: serverUrl,
  token: process.env.MARKUP_TOKEN ?? 'dev-token',
});

const server = createMcpServer(client, { defaultAuthor: process.env.MARKUP_AUTHOR });

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the MCP channel; logs must go to stderr.
  console.error(`markup-mcp ready (server ${serverUrl})`);
}

main().catch((err) => {
  console.error('markup-mcp failed to start:', err);
  process.exit(1);
});
