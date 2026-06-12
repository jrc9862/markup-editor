import pg from 'pg';
import type { DocMeta, VersionMeta } from '@markup/sync-core';
import type { MetaStore } from './db.js';

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

  async close(): Promise<void> {
    await this.pool.end();
  }
}
