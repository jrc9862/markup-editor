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
  CONTENT_FIELD,
  addComment,
  addReply,
  setResolved,
  snapshotComments,
  addSuggestion,
  acceptSuggestion,
  rejectSuggestion,
  snapshotSuggestions,
} from '@markup/sync-core';
import type { CreateDocRequest, TokenScope } from '@markup/sync-core';
import { SqliteMetaStore, type MetaStore } from './db.js';
import { resolvePrincipal, scopeAllows, type Principal } from './auth.js';
import { registerAuthRoutes, registerTokenRoutes } from './auth-routes.js';
import { oidcFromEnv } from './oidc.js';
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

const hocuspocus = Hocuspocus.configure({
  extensions: [persistence],

  async onAuthenticate({ token, requestHeaders }) {
    // Session cookie (browser upgrade requests carry it), API token, or the
    // legacy shared token via the provider's token param.
    const principal = await resolvePrincipal(meta, {
      bearer: token,
      cookieHeader: requestHeaders.cookie,
      legacyToken: TOKEN,
    });
    // Live Yjs connections can mutate content, so they need write scope;
    // scoped agent tokens act through REST instead.
    if (!principal || !scopeAllows(principal.scope, 'write')) {
      throw new Error('invalid token');
    }
  },

  async onStoreDocument({ documentName, document }) {
    await meta.touch(documentName);
    // Edit history: snapshot the markdown, debounced inside maybeAddVersion
    // so active typing doesn't create a version per save.
    const content = document.getText(CONTENT_FIELD).toString();
    await meta.maybeAddVersion(documentName, content);
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
    legacyToken: TOKEN,
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

registerTokenRoutes(app, meta);

/** Create a document, optionally seeding it with initial markdown. */
app.post('/api/docs', needs('write'), async (req, res) => {
  const body = req.body as CreateDocRequest;
  if (!body?.name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  const docId = uuidv4();
  const docMeta = await meta.create(docId, body.name, body.path);

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
  res.json(await meta.list());
});

app.get('/api/docs/:docId', needs('read'), async (req, res) => {
  const docMeta = await meta.get(req.params.docId);
  if (!docMeta) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(docMeta);
});

/** Snapshot: the document's current markdown as plain text. */
app.get('/api/docs/:docId/snapshot', needs('read'), async (req, res) => {
  const docMeta = await meta.get(req.params.docId);
  if (!docMeta) {
    res.status(404).json({ error: 'not found' });
    return;
  }
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

const requireDoc: express.RequestHandler = async (req, res, next) => {
  if (!(await meta.get(req.params.docId))) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  next();
};

/** Direct write: reconcile the whole document to the provided markdown. */
app.put('/api/docs/:docId/content', needs('write'), requireDoc, async (req, res) => {
  const { content } = req.body as { content?: string };
  if (typeof content !== 'string') {
    res.status(400).json({ error: 'content (string) is required' });
    return;
  }
  await withDoc(req.params.docId, (doc) =>
    applyStringToYText(doc.getText(CONTENT_FIELD), content),
  );
  res.json({ ok: true });
});

app.get('/api/docs/:docId/comments', needs('read'), requireDoc, async (req, res) => {
  res.json(await withDoc(req.params.docId, (doc) => snapshotComments(doc)));
});

app.post('/api/docs/:docId/comments', needs('comment'), requireDoc, async (req, res) => {
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
  res.status(201).json({ id: result });
});

app.post(
  '/api/docs/:docId/comments/:threadId/replies',
  needs('comment'),
  requireDoc,
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
    res.json({ ok: true });
  },
);

app.post(
  '/api/docs/:docId/comments/:threadId/resolve',
  needs('comment'),
  requireDoc,
  async (req, res) => {
    const resolved = (req.body as { resolved?: boolean }).resolved ?? true;
    await withDoc(req.params.docId, (doc) =>
      setResolved(doc, req.params.threadId, resolved),
    );
    res.json({ ok: true });
  },
);

app.get('/api/docs/:docId/suggestions', needs('read'), requireDoc, async (req, res) => {
  res.json(await withDoc(req.params.docId, (doc) => snapshotSuggestions(doc)));
});

app.post('/api/docs/:docId/suggestions', needs('suggest'), requireDoc, async (req, res) => {
  const body = req.body as RangeBody & { author?: string; proposed?: string };
  const who = authorOf(res, body.author);
  if (!who || typeof body.proposed !== 'string') {
    res.status(400).json({ error: 'author and proposed are required' });
    return;
  }
  const result = await withDoc(req.params.docId, (doc) => {
    const ytext = doc.getText(CONTENT_FIELD);
    const content = ytext.toString();
    const range = resolveRange(content, body);
    if (!range) return null;
    return addSuggestion(doc, ytext, {
      ...range,
      ...who,
      original: content.slice(range.from, range.to),
      proposed: body.proposed!,
    });
  });
  if (!result) {
    res.status(400).json({ error: 'range not found (from/to or anchorText)' });
    return;
  }
  res.status(201).json({ id: result });
});

app.post(
  '/api/docs/:docId/suggestions/:sid/accept',
  needs('write'),
  requireDoc,
  async (req, res) => {
    const ok = await withDoc(req.params.docId, (doc) =>
      acceptSuggestion(doc, doc.getText(CONTENT_FIELD), req.params.sid),
    );
    res.json({ ok });
  },
);

app.post(
  '/api/docs/:docId/suggestions/:sid/reject',
  needs('write'),
  requireDoc,
  async (req, res) => {
    await withDoc(req.params.docId, (doc) =>
      rejectSuggestion(doc, req.params.sid),
    );
    res.json({ ok: true });
  },
);

// --- Edit history -------------------------------------------------------------

app.get('/api/docs/:docId/versions', needs('read'), async (req, res) => {
  if (!(await meta.get(req.params.docId))) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(await meta.listVersions(req.params.docId));
});

app.get('/api/docs/:docId/versions/:versionId', needs('read'), async (req, res) => {
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
app.post('/api/docs/:docId/restore', needs('write'), async (req, res) => {
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
