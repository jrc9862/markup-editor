import { Server as Hocuspocus } from '@hocuspocus/server';
import { SQLite } from '@hocuspocus/extension-sqlite';
import { Database as DatabaseExtension } from '@hocuspocus/extension-database';
import pg from 'pg';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import type * as Y from 'yjs';
import {
  applyStringToYText,
  applyEdits,
  findReplaceEdits,
  type RangeEdit,
  CONTENT_FIELD,
  addComment,
  addReply,
  addSuggestionReply,
  getSuggestion,
  removeSuggestion,
  updateSuggestion,
  setResolved,
  snapshotComments,
  addSuggestion,
  acceptSuggestion,
  rejectSuggestion,
  snapshotSuggestions,
} from '@markup/sync-core';
import type { CreateDocRequest, DocMeta, TokenScope } from '@markup/sync-core';
import { SqliteMetaStore, type MetaStore } from './db.js';
import {
  effectiveScope,
  isRole,
  resolvePrincipal,
  roleFor,
  scopeAllows,
  type Principal,
} from './auth.js';
import { registerAuthRoutes, registerTokenRoutes } from './auth-routes.js';
import { oidcFromEnv } from './oidc.js';
import { docEvents, extractMentions, type DocEvent } from './events.js';
import {
  PostgresMetaStore,
  fetchYjsState,
  storeYjsState,
} from './db-postgres.js';

const PORT = Number(process.env.PORT ?? 4000);
const TOKEN = process.env.MARKUP_TOKEN ?? 'dev-token';
const DATA_DIR = process.env.MARKUP_DATA_DIR ?? '.';
const DATABASE_URL = process.env.DATABASE_URL;
const WEB_ORIGIN = process.env.MARKUP_WEB_ORIGIN ?? 'http://localhost:3000';
// When set, the legacy shared token stops working: every request must be a
// session or an API token. The end state for enterprise deployments.
const REQUIRE_AUTH = process.env.MARKUP_REQUIRE_AUTH === '1';
const LEGACY_TOKEN = REQUIRE_AUTH ? undefined : TOKEN;
const SERVER_ORIGIN =
  process.env.MARKUP_SERVER_ORIGIN ?? `http://localhost:${PORT}`;
const OIDC = oidcFromEnv(SERVER_ORIGIN);

// --- Data layer: Postgres when DATABASE_URL is set, SQLite otherwise --------
//
// SQLite is the zero-setup local-dev default; Postgres is the production
// path (one pool shared by Yjs persistence and the meta store).

const pool = DATABASE_URL
  ? new pg.Pool({ connectionString: DATABASE_URL })
  : null;

const meta: MetaStore = pool
  ? new PostgresMetaStore(pool)
  : new SqliteMetaStore(`${DATA_DIR}/markup-meta.sqlite`);
await meta.init();

const persistence = pool
  ? new DatabaseExtension({
      fetch: ({ documentName }) => fetchYjsState(pool, documentName),
      store: async ({ documentName, state }) => {
        await storeYjsState(pool, documentName, state);
      },
    })
  : new SQLite({ database: `${DATA_DIR}/markup-docs.sqlite` });

// --- Hocuspocus: the Yjs sync engine + persistence -------------------------

/** Best-effort attribution label for a principal (for version history). */
function principalLabel(p: Principal): { author?: string; authorId?: string } {
  if (p.kind === 'user') return { author: p.user.name, authorId: p.user.id };
  if (p.kind === 'agent') return { author: p.tokenName, authorId: p.user.id };
  return {};
}

// The most recent editor per doc, captured from authenticated connections (and
// REST writers). Consumed when onStoreDocument snapshots a version, so history
// carries best-effort per-author attribution. In-memory only — attribution is
// a display nicety, not a source of truth.
const lastEditor = new Map<string, { author?: string; authorId?: string }>();

