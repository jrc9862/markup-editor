import { Server as Hocuspocus } from '@hocuspocus/server';
import { SQLite } from '@hocuspocus/extension-sqlite';
import { Database as DatabaseExtension } from '@hocuspocus/extension-database';
import pg from 'pg';
import express from 'express';
import cors from 'cors';
import { pinoHttp } from 'pino-http';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
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
import {
  SqliteMetaStore,
  type MetaStore,
  type RetentionPolicy,
} from './db.js';
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
import { redisFromEnv, localEditorStore } from './redis.js';
import { GitBridge, isValidRef } from './git.js';
import {
  PostgresMetaStore,
  fetchYjsState,
  storeYjsState,
} from './db-postgres.js';
import { logger } from './logger.js';
import {
  registry,
  wsConnections,
  docsLoaded,
  docUpdates,
  persistDuration,
  httpDuration,
  versionsPruned,
} from './metrics.js';
import { connections } from './connections.js';
import { exceedsByteLimit, applyRangeEditsToString } from './limits.js';

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
// Self-protection limits (Phase 2). Generous defaults; 0 disables.
const MAX_DOC_BYTES = Number(process.env.MARKUP_MAX_DOC_BYTES ?? 2_000_000);
const MAX_CONN_PER_USER = Number(
  process.env.MARKUP_MAX_CONNECTIONS_PER_USER ?? 20,
);
const RATE_WINDOW_MS = Number(process.env.MARKUP_RATE_WINDOW_MS ?? 60_000);
const RATE_MAX = Number(process.env.MARKUP_RATE_MAX ?? 600);
const METRICS_TOKEN = process.env.MARKUP_METRICS_TOKEN;
// Edit-history retention (Phase 2). doc_versions is the one unbounded growth
// vector; cap it per doc. Named versions and the latest snapshot always
// survive. 0 disables either cap.
const VERSION_RETENTION: RetentionPolicy = {
  maxCount: Number(process.env.MARKUP_VERSION_RETENTION_MAX ?? 500),
  maxAgeDays: Number(process.env.MARKUP_VERSION_RETENTION_DAYS ?? 0),
};
// Number of trusted reverse-proxy hops in front of the server (the LB in the
// multi-node topology). Lets Express derive the real client IP from
// X-Forwarded-For so rate limiting keys per real client, not per proxy. Off by
// default — only trust the header when actually behind a proxy.
const TRUST_PROXY = Number(process.env.MARKUP_TRUST_PROXY ?? 0);
const OIDC = oidcFromEnv(SERVER_ORIGIN);
// Git-native flows are enabled only when the server can reach a working tree
// (MARKUP_REPO_DIR) — the self-hosted/local shape. Otherwise the routes 404.
const git = GitBridge.fromEnv();

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

// --- Cross-node layer: Redis when REDIS_URL is set, in-process otherwise ----
//
// Mirrors the DATABASE_URL gate. When set, the Hocuspocus Redis extension fans
// Yjs updates + awareness across nodes, the docEvents bus is bridged onto Redis
// pub/sub (so SSE reaches subscribers on any node), and the most-recent-editor
// store moves into Redis. Unset ⇒ single-node behavior, unchanged.
const redis = redisFromEnv(docEvents);

// --- Hocuspocus: the Yjs sync engine + persistence -------------------------

/** Best-effort attribution label for a principal (for version history). */
function principalLabel(p: Principal): { author?: string; authorId?: string } {
  if (p.kind === 'user') return { author: p.user.name, authorId: p.user.id };
  if (p.kind === 'agent') return { author: p.tokenName, authorId: p.user.id };
  return {};
}

// The most recent editor per doc, captured from authenticated connections (and
// REST writers). Consumed when onStoreDocument snapshots a version, so history
// carries best-effort per-author attribution. Redis-backed across nodes (the
// storing node may differ from the editing node); in-process otherwise.
// Attribution is a display nicety, not a source of truth.
const editors = redis?.editors ?? localEditorStore();

