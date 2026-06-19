/**
 * Tool registrations for the markup MCP server. Kept separate from the stdio
 * boot (index.ts) so tests can drive the same McpServer over an in-memory
 * transport with a client whose fetch is mocked.
 *
 * Each tool is a thin call into MarkupClient (one REST route). The markup
 * server enforces token scope and per-doc role, so a tool the credentials
 * aren't allowed to use simply surfaces the server's 403 as an error result.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MarkupClient, MarkupError, type Range } from './client.js';

export interface ServerOptions {
  /**
   * Fallback display name on comments/suggestions, used only with the legacy
   * shared token (signed-in users and per-agent tokens are attributed
   * server-side).
   */
  defaultAuthor?: string;
}

type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

/** Render a tool's value (object → pretty JSON, string → as-is) as MCP text. */
export function ok(value: unknown): ToolResult {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text: text || '(empty)' }] };
}

/** Run a handler, turning a server/network error into an MCP error result. */
export async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
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

/** Build an McpServer with all markup tools registered against `client`. */
export function createMcpServer(
  client: MarkupClient,
  opts: ServerOptions = {},
): McpServer {
  const defaultAuthor = opts.defaultAuthor;
  const server = new McpServer({ name: 'markup-mcp', version: '0.1.0' });

  // --- Identity & discovery ---------------------------------------------------

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

  // --- Comments ---------------------------------------------------------------

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
    (a) =>
      run(() => client.addComment(a.docId, rangeOf(a), a.text, a.author ?? defaultAuthor)),
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
      run(() =>
        client.replyComment(a.docId, a.threadId, a.text, a.author ?? defaultAuthor),
      ),
  );

  server.registerTool(
    'resolve_comment',
    {
      title: 'Resolve comment',
      description: 'Mark a comment thread resolved (or reopen it).',
      inputSchema: {
        ...docId,
        threadId: z.string().describe('Comment thread id.'),
        resolved: z
          .boolean()
          .optional()
          .describe('true to resolve (default), false to reopen.'),
      },
    },
    (a) => run(() => client.resolveComment(a.docId, a.threadId, a.resolved ?? true)),
  );

  // --- Suggestions ------------------------------------------------------------

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
    (a) =>
      run(() => client.suggest(a.docId, rangeOf(a), a.proposed, a.author ?? defaultAuthor)),
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

  // --- Multi-edits ------------------------------------------------------------

  server.registerTool(
    'find_replace',
    {
      title: 'Find and replace',
      description:
        'Replace every match of `find` with `replace` across the document in ONE atomic edit. Plain substring by default; set regex for a JS RegExp (with $1.. backrefs). Requires write capability.',
      inputSchema: {
        ...docId,
        find: z.string().describe('Text or regex to search for.'),
        replace: z.string().describe('Replacement text ($1.. backrefs in regex mode).'),
        regex: z.boolean().optional().describe('Treat `find` as a regular expression.'),
        caseSensitive: z.boolean().optional().describe('Case-sensitive match (default false).'),
      },
    },
    (a) =>
      run(() =>
        client.multiEdit(a.docId, {
          find: a.find,
          replace: a.replace,
          regex: a.regex,
          caseSensitive: a.caseSensitive,
        }),
      ),
  );

  server.registerTool(
    'multi_edit',
    {
      title: 'Multi-edit',
      description:
        'Apply a batch of explicit range replacements (offsets into the current text) as ONE atomic, undoable edit. Edits must not overlap. Requires write capability.',
      inputSchema: {
        ...docId,
        edits: z
          .array(
            z.object({
              from: z.number().int().describe('Start offset.'),
              to: z.number().int().describe('End offset (exclusive).'),
              insert: z.string().describe('Replacement text.'),
            }),
          )
          .describe('Non-overlapping range replacements.'),
      },
    },
    (a) => run(() => client.multiEdit(a.docId, { edits: a.edits })),
  );

  server.registerTool(
    'review_suggestions',
    {
      title: 'Batch-review suggestions',
      description:
        'Accept and/or reject a set of open suggestions in one atomic review. Requires write capability.',
      inputSchema: {
        ...docId,
        accept: z.array(z.string()).optional().describe('Suggestion ids to accept.'),
        reject: z.array(z.string()).optional().describe('Suggestion ids to reject.'),
      },
    },
    (a) => run(() => client.reviewSuggestions(a.docId, a.accept ?? [], a.reject ?? [])),
  );

  // --- Git-native flows -------------------------------------------------------

  server.registerTool(
    'git_status',
    {
      title: 'Git status',
      description:
        'Current branch and working-tree status (enabled only when the server has a repo: MARKUP_REPO_DIR).',
      inputSchema: {},
    },
    () => run(() => client.gitStatus()),
  );

  server.registerTool(
    'git_commit',
    {
      title: 'Git commit',
      description:
        'Stage and commit the .md files (all changes, or just `paths`). Requires write capability.',
      inputSchema: {
        message: z.string().describe('Commit message.'),
        paths: z.array(z.string()).optional().describe('Specific paths to commit.'),
      },
    },
    (a) => run(() => client.gitCommit(a.message, a.paths)),
  );

  server.registerTool(
    'git_branch',
    {
      title: 'Git branch',
      description: 'Create a branch (and check it out by default). Requires write capability.',
      inputSchema: {
        name: z.string().describe('New branch name.'),
        checkout: z.boolean().optional().describe('Check it out (default true).'),
      },
    },
    (a) => run(() => client.gitBranch(a.name, a.checkout ?? true)),
  );

  // --- Events -----------------------------------------------------------------

  server.registerTool(
    'watch_events',
    {
      title: 'Watch document events',
      description:
        'Subscribe to the document’s realtime event stream and return events (comments, suggestions, reviews, @mentions, edits) until the timeout or max count is reached — instead of polling.',
      inputSchema: {
        ...docId,
        timeoutMs: z
          .number()
          .int()
          .optional()
          .describe('Max time to wait for events in ms (default 25000).'),
        max: z
          .number()
          .int()
          .optional()
          .describe('Stop after this many events (default 50).'),
      },
    },
    (a) =>
      run(() =>
        client.watchEvents(a.docId, { timeoutMs: a.timeoutMs, max: a.max }),
      ),
  );

  // --- History ----------------------------------------------------------------

  server.registerTool(
    'list_versions',
    {
      title: 'List versions',
      description: 'List a document’s saved edit-history versions (id, time, size, name, author).',
      inputSchema: { ...docId },
    },
    (a) => run(() => client.listVersions(a.docId)),
  );

  return server;
}

/** Names of every tool the server registers (for documentation and tests). */
export const TOOL_NAMES = [
  'whoami',
  'list_docs',
  'get_doc',
  'read_doc',
  'write_doc',
  'list_comments',
  'add_comment',
  'reply_comment',
  'resolve_comment',
  'list_suggestions',
  'suggest',
  'update_suggestion',
  'withdraw_suggestion',
  'accept_suggestion',
  'reject_suggestion',
  'reply_suggestion',
  'review_suggestions',
  'find_replace',
  'multi_edit',
  'watch_events',
  'git_status',
  'git_commit',
  'git_branch',
  'list_versions',
] as const;