const hocuspocus = Hocuspocus.configure({
  extensions: [persistence],

  async onAuthenticate({ token, requestHeaders, documentName, connection }) {
    // Session cookie (browser upgrade requests carry it), API token, or the
    // legacy shared token via the provider's token param.
    const principal = await resolvePrincipal(meta, {
      bearer: token,
      cookieHeader: requestHeaders.cookie,
      legacyToken: LEGACY_TOKEN,
    });
    if (!principal) throw new Error('invalid token');

    const doc = await meta.get(documentName);
    const scope = doc
      ? await effectiveScope(meta, principal, doc)
      : // No metadata (doc not registered yet): write-capable tokens only.
        (scopeAllows(principal.scope, 'write') ? 'write' : null);
    if (scope === null) throw new Error('no access');
    // Below write capability the connection is read-only: Hocuspocus drops
    // incoming doc updates server-side. Suggester/commenter roles act
    // through the REST surface instead.
    if (!scopeAllows(scope, 'write')) connection.readOnly = true;
    // The returned value becomes the connection context; onChange uses it to
    // attribute the resulting version snapshot.
    return principalLabel(principal);
  },

  async onChange({ documentName, context }) {
    const c = context as { author?: string; authorId?: string } | undefined;
    if (c?.author) lastEditor.set(documentName, c);
  },

  async onStoreDocument({ documentName, document }) {
    await meta.touch(documentName);
    // Edit history: snapshot the markdown, debounced inside maybeAddVersion
    // so active typing doesn't create a version per save. Stamp the snapshot
    // with the most recent editor we saw.
    const content = document.getText(CONTENT_FIELD).toString();
    const editor = lastEditor.get(documentName);
    await meta.maybeAddVersion(
      documentName,
      content,
      undefined,
      editor?.author,
      editor?.authorId,
    );
  },
});

// --- REST API ---------------------------------------------------------------

const app = express();
// Credentialed CORS for the web app; non-browser clients (CLI, agents via
// curl) are unaffected by CORS.
app.use(cors({ origin: WEB_ORIGIN, credentials: true }));
app.use(express.json({ limit: '10mb' }));

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

// Sign-in/out lives outside the /api guard.
registerAuthRoutes(app, meta, {
  oidc: OIDC,
  webOrigin: WEB_ORIGIN,
  secureCookies: SERVER_ORIGIN.startsWith('https'),
});

/** Auth guard for all /api routes: resolves the acting principal. */
app.use('/api', async (req, res, next) => {
  const header = req.headers.authorization ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : undefined;
  const principal = await resolvePrincipal(meta, {
    bearer,
    cookieHeader: req.headers.cookie,
    legacyToken: LEGACY_TOKEN,
  });
  if (!principal) {
    res.status(401).json({ error: 'invalid token' });
    return;
  }
  res.locals.principal = principal;
  next();
});

/** Per-route scope check (scopes are ordered; see auth.ts). */
const needs =
  (scope: TokenScope): express.RequestHandler =>
  (_req, res, next) => {
    const p = res.locals.principal as Principal;
    if (!scopeAllows(p.scope, scope)) {
      res.status(403).json({ error: `requires ${scope} scope` });
      return;
    }
    next();
  };

/**
 * Attribution: signed-in humans are stamped with their real identity
 * (self-reported names ignored); agent tokens may label themselves but
 * keep the owning user's id; the legacy token must self-report (as before).
 */
function authorOf(
  res: express.Response,
  bodyAuthor?: string,
): { author: string; authorId?: string } | null {
  const p = res.locals.principal as Principal;
  if (p.kind === 'user') return { author: p.user.name, authorId: p.user.id };
  if (p.kind === 'agent') {
    return { author: bodyAuthor ?? p.tokenName, authorId: p.user.id };
  }
  return bodyAuthor ? { author: bodyAuthor } : null;
}

/**
 * Publish a realtime doc event (consumed by SSE subscribers), stamping the
 * timestamp and whether the actor is an agent principal.
 */