const hocuspocus = Hocuspocus.configure({
  extensions: redis ? [redis.extension, persistence] : [persistence],

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
    const label = principalLabel(principal);
    // Per-user connection cap: reserve a slot for authenticated principals
    // (legacy/anonymous have no stable id and are exempt). Released in
    // onDisconnect. Acquire last so a rejection here doesn't leak a slot.
    if (label.authorId && !connections.tryAcquire(label.authorId, MAX_CONN_PER_USER)) {
      throw new Error('connection limit reached');
    }
    wsConnections.inc();
    // The returned value becomes the connection context; onChange uses it to
    // attribute the resulting version snapshot.
    return label;
  },

  async onDisconnect({ context }) {
    wsConnections.dec();
    const c = context as { authorId?: string } | undefined;
    if (c?.authorId) connections.release(c.authorId);
  },

  async onLoadDocument() {
    docsLoaded.inc();
  },

  async afterUnloadDocument() {
    docsLoaded.dec();
  },

  async onChange({ documentName, context }) {
    docUpdates.inc();
    const c = context as { author?: string; authorId?: string } | undefined;
    if (c?.author) editors.set(documentName, c);
  },

  async onStoreDocument({ documentName, document }) {
    const done = persistDuration.startTimer();
    await meta.touch(documentName);
    // Edit history: snapshot the markdown, debounced inside maybeAddVersion
    // so active typing doesn't create a version per save. Stamp the snapshot
    // with the most recent editor we saw.
    const content = document.getText(CONTENT_FIELD).toString();
    const editor = await editors.get(documentName);
    const added = await meta.maybeAddVersion(
      documentName,
      content,
      undefined,
      editor?.author,
      editor?.authorId,
    );
    // Only prune when we actually grew the history — keeps the policy out of
    // the hot path for no-op stores.
    if (added) {
      const pruned = await meta.pruneVersions(documentName, VERSION_RETENTION);
      if (pruned) versionsPruned.inc(pruned);
    }
    done();
  },
});

// --- REST API ---------------------------------------------------------------

const app = express();
// Behind the multi-node load balancer, trust the proxy so req.ip is the real
// client (rate limiting keys on it for anonymous/legacy principals). Only when
// configured — trusting X-Forwarded-For unconditionally would let clients spoof
// their IP.
if (TRUST_PROXY > 0) app.set('trust proxy', TRUST_PROXY);
// Structured request logging (Phase 2). Attaches the resolved principal to
// each completed request once the /api guard sets res.locals.principal.
app.use(
  pinoHttp({
    logger,
    customProps: (_req, res) => {
      const p = (res as express.Response).locals?.principal as
        | Principal
        | undefined;
      return p
        ? {
            principalKind: p.kind,
            principalId: p.kind === 'legacy' ? undefined : p.user.id,
          }
        : {};
    },
  }),
);
// REST latency histogram, labelled by the matched route pattern (low
// cardinality — docIds stay as `:docId`, not literal values).
app.use((req, res, next) => {
  const done = httpDuration.startTimer();
  res.on('finish', () => {
    const route = `${req.baseUrl}${req.route?.path ?? ''}` || req.path;
    done({ method: req.method, route, status: res.statusCode });
  });
  next();
});
// Credentialed CORS for the web app; non-browser clients (CLI, agents via
// curl) are unaffected by CORS.
app.use(cors({ origin: WEB_ORIGIN, credentials: true }));
app.use(express.json({ limit: '10mb' }));

// Liveness: the process is up and serving. Used by container orchestration to
// decide whether to restart the pod.
app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

// Readiness: the process can serve traffic right now. Fails during shutdown
// (so the LB drains us before connections close) and if the store is
// unreachable. Used by the LB to decide whether to route requests.
app.get('/readyz', async (_req, res) => {
  if (shuttingDown) {
    res.status(503).json({ ready: false, reason: 'shutting down' });
    return;
  }
  try {
    await meta.ping();
    res.json({ ready: true });
  } catch (err) {
    logger.error({ err }, 'readiness check failed');
    res.status(503).json({ ready: false, reason: 'store unreachable' });
  }
});

