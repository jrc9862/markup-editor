#!/usr/bin/env node
/**
 * markup-mcp — an MCP server that exposes the Markup agent REST surface as
 * native tools, so Claude Code / other MCP clients can read docs, comment,
 * suggest, and review without hand-rolled curl.
 *
 * It is a thin wrapper: each tool calls one REST route (apps/server) over a
 * bearer token. The server enforces token scope and per-doc role, so the
 * agent-native default is a `suggest`-scoped token — propose, never write.
 *
 * Config (env):
 *   MARKUP_SERVER  REST base URL          (default http://localhost:4000)
 *   MARKUP_TOKEN   bearer token           (default dev-token)
 *   MARKUP_AUTHOR  fallback display name on comments/suggestions, used only
 *                  when the token is the legacy shared token (signed-in users
 *                  and per-agent tokens are attributed server-side).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { MarkupClient, MarkupError, type Range } from './client.js';

const client = new MarkupClient({
  server: (process.env.MARKUP_SERVER ?? 'http://localhost:4000').replace(/\/$/, ''),
  token: process.env.MARKUP_TOKEN ?? 'dev-token',
});
const defaultAuthor = process.env.MARKUP_AUTHOR;

const server = new McpServer({ name: 'markup-mcp', version: '0.1.0' });

type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

/** Render a tool's value (object → pretty JSON, string → as-is) as MCP text. */
function ok(value: unknown): ToolResult {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text: text || '(empty)' }] };
}

/** Run a handler, turning a server/network error into an MCP error result. */
async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    const message =
      err instanceof MarkupError
        ? err.message
        : `request failed: ${(err as Error).message}`;
    return { content: [{ type: 'text', text: message }], isError: true };
  }
}

// --- Shared input fragments ---------------------------------------------------

const docId = {
  docId: z.string().describe('Document id (the UUID room/slug from list_docs).'),
};

/**
 * A range may be given as character offsets (`from`/`to`) OR by quoting the
 * text to anchor to (`anchorText` + optional 1-based `occurrence`). Quoting is
 * the natural way for an agent to point at a location without counting chars.
 */
const rangeShape = {
  from: z.number().int().optional().describe('Start character offset (with `to`).'),
  to: z.number().int().optional().describe('End character offset (exclusive).'),
  anchorText: z
    .string()
    .optional()
    .describe('Exact text to anchor to, instead of from/to offsets.'),
  occurrence: z
    .number()
    .int()
    .optional()
    .describe('Which occurrence of anchorText (1-based, default 1).'),
};

const author = {
  author: z
    .string()
    .optional()
    .describe('Display name (only used with the legacy shared token).'),
};

function rangeOf(a: {
  from?: number;
  to?: number;
  anchorText?: string;
  occurrence?: number;
}): Range {
  return { from: a.from, to: a.to, anchorText: a.anchorText, occurrence: a.occurrence };
}

// --- Identity & discovery -----------------------------------------------------

server.registerTool(
  'whoami',
  {
    title: 'Whoami',
    description:
      'Return the identity and scope of the configured credentials (kind, scope, user/agent name).',
    inputSchema: {},
  },
  () => run(() => client.me()),
);

server.registerTool(
  'list_docs',
  {
    title: 'List documents',
    description: 'List documents the credentials can see (id, name, path, roles).',
    inputSchema: {},
  },
  () => run(() => client.listDocs()),
);

server.registerTool(
  'get_doc',
  {
    title: 'Get document metadata',
    description: 'Get one document’s metadata, including the caller’s resolved role.',
    inputSchema: { ...docId },
  },
  (a) => run(() => client.getDoc(a.docId)),
);

server.registerTool(
  'read_doc',
  {
    title: 'Read document',
    description: 'Return the document’s current markdown content as plain text.',
    inputSchema: { ...docId },
  },
  (a) => run(() => client.readDoc(a.docId)),
);

server.registerTool(
  'write_doc',
  {
    title: 'Write document',
    description:
      'Replace the whole document with new markdown (minimal-diffed, propagates live). Requires write capability; prefer suggest for agent edits.',
    inputSchema: { ...docId, content: z.string().describe('Full new markdown content.') },
  },
  (a) => run(() => client.writeDoc(a.docId, a.content)),
);

// --- Comments -----------------------------------------------------------------

server.registerTool(
  'list_comments',
  {
    title: 'List comments',
    description: 'List comment threads on a document (with replies and resolution state).',
    inputSchema: { ...docId },
  },
  (a) => run(() => client.listComments(a.docId)),
);

server.registerTool(
  'add_comment',
  {
    title: 'Add comment',
    description:
      'Start a comment thread anchored to a range. Give from/to or anchorText.',
    inputSchema: {
      ...docId,
      ...rangeShape,
      text: z.string().describe('Comment body.'),
      ...author,
    },
  },
  (a) => run(() => client.addComment(a.docId, rangeOf(a), a.text, a.author ?? defaultAuthor)),
);