function publish(
  res: express.Response,
  docId: string,
  ev: Omit<DocEvent, 'docId' | 'ts' | 'agent'>,
): void {
  const p = res.locals.principal as Principal;
  docEvents.publish({
    docId,
    ts: new Date().toISOString(),
    agent: p.kind === 'agent',
    ...ev,
  });
}

/** Emit a mention event for each @handle found in `text`. */
function publishMentions(
  res: express.Response,
  docId: string,
  text: string,
  who: { author: string; authorId?: string },
): void {
  for (const mention of extractMentions(text)) {
    publish(res, docId, { type: 'mention', mention, text, ...who });
  }
}

/**
 * Doc-level gate: 404 unless the doc exists, 403 unless the principal's
 * effective capability (weaker of token scope and doc role) covers `scope`.
 * Stashes the doc meta in res.locals for the handler.
 */
const docAccess =
  (scope: TokenScope): express.RequestHandler =>
  async (req, res, next) => {
    const doc = await meta.get(req.params.docId);
    if (!doc) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const p = res.locals.principal as Principal;
    const effective = await effectiveScope(meta, p, doc);
    if (effective === null || !scopeAllows(effective, scope)) {
      res.status(403).json({ error: `requires ${scope} access to this doc` });
      return;
    }
    res.locals.docMeta = doc;
    next();
  };

registerTokenRoutes(app, meta);

/** Create a document, optionally seeding it with initial markdown. */
app.post('/api/docs', needs('write'), async (req, res) => {
  const body = req.body as CreateDocRequest;
  if (!body?.name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  const docId = uuidv4();
  const p = res.locals.principal as Principal;
  const docMeta = await meta.create(
    docId,
    body.name,
    body.path,
    p.kind === 'legacy' ? undefined : p.user.id,
  );

  if (body.content) {
    // Seed the Yjs doc through a direct (server-side) connection so the
    // content is persisted exactly like a normal client edit would be.
    const conn = await hocuspocus.openDirectConnection(docId);
    await conn.transact((doc) => {
      const ytext = doc.getText(CONTENT_FIELD);
      applyStringToYText(ytext, body.content!);
    });
    await conn.disconnect();
  }

  res.status(201).json(docMeta);
});

app.get('/api/docs', needs('read'), async (_req, res) => {
  const p = res.locals.principal as Principal;
  const all = await meta.list();
  const visible: typeof all = [];
  for (const doc of all) {
    if ((await effectiveScope(meta, p, doc)) !== null) visible.push(doc);
  }
  res.json(visible);
});

app.get('/api/docs/:docId', needs('read'), docAccess('read'), async (_req, res) => {
  const docMeta = res.locals.docMeta as DocMeta;
  const p = res.locals.principal as Principal;
  res.json({ ...docMeta, myRole: await roleFor(meta, p, docMeta) });
});

/**
 * Normalize a caller-supplied relative path to the manifest/tree convention:
 * forward slashes, no leading slash, no `..` traversal. Returns null on a
 * path that escapes the tree (the CLI writes these paths to disk).
 */
function cleanRelPath(p: string): string | null {
  if (p.includes('\0')) return null;
  const norm = p.replace(/\\/g, '/').replace(/^\/+/, '');
  if (norm.split('/').some((seg) => seg === '..')) return null;
  return norm;
}

/**
 * Rename / re-path a doc (UI topbar, doc-list, or `markup mv`). Editors and
 * above (write capability) may rename; the new path mirrors the file's
 * location on disk so the directory-tree browser stays in sync.
 */
app.patch('/api/docs/:docId', needs('write'), docAccess('write'), async (req, res) => {
  const body = req.body as { name?: string; path?: string };
  const fields: { name?: string; path?: string } = {};
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) {
      res.status(400).json({ error: 'name must be a non-empty string' });
      return;
    }
    fields.name = body.name.trim();
  }
  if (body.path !== undefined) {
    if (typeof body.path !== 'string') {
      res.status(400).json({ error: 'path must be a string' });
      return;
    }
    const clean = cleanRelPath(body.path);
    if (clean === null) {
      res.status(400).json({ error: 'invalid path' });
      return;
    }
    fields.path = clean;
  }
  if (fields.name === undefined && fields.path === undefined) {
    res.status(400).json({ error: 'name or path is required' });
    return;
  }
  const updated = await meta.rename(req.params.docId, fields);
  if (!updated) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const p = res.locals.principal as Principal;
  res.json({ ...updated, myRole: await roleFor(meta, p, updated) });
});