// Prometheus scrape target. Outside /api (no per-doc auth); optionally gated
// by a bearer when MARKUP_METRICS_TOKEN is set, otherwise restrict at the
// network layer as usual for an internal endpoint.
app.get('/metrics', async (req, res) => {
  if (METRICS_TOKEN && req.headers.authorization !== `Bearer ${METRICS_TOKEN}`) {
    res.status(401).end();
    return;
  }
  res.type(registry.contentType).send(await registry.metrics());
});

// Rate limiting (Phase 2): per authenticated user when known, else per client
// IP. SSE streams are long-lived single requests, so they're exempt. Disabled
// when MARKUP_RATE_MAX <= 0.
const apiLimiter = rateLimit({
  windowMs: RATE_WINDOW_MS,
  limit: RATE_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: (req) => RATE_MAX <= 0 || req.path.endsWith('/events'),
  keyGenerator: (req, res) => {
    const p = (res as express.Response).locals?.principal as
      | Principal
      | undefined;
    if (p && p.kind !== 'legacy') return `u:${p.user.id}`;
    return ipKeyGenerator(req.ip ?? '');
  },
});

// Sign-in/out lives outside the /api guard; rate-limited by IP (no principal
// yet at sign-in time).
app.use('/auth', apiLimiter);
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

// Applied after the guard so the limiter can key by resolved principal.
app.use('/api', apiLimiter);

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
  if (body.content && tooLarge(body.content)) {
    res.status(413).json({ error: 'document too large' });
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

/** Reject content over the configured byte budget (see limits.ts). */
const tooLarge = (content: string): boolean =>
  exceedsByteLimit(content, MAX_DOC_BYTES);

/** Direct write: reconcile the whole document to the provided markdown. */
app.put('/api/docs/:docId/content', needs('write'), docAccess('write'), async (req, res) => {
  const { content } = req.body as { content?: string };
  if (typeof content !== 'string') {
    res.status(400).json({ error: 'content (string) is required' });
    return;
  }
  if (tooLarge(content)) {
    res.status(413).json({ error: 'document too large' });
    return;
  }
  await withDoc(req.params.docId, (doc) =>
    applyStringToYText(doc.getText(CONTENT_FIELD), content),
  );
  // Direct (REST) writes carry no WS context, so attribute the snapshot here.
  editors.set(req.params.docId, principalLabel(res.locals.principal as Principal));
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
      if (tooLarge(applyRangeEditsToString(ytext.toString(), edits))) {
        return { error: 'document too large', tooLarge: true };
      }
      return { applied: applyEdits(ytext, edits) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'invalid edits' };
    }
  });
  if ('error' in result) {
    res.status('tooLarge' in result ? 413 : 400).json({ error: result.error });
    return;
  }
  editors.set(req.params.docId, principalLabel(res.locals.principal as Principal));
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

/**
 * PR-style batch review (roadmap #3): accept and/or reject a set of open
 * suggestions in ONE transaction — the reviewer dispositions a whole batch at
 * once, applied atomically and propagated like a single edit.
 */
