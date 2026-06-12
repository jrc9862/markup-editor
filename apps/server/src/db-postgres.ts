import pg from 'pg';
import type {
  ApiTokenMeta,
  AuthUser,
  DocMeta,
  TokenScope,
  VersionMeta,
} from '@markup/sync-core';
import type { ApiTokenRow, MetaStore, SessionRow } from './db.js';

/**
 * Ordered, additive migrations — append only, never edit a shipped entry.
 * Applied under an advisory lock so concurrent server nodes can't race.
 * Timestamps stay ISO-8601 TEXT for parity with the SQLite store (DocMeta
 * carries strings).
 */
const MIGRATIONS: string[] = [
  `CREATE TABLE doc_meta (
     doc_id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     path TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE TABLE doc_versions (
     id BIGSERIAL PRIMARY KEY,
     doc_id TEXT NOT NULL,
     content TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
  `CREATE INDEX idx_versions_doc ON doc_versions (doc_id, id DESC)`,
  // Yjs document state for the Hocuspocus Database extension (the Postgres
  // equivalent of extension-sqlite's "documents" table).
  `CREATE TABLE documents (
     name TEXT PRIMARY KEY,
     data BYTEA NOT NULL
   )`,
  // Phase 1 identity: users, sessions, per-user/agent API tokens.
  `CREATE TABLE users (
     id TEXT PRIMARY KEY,
     email TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
  `CREATE TABLE sessions (
     token_hash TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     created_at TEXT NOT NULL,
     expires_at TEXT NOT NULL
   )`,
  `CREATE TABLE api_tokens (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     name TEXT NOT NULL,
     scope TEXT NOT NULL,
     token_hash TEXT NOT NULL UNIQUE,
     created_at TEXT NOT NULL,
     last_used_at TEXT
   )`,
];

const MIGRATION_LOCK_KEY = 0x6d61726b; // arbitrary app-wide advisory lock id

export async function runMigrations(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [
      MIGRATION_LOCK_KEY,
    ]);
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INT PRIMARY KEY)',
    );
    const { rows } = await client.query<{ version: number }>(
      'SELECT version FROM schema_migrations',
    );
    const applied = new Set(rows.map((r) => Number(r.version)));
    for (let i = 0; i < MIGRATIONS.length; i++) {
      if (applied.has(i)) continue;
      await client.query(MIGRATIONS[i]);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [
        i,
      ]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// --- Yjs persistence (Hocuspocus Database extension callbacks) --------------

export async function fetchYjsState(
  pool: pg.Pool,
  documentName: string,
): Promise<Uint8Array | null> {
  const { rows } = await pool.query<{ data: Buffer }>(
    'SELECT data FROM documents WHERE name = $1',
    [documentName],
  );
  return rows[0] ? new Uint8Array(rows[0].data) : null;
}

export async function storeYjsState(
  pool: pg.Pool,
  documentName: string,
  state: Buffer,
): Promise<void> {
  await pool.query(
    `INSERT INTO documents (name, data) VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE SET data = EXCLUDED.data`,
    [documentName, state],
  );
}

// --- Meta store ---------------------------------------------------------------

interface MetaRow {
  doc_id: string;
  name: string;
  path: string | null;
  created_at: string;
  updated_at: string;
}

function toMeta(row: MetaRow): DocMeta {
  return {
    docId: row.doc_id,
    name: row.name,
    path: row.path ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PostgresMetaStore implements MetaStore {
  constructor(private pool: pg.Pool) {}

  async init(): Promise<void> {
    await runMigrations(this.pool);
  }

  async create(docId: string, name: string, path?: string): Promise<DocMeta> {
    const now = new Date().toISOString();
    await this.pool.query(
      'INSERT INTO doc_meta (doc_id, name, path, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)',
      [docId, name, path ?? null, now, now],
    );
    return { docId, name, path, createdAt: now, updatedAt: now };
  }

  async get(docId: string): Promise<DocMeta | undefined> {
    const { rows } = await this.pool.query<MetaRow>(
      'SELECT * FROM doc_meta WHERE doc_id = $1',
      [docId],
    );
    return rows[0] ? toMeta(rows[0]) : undefined;
  }

  async list(): Promise<DocMeta[]> {
    const { rows } = await this.pool.query<MetaRow>(
      'SELECT * FROM doc_meta ORDER BY updated_at DESC',
    );
    return rows.map(toMeta);
  }

  async touch(docId: string): Promise<void> {
    await this.pool.query('UPDATE doc_meta SET updated_at = $1 WHERE doc_id = $2', [
      new Date().toISOString(),
      docId,
    ]);
  }

  async maybeAddVersion(
    docId: string,
    content: string,
    minIntervalMs = 60_000,
  ): Promise<boolean> {
    const { rows } = await this.pool.query<{
      content: string;
      created_at: string;
    }>(
      'SELECT content, created_at FROM doc_versions WHERE doc_id = $1 ORDER BY id DESC LIMIT 1',
      [docId],
    );
    const last = rows[0];
    if (last) {
      if (last.content === content) return false;
      if (Date.now() - Date.parse(last.created_at) < minIntervalMs) return false;
    }
    await this.pool.query(
      'INSERT INTO doc_versions (doc_id, content, created_at) VALUES ($1, $2, $3)',
      [docId, content, new Date().toISOString()],
    );
    return true;
  }

  async listVersions(docId: string): Promise<VersionMeta[]> {
    const { rows } = await this.pool.query<{
      id: string;
      created_at: string;
      size: string;
    }>(
      'SELECT id, created_at, LENGTH(content) AS size FROM doc_versions WHERE doc_id = $1 ORDER BY id DESC',
      [docId],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      docId,
      createdAt: r.created_at,
      size: Number(r.size),
    }));
  }

  async getVersionContent(
    docId: string,
    versionId: number,
  ): Promise<string | undefined> {
    const { rows } = await this.pool.query<{ content: string }>(
      'SELECT content FROM doc_versions WHERE doc_id = $1 AND id = $2',
      [docId, versionId],
    );
    return rows[0]?.content;
  }

  // --- Identity -------------------------------------------------------------

  async upsertUser(id: string, email: string, name: string): Promise<AuthUser> {
    const { rows } = await this.pool.query<{
      id: string;
      email: string;
      name: string;
      created_at: string;
    }>(
      `INSERT INTO users (id, email, name, created_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, email, name, created_at`,
      [id, email, name, new Date().toISOString()],
    );
    const r = rows[0];
    return { id: r.id, email: r.email, name: r.name, createdAt: r.created_at };
  }

  async getUser(id: string): Promise<AuthUser | undefined> {
    const { rows } = await this.pool.query<{
      id: string;
      email: string;
      name: string;
      created_at: string;
    }>('SELECT id, email, name, created_at FROM users WHERE id = $1', [id]);
    const r = rows[0];
    return r
      ? { id: r.id, email: r.email, name: r.name, createdAt: r.created_at }
      : undefined;
  }

  async createSession(
    tokenHash: string,
    userId: string,
    expiresAt: string,
  ): Promise<void> {
    await this.pool.query(
      'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)',
      [tokenHash, userId, new Date().toISOString(), expiresAt],
    );
  }

  async getSession(tokenHash: string): Promise<SessionRow | undefined> {
    const { rows } = await this.pool.query<{
      user_id: string;
      expires_at: string;
    }>('SELECT user_id, expires_at FROM sessions WHERE token_hash = $1', [
      tokenHash,
    ]);
    const r = rows[0];
    return r ? { userId: r.user_id, expiresAt: r.expires_at } : undefined;
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE token_hash = $1', [
      tokenHash,
    ]);
  }

  async createApiToken(t: ApiTokenRow & { tokenHash: string }): Promise<void> {
    await this.pool.query(
      'INSERT INTO api_tokens (id, user_id, name, scope, token_hash, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [t.id, t.userId, t.name, t.scope, t.tokenHash, new Date().toISOString()],
    );
  }

  async getApiTokenByHash(tokenHash: string): Promise<ApiTokenRow | undefined> {
    const { rows } = await this.pool.query<{
      id: string;
      user_id: string;
      name: string;
      scope: TokenScope;
    }>(
      `UPDATE api_tokens SET last_used_at = $2 WHERE token_hash = $1
       RETURNING id, user_id, name, scope`,
      [tokenHash, new Date().toISOString()],
    );
    const r = rows[0];
    return r
      ? { id: r.id, userId: r.user_id, name: r.name, scope: r.scope }
      : undefined;
  }

  async listApiTokens(userId: string): Promise<ApiTokenMeta[]> {
    const { rows } = await this.pool.query<{
      id: string;
      name: string;
      scope: TokenScope;
      created_at: string;
      last_used_at: string | null;
    }>(
      'SELECT id, name, scope, created_at, last_used_at FROM api_tokens WHERE user_id = $1 ORDER BY created_at DESC',
      [userId],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      scope: r.scope,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at ?? undefined,
    }));
  }

  async deleteApiToken(userId: string, id: string): Promise<boolean> {
    const res = await this.pool.query(
      'DELETE FROM api_tokens WHERE user_id = $1 AND id = $2',
      [userId, id],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