/** Snapshot: the document's current markdown as plain text. */
app.get('/api/docs/:docId/snapshot', needs('read'), docAccess('read'), async (req, res) => {
  const conn = await hocuspocus.openDirectConnection(req.params.docId);
  let content = '';
  await conn.transact((doc) => {
    content = doc.getText(CONTENT_FIELD).toString();
  });
  await conn.disconnect();
  res.type('text/markdown').send(content);
});

// --- Agent surface: annotations + content over plain REST ---------------------
//
// Agents are a designed-for audience, not an afterthought: everything a
// human can do in the UI is reachable with curl. Routes operate on the live
// Y.Doc via a direct server-side connection, so agent actions propagate to
// every connected human (and the CLI daemon) in realtime. Ranges can be
// given as character offsets OR by quoting the text to anchor to
// (`anchorText` + optional `occurrence`), which is the natural way for an
// LLM to reference a location.

/** Run `fn` against a doc's live state; changes sync like any client edit. */
async function withDoc<T>(docId: string, fn: (doc: Y.Doc) => T): Promise<T> {
  const conn = await hocuspocus.openDirectConnection(docId);
  let result!: T;
  await conn.transact((doc) => {
    result = fn(doc as unknown as Y.Doc);
  });
  await conn.disconnect();
  return result;
}

interface RangeBody {
  from?: number;
  to?: number;
  anchorText?: string;
  occurrence?: number;
}

function resolveRange(
  content: string,
  body: RangeBody,
): { from: number; to: number } | null {
  if (typeof body.from === 'number' && typeof body.to === 'number') {
    if (body.from < 0 || body.to > content.length || body.to < body.from) {
      return null;
    }
    return { from: body.from, to: body.to };
  }
  if (body.anchorText) {
    let idx = -1;
    for (let n = body.occurrence ?? 1; n > 0; n--) {
      idx = content.indexOf(body.anchorText, idx + 1);
      if (idx < 0) return null;
    }
    return { from: idx, to: idx + body.anchorText.length };
  }
  return null;
}

/** Direct write: reconcile the whole document to the provided markdown. */
app.put('/api/docs/:docId/content', needs('write'), docAccess('write'), async (req, res) => {
  const { content } = req.body as { content?: string };
  if (typeof content !== 'string') {
    res.status(400).json({ error: 'content (string) is required' });
    return;
  }
  await withDoc(req.params.docId, (doc) =>
    applyStringToYText(doc.getText(CONTENT_FIELD), content),
  );
  // Direct (REST) writes carry no WS context, so attribute the snapshot here.
  lastEditor.set(req.params.docId, principalLabel(res.locals.principal as Principal));
  publish(res, req.params.docId, { type: 'content' });
  res.json({ ok: true });
});

/**
 * Multi-edits (roadmap #1): batch find/replace or an explicit list of range
 * replacements applied as ONE transaction — one undoable step that still
 * merges cleanly with concurrent peers. Body is either:
 *   { find, replace, regex?, caseSensitive? }   — find/replace across the doc
 *   { edits: [{ from, to, insert }, ...] }       — explicit ranges
 */