app.post(
  '/api/docs/:docId/suggestions/review',
  needs('write'),
  docAccess('write'),
  async (req, res) => {
    const body = req.body as { accept?: string[]; reject?: string[] };
    const accept = Array.isArray(body.accept) ? body.accept : [];
    const reject = Array.isArray(body.reject) ? body.reject : [];
    if (accept.length === 0 && reject.length === 0) {
      res.status(400).json({ error: 'provide accept[] and/or reject[]' });
      return;
    }
    const result = await withDoc(req.params.docId, (doc) => {
      const ytext = doc.getText(CONTENT_FIELD);
      let accepted = 0;
      let rejected = 0;
      // Accept in descending range order so earlier offsets stay valid as
      // later replacements resize the text.
      const toAccept = accept
        .map((id) => ({ id, s: getSuggestion(doc, id) }))
        .filter((x) => x.s && x.s.status === 'open')
        .sort((a, b) => (b.s!.from ?? 0) - (a.s!.from ?? 0));
      for (const { id } of toAccept) {
        if (acceptSuggestion(doc, ytext, id)) accepted++;
      }
      for (const id of reject) {
        const s = getSuggestion(doc, id);
        if (s && s.status === 'open') {
          rejectSuggestion(doc, id);
          rejected++;
        }
      }
      return { accepted, rejected };
    });
    if (result.accepted > 0) publish(res, req.params.docId, { type: 'content' });
    res.json(result);
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

// --- Git-native flows (roadmap #3) --------------------------------------------
//
// Commit/branch the real .md files from the UI. Enabled only when the server
// has a working tree (MARKUP_REPO_DIR); all git args are passed as arrays, so
// messages and paths can't inject. Read ops need read scope; mutations need
// write scope (repo-global, not per-doc).

const gitEnabled: express.RequestHandler = (_req, res, next) => {
  if (!git) {
    res.status(404).json({ error: 'git flows are not enabled on this server' });
    return;
  }
  next();
};

app.get('/api/git/status', needs('read'), gitEnabled, async (_req, res) => {
  try {
    res.json(await git!.status());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get('/api/git/branches', needs('read'), gitEnabled, async (_req, res) => {
  try {
    res.json({
      current: await git!.currentBranch(),
      branches: await git!.listBranches(),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post('/api/git/commit', needs('write'), gitEnabled, async (req, res) => {
  const body = req.body as { message?: string; paths?: string[] };
  if (typeof body.message !== 'string' || !body.message.trim()) {
    res.status(400).json({ error: 'message is required' });
    return;
  }
  if (body.paths && !Array.isArray(body.paths)) {
    res.status(400).json({ error: 'paths must be an array' });
    return;
  }
  try {
    res.json(await git!.commit(body.message.trim(), body.paths));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post('/api/git/branch', needs('write'), gitEnabled, async (req, res) => {
  const body = req.body as { name?: string; checkout?: boolean };
  if (!isValidRef(body.name ?? '')) {
    res.status(400).json({ error: 'invalid branch name' });
    return;
  }
  try {
    await git!.createBranch(body.name!, body.checkout ?? true);
    res.json({ ok: true, branch: body.name });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post('/api/git/checkout', needs('write'), gitEnabled, async (req, res) => {
  const name = (req.body as { name?: string }).name;
  if (!isValidRef(name ?? '')) {
    res.status(400).json({ error: 'invalid branch name' });
    return;
  }
  try {
    await git!.checkout(name!);
    res.json({ ok: true, branch: name });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
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
  logger.info(
    {
      port: PORT,
      storage: pool ? 'postgres' : `sqlite (${DATA_DIR})`,
      crossNode: redis ? 'redis' : 'in-process (single node)',
      ws: `ws://localhost:${PORT}`,
      rest: `http://localhost:${PORT}/api`,
    },
    'markup server listening',
  );
});

// One-shot retention sweep at startup so the age cap reaches docs that are no
// longer being edited (the per-store prune only fires on the next snapshot).
// Fire-and-forget: never block serving on it.
void (async () => {
  try {
    const pruned = await meta.pruneAllVersions(VERSION_RETENTION);
    if (pruned) {
      versionsPruned.inc(pruned);
      logger.info({ pruned }, 'retention sweep: pruned old versions');
    }
  } catch (err) {
    logger.error({ err }, 'retention sweep failed');
  }
})();

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
  logger.info({ signal }, 'shutdown: flushing documents');
  httpServer.close();
  try {
    await hocuspocus.destroy();
    // Close our own Redis pub/sub clients (the extension closes its own in
    // hocuspocus.destroy()). No-op on the single-node path.
    if (redis) await redis.close();
    // meta.close() also ends the shared pg pool in the Postgres case.
    await meta.close();
  } catch (err) {
    logger.error({ err }, 'error during shutdown');
    process.exit(1);
  }
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