server.registerTool(
  'reply_comment',
  {
    title: 'Reply to comment',
    description: 'Add a reply to an existing comment thread.',
    inputSchema: {
      ...docId,
      threadId: z.string().describe('Comment thread id (from list_comments).'),
      text: z.string().describe('Reply body.'),
      ...author,
    },
  },
  (a) =>
    run(() => client.replyComment(a.docId, a.threadId, a.text, a.author ?? defaultAuthor)),
);

server.registerTool(
  'resolve_comment',
  {
    title: 'Resolve comment',
    description: 'Mark a comment thread resolved (or reopen it).',
    inputSchema: {
      ...docId,
      threadId: z.string().describe('Comment thread id.'),
      resolved: z.boolean().optional().describe('true to resolve (default), false to reopen.'),
    },
  },
  (a) => run(() => client.resolveComment(a.docId, a.threadId, a.resolved ?? true)),
);

// --- Suggestions --------------------------------------------------------------

server.registerTool(
  'list_suggestions',
  {
    title: 'List suggestions',
    description: 'List suggestions on a document (open/accepted/rejected, with replies).',
    inputSchema: { ...docId },
  },
  (a) => run(() => client.listSuggestions(a.docId)),
);

server.registerTool(
  'suggest',
  {
    title: 'Propose a suggestion',
    description:
      'Propose replacing a range with new text (GitHub-style suggestion a human accepts). Give from/to or anchorText; `original` is derived server-side.',
    inputSchema: {
      ...docId,
      ...rangeShape,
      proposed: z.string().describe('Replacement text for the range.'),
      ...author,
    },
  },
  (a) => run(() => client.suggest(a.docId, rangeOf(a), a.proposed, a.author ?? defaultAuthor)),
);

server.registerTool(
  'update_suggestion',
  {
    title: 'Revise a suggestion',
    description:
      'Revise an open suggestion you authored: re-target it to [from,to) and replace the proposed text.',
    inputSchema: {
      ...docId,
      suggestionId: z.string().describe('Suggestion id (from list_suggestions).'),
      from: z.number().int().describe('New start offset.'),
      to: z.number().int().describe('New end offset (exclusive).'),
      proposed: z.string().describe('New proposed text.'),
    },
  },
  (a) =>
    run(() => client.updateSuggestion(a.docId, a.suggestionId, a.from, a.to, a.proposed)),
);

server.registerTool(
  'withdraw_suggestion',
  {
    title: 'Withdraw a suggestion',
    description: 'Delete an open suggestion you authored.',
    inputSchema: {
      ...docId,
      suggestionId: z.string().describe('Suggestion id.'),
    },
  },
  (a) => run(() => client.withdrawSuggestion(a.docId, a.suggestionId)),
);

server.registerTool(
  'accept_suggestion',
  {
    title: 'Accept a suggestion',
    description:
      'Accept an open suggestion: applies the replacement to the document. Requires write capability.',
    inputSchema: {
      ...docId,
      suggestionId: z.string().describe('Suggestion id.'),
    },
  },
  (a) => run(() => client.acceptSuggestion(a.docId, a.suggestionId)),
);

server.registerTool(
  'reject_suggestion',
  {
    title: 'Reject a suggestion',
    description: 'Reject an open suggestion without applying it. Requires write capability.',
    inputSchema: {
      ...docId,
      suggestionId: z.string().describe('Suggestion id.'),
    },
  },
  (a) => run(() => client.rejectSuggestion(a.docId, a.suggestionId)),
);

server.registerTool(
  'reply_suggestion',
  {
    title: 'Comment on a suggestion',
    description: 'Add a review-discussion reply to a suggestion (like commenting on a PR diff).',
    inputSchema: {
      ...docId,
      suggestionId: z.string().describe('Suggestion id.'),
      text: z.string().describe('Reply body.'),
      ...author,
    },
  },
  (a) =>
    run(() =>
      client.replySuggestion(a.docId, a.suggestionId, a.text, a.author ?? defaultAuthor),
    ),
);

// --- History ------------------------------------------------------------------

server.registerTool(
  'list_versions',
  {
    title: 'List versions',
    description: 'List a document’s saved edit-history versions (id, time, size).',
    inputSchema: { ...docId },
  },
  (a) => run(() => client.listVersions(a.docId)),
);

// --- Boot ---------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the MCP channel; logs must go to stderr.
  console.error(
    `markup-mcp ready (server ${process.env.MARKUP_SERVER ?? 'http://localhost:4000'})`,
  );
}

main().catch((err) => {
  console.error('markup-mcp failed to start:', err);
  process.exit(1);
});