app.post('/api/docs/:docId/edits', needs('write'), docAccess('write'), async (req, res) => {
  const body = req.body as {
    find?: string;
    replace?: string;
    regex?: boolean;
    caseSensitive?: boolean;
    edits?: RangeEdit[];
  };
  const hasFind = typeof body.find === 'string';
  const hasEdits = Array.isArray(body.edits);
  if (hasFind === hasEdits) {
    res.status(400).json({ error: 'provide exactly one of {find,replace} or {edits}' });
    return;
  }
  if (hasEdits) {
    for (const e of body.edits!) {
      if (
        typeof e?.from !== 'number' ||
        typeof e?.to !== 'number' ||
        typeof e?.insert !== 'string'
      ) {
        res.status(400).json({ error: 'each edit needs from, to, insert' });
        return;
      }
    }
  }
  const result = await withDoc(req.params.docId, (doc) => {
    const ytext = doc.getText(CONTENT_FIELD);
    const edits = hasEdits
      ? body.edits!
      : findReplaceEdits(ytext.toString(), body.find!, body.replace ?? '', {
          regex: body.regex,
          caseSensitive: body.caseSensitive,
        });
    try {
      return { applied: applyEdits(ytext, edits) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'invalid edits' };
    }
  });
  if ('error' in result) {
    res.status(400).json(result);
    return;
  }
  lastEditor.set(req.params.docId, principalLabel(res.locals.principal as Principal));
  publish(res, req.params.docId, { type: 'content' });
  res.json(result);
});

app.get('/api/docs/:docId/comments', needs('read'), docAccess('read'), async (req, res) => {
  res.json(await withDoc(req.params.docId, (doc) => snapshotComments(doc)));
});

app.post('/api/docs/:docId/comments', needs('comment'), docAccess('comment'), async (req, res) => {
  const body = req.body as RangeBody & { author?: string; text?: string };
  const who = authorOf(res, body.author);
  if (!who || !body.text) {
    res.status(400).json({ error: 'author and text are required' });
    return;
  }
  const result = await withDoc(req.params.docId, (doc) => {
    const ytext = doc.getText(CONTENT_FIELD);
    const range = resolveRange(ytext.toString(), body);
    if (!range) return null;
    return addComment(doc, ytext, { ...range, ...who, text: body.text! });
  });
  if (!result) {
    res.status(400).json({ error: 'range not found (from/to or anchorText)' });
    return;
  }
  publish(res, req.params.docId, { type: 'comment', threadId: result, text: body.text, ...who });
  publishMentions(res, req.params.docId, body.text, who);
  res.status(201).json({ id: result });
});

app.post(
  '/api/docs/:docId/comments/:threadId/replies',
  needs('comment'),
  docAccess('comment'),
  async (req, res) => {
    const { author, text } = req.body as { author?: string; text?: string };
    const who = authorOf(res, author);
    if (!who || !text) {
      res.status(400).json({ error: 'author and text are required' });
      return;
    }
    await withDoc(req.params.docId, (doc) =>
      addReply(doc, req.params.threadId, { ...who, text }),
    );
    publish(res, req.params.docId, {
      type: 'comment.reply',
      threadId: req.params.threadId,
      text,
      ...who,
    });
    publishMentions(res, req.params.docId, text, who);
    res.json({ ok: true });
  },
);

app.post(
  '/api/docs/:docId/comments/:threadId/resolve',
  needs('comment'),
  docAccess('comment'),
  async (req, res) => {
    const resolved = (req.body as { resolved?: boolean }).resolved ?? true;
    await withDoc(req.params.docId, (doc) =>
      setResolved(doc, req.params.threadId, resolved),
    );
    publish(res, req.params.docId, {
      type: 'comment.resolve',
      threadId: req.params.threadId,
    });
    res.json({ ok: true });
  },
);

app.get('/api/docs/:docId/suggestions', needs('read'), docAccess('read'), async (req, res) => {
  res.json(await withDoc(req.params.docId, (doc) => snapshotSuggestions(doc)));
});

/**
 * Realtime event stream (SSE) for a doc — the agent-native alternative to
 * polling. Subscribers (agents or the web) receive comments, suggestions,
 * reviews, mentions, and edits as they happen. Requires read access; a
 * heartbeat comment keeps proxies from closing an idle stream.
 */
