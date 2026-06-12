import Database from 'better-sqlite3';
import type { DocMeta, VersionMeta } from '@markup/sync-core';

/**
 * Metadata store for documents: doc names/paths plus the edit-history
 * version snapshots. Two implementations exist — SQLite (zero-setup local
 * dev, the default) and Postgres (`db-postgres.ts`, selected by
 * `DATABASE_URL`). The interface is async so both backends fit behind it.
 */
export interface MetaStore {
  /** Create tables / run migrations. Call once before serving. */
  init(): Promise<void>;
  create(docId: string, name: string, path?: string): Promise<DocMeta>;
  get(docId: string): Promise<DocMeta | undefined>;
  list(): Promise<DocMeta[]>;
  touch(docId: string): Promise<void>;
  /**
   * Record a version snapshot unless the content is unchanged from the
   * latest one, or the latest one is younger than `minIntervalMs` (so a
   * burst of saves during active typing collapses into one version).
   */
  maybeAddVersion(
    docId: string,
    content: string,
    minIntervalMs?: number,
  ): Promise<boolean>;
  listVersions(docId: string): Promise<VersionMeta[]>;
  getVersionContent(
    docId: string,
    versionId: number,
  ): Promise<string | undefined>;
  close(): Promise<void>;
}

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

/**
 * SQLite implementation. Lives alongside (but separate from) the Hocuspocus
 * SQLite extension's table, which holds the Yjs update blobs.
 */
export class SqliteMetaStore implements MetaStore {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
  }

  async init(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS doc_meta (
        doc_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS doc_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_versions_doc
        ON doc_versions (doc_id, id DESC);
    `);
    // Migration: older databases lack the path column.
    const cols = this.db.prepare('PRAGMA table_info(doc_meta)').all() as Array<{
      name: string;
    }>;
    if (!cols.some((c) => c.name === 'path')) {
      this.db.exec('ALTER TABLE doc_meta ADD COLUMN path TEXT');
    }
  }

  async create(docId: string, name: string, path?: string): Promise<DocMeta> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        'INSERT INTO doc_meta (doc_id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(docId, name, path ?? null, now, now);
    return { docId, name, path, createdAt: now, updatedAt: now };
  }

  async get(docId: string): Promise<DocMeta | undefined> {
    const row = this.db
      .prepare('SELECT * FROM doc_meta WHERE doc_id = ?')
      .get(docId) as MetaRow | undefined;
    return row ? toMeta(row) : undefined;
  }

  async list(): Promise<DocMeta[]> {
    const rows = this.db
      .prepare('SELECT * FROM doc_meta ORDER BY updated_at DESC')
      .all() as MetaRow[];
    return rows.map(toMeta);
  }

  async touch(docId: string): Promise<void> {
    this.db
      .prepare('UPDATE doc_meta SET updated_at = ? WHERE doc_id = ?')
      .run(new Date().toISOString(), docId);
  }

  // --- Edit history (version snapshots) -----------------------------------

  async maybeAddVersion(
    docId: string,
    content: string,
    minIntervalMs = 60_000,
  ): Promise<boolean> {
    const last = this.db
      .prepare(
        'SELECT content, created_at FROM doc_versions WHERE doc_id = ? ORDER BY id DESC LIMIT 1',
      )
      .get(docId) as { content: string; created_at: string } | undefined;

    if (last) {
      if (last.content === content) return false;
      if (Date.now() - Date.parse(last.created_at) < minIntervalMs) return false;
    }

    this.db
      .prepare(
        'INSERT INTO doc_versions (doc_id, content, created_at) VALUES (?, ?, ?)',
      )
      .run(docId, content, new Date().toISOString());
    return true;
  }

  async listVersions(docId: string): Promise<VersionMeta[]> {
    const rows = this.db
      .prepare(
        'SELECT id, created_at, LENGTH(content) AS size FROM doc_versions WHERE doc_id = ? ORDER BY id DESC',
      )
      .all(docId) as Array<{ id: number; created_at: string; size: number }>;
    return rows.map((r) => ({
      id: r.id,
      docId,
      createdAt: r.created_at,
      size: r.size,
    }));
  }

  async getVersionContent(
    docId: string,
    versionId: number,
  ): Promise<string | undefined> {
    const row = this.db
      .prepare('SELECT content FROM doc_versions WHERE doc_id = ? AND id = ?')
      .get(docId, versionId) as { content: string } | undefined;
    return row?.content;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
