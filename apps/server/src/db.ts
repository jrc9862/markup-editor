import Database from 'better-sqlite3';
import type { DocMeta, VersionMeta } from '@markup/sync-core';

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
 * Metadata store for documents. Lives alongside (but separate from) the
 * Hocuspocus SQLite extension's table, which holds the Yjs update blobs.
 */
export class MetaStore {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
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

  create(docId: string, name: string, path?: string): DocMeta {
    const now = new Date().toISOString();
    this.db
      .prepare(
        'INSERT INTO doc_meta (doc_id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(docId, name, path ?? null, now, now);
    return { docId, name, path, createdAt: now, updatedAt: now };
  }

  get(docId: string): DocMeta | undefined {
    const row = this.db
      .prepare('SELECT * FROM doc_meta WHERE doc_id = ?')
      .get(docId) as MetaRow | undefined;
    return row ? toMeta(row) : undefined;
  }

  list(): DocMeta[] {
    const rows = this.db
      .prepare('SELECT * FROM doc_meta ORDER BY updated_at DESC')
      .all() as MetaRow[];
    return rows.map(toMeta);
  }

  touch(docId: string): void {
    this.db
      .prepare('UPDATE doc_meta SET updated_at = ? WHERE doc_id = ?')
      .run(new Date().toISOString(), docId);
  }

  // --- Edit history (version snapshots) -----------------------------------

  /**
   * Record a version snapshot unless the content is unchanged from the
   * latest one, or the latest one is younger than `minIntervalMs` (so a
   * burst of saves during active typing collapses into one version).
   */
  maybeAddVersion(docId: string, content: string, minIntervalMs = 60_000): boolean {
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

  listVersions(docId: string): VersionMeta[] {
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

  getVersionContent(docId: string, versionId: number): string | undefined {
    const row = this.db
      .prepare('SELECT content FROM doc_versions WHERE doc_id = ? AND id = ?')
      .get(docId, versionId) as { content: string } | undefined;
    return row?.content;
  }
}