app.get('/api/docs/:docId/events', needs('read'), docAccess('read'), (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  const unsubscribe = docEvents.subscribe(req.params.docId, (e) => {
    res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  });
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

app.post('/api/docs/:docId/suggestions', needs('suggest'), docAccess('suggest'), async (req, res) => {
  const body = req.body as RangeBody & {
    id?: string;
    author?: string;
    proposed?: string;
  };
  const who = authorOf(res, body.author);
  if (!who || typeof body.proposed !== 'string') {
    res.status(400).json({ error: 'author and proposed are required' });
    return;
  }
  // Optional caller-supplied id lets optimistic clients (the suggester
  // role's realtime suggesting) reconcile the echo with their local state.
  if (body.id !== undefined && !/^[a-zA-Z0-9_-]{6,64}$/.test(body.id)) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  const result = await withDoc(req.params.docId, (doc) => {
    if (body.id && getSuggestion(doc, body.id)) return 'conflict' as const;
    const ytext = doc.getText(CONTENT_FIELD);
    const content = ytext.toString();
    const range = resolveRange(content, body);
    if (!range) return null;
    return addSuggestion(doc, ytext, {
      id: body.id,
      ...range,
      ...who,
      original: content.slice(range.from, range.to),
      proposed: body.proposed!,
    });
  });
  if (result === 'conflict') {
    res.status(409).json({ error: 'suggestion id already exists' });
    return;
  }
  if (!result) {
    res.status(400).json({ error: 'range not found (from/to or anchorText)' });
    return;
  }
  publish(res, req.params.docId, { type: 'suggestion', suggestionId: result, ...who });
  res.status(201).json({ id: result });
});

/**
 * A suggestion's author may update or withdraw it while open (this powers
 * realtime suggesting for the suggester role); write capability may touch
 * any suggestion.
 */
const canTouchSuggestion = (
  res: express.Response,
  s: { authorId?: string },
): boolean => {
  const p = res.locals.principal as Principal;
  if (p.kind === 'legacy') return true;
  if (scopeAllows(p.scope, 'write')) {
    // Token allows writes, but the doc role must too — docAccess('suggest')
    // already ran, so check the role here via stashed meta.
    return true;
  }
  return s.authorId === p.user.id;
};

app.put(
  '/api/docs/:docId/suggestions/:sid',
  needs('suggest'),
  docAccess('suggest'),
  async (req, res) => {
    const body = req.body as { from?: number; to?: number; proposed?: string };
    if (
      typeof body.from !== 'number' ||
      typeof body.to !== 'number' ||
      typeof body.proposed !== 'string'
    ) {
      res.status(400).json({ error: 'from, to and proposed are required' });
      return;
    }
    const result = await withDoc(req.params.docId, (doc) => {
      const existing = getSuggestion(doc, req.params.sid);
      if (!existing || existing.status !== 'open') return 'missing' as const;
      if (!canTouchSuggestion(res, existing)) return 'forbidden' as const;
      const ytext = doc.getText(CONTENT_FIELD);
      const max = ytext.length;
      if (body.from! < 0 || body.to! > max || body.to! < body.from!) {
        return 'range' as const;
      }
      updateSuggestion(doc, ytext, req.params.sid, {
        from: body.from!,
        to: body.to!,
        proposed: body.proposed!,
      });
      return 'ok' as const;
    });
    if (result === 'missing') {
      res.status(404).json({ error: 'not found' });
      return;
    }
    if (result === 'forbidden') {
      res.status(403).json({ error: 'not your suggestion' });
      return;
    }
    if (result === 'range') {
      res.status(400).json({ error: 'range out of bounds' });
      return;
    }
    publish(res, req.params.docId, {
      type: 'suggestion.update',
      suggestionId: req.params.sid,
    });
    res.json({ ok: true });
  },
);

app.delete(
  '/api/docs/:docId/suggestions/:sid',
  needs('suggest'),
  docAccess('suggest'),
  async (req, res) => {
    const result = await withDoc(req.params.docId, (doc) => {
      const existing = getSuggestion(doc, req.params.sid);
      if (!existing || existing.status !== 'open') return 'missing' as const;
      if (!canTouchSuggestion(res, existing)) return 'forbidden' as const;
      removeSuggestion(doc, req.params.sid);
      return 'ok' as const;
    });
    if (result === 'missing') {
      res.status(404).json({ error: 'not found' });
      return;
    }
    if (result === 'forbidden') {
      res.status(403).json({ error: 'not your suggestion' });
      return;
    }
    res.json({ ok: true });
  },
);

/** Review discussion on a suggestion (like commenting on a PR diff). */
app.post(
  '/api/docs/:docId/suggestions/:sid/replies',
  needs('comment'),
  docAccess('comment'),
  async (req, res) => {
    const { author, text } = req.body as { author?: string; text?: string };
    const who = authorOf(res, author);
    if (!who || !text) {
      res.status(400).json({ error: 'author and text are required' });
      return;
    }
    const ok = await withDoc(req.params.docId, (doc) =>
      addSuggestionReply(doc, req.params.sid, { ...who, text }),
    );
    if (!ok) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    publish(res, req.params.docId, {
      type: 'suggestion.reply',
      suggestionId: req.params.sid,
      text,
      ...who,
    });
    publishMentions(res, req.params.docId, text, who);
    res.json({ ok: true });
  },
);

app.post(
  '/api/docs/:docId/suggestions/:sid/accept',
  needs('write'),
  docAccess('write'),
  async (req, res) => {
    const ok = await withDoc(req.params.docId, (doc) =>
      acceptSuggestion(doc, doc.getText(CONTENT_FIELD), req.params.sid),
    );
    publish(res, req.params.docId, {
      type: 'suggestion.accept',
      suggestionId: req.params.sid,
    });
    res.json({ ok });
  },
);

app.post(
  '/api/docs/:docId/suggestions/:sid/reject',
  needs('write'),
  docAccess('write'),
  async (req, res) => {
    await withDoc(req.params.docId, (doc) =>
      rejectSuggestion(doc, req.params.sid),
    );
    publish(res, req.params.docId, {
      type: 'suggestion.reject',
      suggestionId: req.params.sid,
    });
    res.json({ ok: true });
  },
);

// --- Sharing / permissions (owner only) ---------------------------------------

const ownerOnly: express.RequestHandler = async (req, res, next) => {
  const doc = await meta.get(req.params.docId);
  if (!doc) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const p = res.locals.principal as Principal;
  if ((await roleFor(meta, p, doc)) !== 'owner') {
    res.status(403).json({ error: 'only the owner can manage permissions' });
    return;
  }
  res.locals.docMeta = doc;
  next();
};

/**
 * After a permission change, close the doc's live connections: providers
 * auto-reconnect, onAuthenticate re-resolves the role (new read-only state
 * or rejection), and the web client refetches myRole on reconnect.
 */
function kickDocConnections(docId: string): void {
  hocuspocus.closeConnections(docId);
}

app.get('/api/docs/:docId/permissions', ownerOnly, async (req, res) => {
  const doc = res.locals.docMeta as DocMeta;
  res.json({
    ownerId: doc.ownerId,
    owner: doc.ownerId ? await meta.getUser(doc.ownerId) : undefined,
    linkRole: doc.linkRole ?? 'editor',
    entries: await meta.listAcl(req.params.docId),
  });
});

/** Grant a role to a user by email or id. */
app.post('/api/docs/:docId/permissions', ownerOnly, async (req, res) => {
  const body = req.body as { email?: string; userId?: string; role?: string };
  if (!isRole(body.role)) {
    res.status(400).json({
      error: 'role must be editor|suggester|commenter|viewer',
    });
    return;
  }
  const user = body.userId
    ? await meta.getUser(body.userId)
    : body.email
      ? await meta.getUserByEmail(body.email)
      : undefined;
  if (!user) {
    res.status(404).json({ error: 'no such user' });
    return;
  }
  await meta.setAclRole(req.params.docId, user.id, body.role);
  kickDocConnections(req.params.docId);
  res.json({ userId: user.id, role: body.role });
});

app.delete(
  '/api/docs/:docId/permissions/:userId',
  ownerOnly,
  async (req, res) => {
    const ok = await meta.removeAclRole(req.params.docId, req.params.userId);
    if (!ok) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    kickDocConnections(req.params.docId);
    res.json({ ok: true });
  },
);

/** Set the role granted by the share link ('none' makes the doc private). */
app.put('/api/docs/:docId/permissions/link', ownerOnly, async (req, res) => {
  const role = (req.body as { role?: string }).role;
  if (role !== 'none' && !isRole(role)) {
    res.status(400).json({
      error: 'role must be editor|suggester|commenter|viewer|none',
    });
    return;
  }
  await meta.setLinkRole(req.params.docId, role as never);
  kickDocConnections(req.params.docId);
  res.json({ ok: true });
});

// --- Edit history -------------------------------------------------------------

app.get('/api/docs/:docId/versions', needs('read'), docAccess('read'), async (req, res) => {
  res.json(await meta.listVersions(req.params.docId));
});

/** Give a version a human-friendly name (editorial action → write). */
app.put('/api/docs/:docId/versions/:versionId', needs('write'), docAccess('write'), async (req, res) => {
  const name = (req.body as { name?: string })?.name;
  if (typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: 'name (non-empty string) is required' });
    return;
  }
  const ok = await meta.nameVersion(
    req.params.docId,
    Number(req.params.versionId),
    name.trim(),
  );
  if (!ok) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json({ ok: true });
});

app.get('/api/docs/:docId/versions/:versionId', needs('read'), docAccess('read'), async (req, res) => {
  const content = await meta.getVersionContent(
    req.params.docId,
    Number(req.params.versionId),
  );
  if (content === undefined) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.type('text/markdown').send(content);
});

/**
 * Restore a version: reconcile the live doc to the stored content via a
 * minimal diff, so it flows to every connected client (and the CLI) like a
 * normal edit — and is itself undoable via history.
 */
app.post('/api/docs/:docId/restore', needs('write'), docAccess('write'), async (req, res) => {
  const versionId = Number((req.body as { versionId?: number })?.versionId);
  const content = await meta.getVersionContent(req.params.docId, versionId);
  if (content === undefined) {
    res.status(404).json({ error: 'version not found' });
    return;
  }
  const conn = await hocuspocus.openDirectConnection(req.params.docId);
  await conn.transact((doc) => {
    applyStringToYText(doc.getText(CONTENT_FIELD), content);
  });
  await conn.disconnect();
  res.json({ ok: true });
});

// --- Single port: HTTP for REST, WS upgrade for Yjs sync --------------------

const httpServer = app.listen(PORT, () => {
  console.log(`markup server listening on http://localhost:${PORT}`);
  console.log(`  storage:        ${pool ? 'postgres' : `sqlite (${DATA_DIR})`}`);
  console.log(`  WS (Yjs sync):  ws://localhost:${PORT}`);
  console.log(`  REST:           http://localhost:${PORT}/api`);
});

const wss = new WebSocketServer({ noServer: true });
httpServer.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    hocuspocus.handleConnection(ws, request);
  });
});

// Graceful shutdown (docker stop / SIGTERM): hocuspocus.destroy() flushes
// every loaded doc through onStoreDocument before we close the stores.
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, flushing documents...`);
  httpServer.close();
  try {
    await hocuspocus.destroy();
    // meta.close() also ends the shared pg pool in the Postgres case.
    await meta.close();
  } catch (err) {
    console.error('error during shutdown', err);
    process.exit(1);
  }
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
