import Database from 'better-sqlite3';
import type {
  AclEntry,
  ApiTokenMeta,
  AuthUser,
  DocMeta,
  DocRole,
  TokenScope,
  VersionMeta,
} from '@markup/sync-core';

export interface SessionRow {
  userId: string;
  expiresAt: string;
}

export interface ApiTokenRow {
  id: string;
  userId: string;
  name: string;
  scope: TokenScope;
}

/**
 * Metadata store for documents: doc names/paths plus the edit-history
 * version snapshots. Two implementations exist — SQLite (zero-setup local
 * dev, the default) and Postgres (`db-postgres.ts`, selected by
 * `DATABASE_URL`). The interface is async so both backends fit behind it.
 */
export interface MetaStore {
  /** Create tables / run migrations. Call once before serving. */
  init(): Promise<void>;
  create(
    docId: string,
    name: string,
    path?: string,
    ownerId?: string,
  ): Promise<DocMeta>;
  get(docId: string): Promise<DocMeta | undefined>;
  list(): Promise<DocMeta[]>;
  touch(docId: string): Promise<void>;
  /** Rename / re-path a doc; returns the updated meta (undefined if gone). */
  rename(
    docId: string,
    fields: { name?: string; path?: string },
  ): Promise<DocMeta | undefined>;
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

  // --- Identity (Phase 1). Sessions and API tokens store sha256 hashes only.
  /** Insert by email, or refresh the name on an existing user. */
  upsertUser(id: string, email: string, name: string): Promise<AuthUser>;
  getUser(id: string): Promise<AuthUser | undefined>;
  getUserByEmail(email: string): Promise<AuthUser | undefined>;
  createSession(
    tokenHash: string,
    userId: string,
    expiresAt: string,
  ): Promise<void>;
  getSession(tokenHash: string): Promise<SessionRow | undefined>;
  deleteSession(tokenHash: string): Promise<void>;
  createApiToken(t: ApiTokenRow & { tokenHash: string }): Promise<void>;
  /** Look up by hash and bump last_used_at. */
  getApiTokenByHash(tokenHash: string): Promise<ApiTokenRow | undefined>;
  listApiTokens(userId: string): Promise<ApiTokenMeta[]>;
  deleteApiToken(userId: string, id: string): Promise<boolean>;

  // --- Per-doc roles (Phase 1 milestone 2)
  getAclRole(docId: string, userId: string): Promise<DocRole | undefined>;
  setAclRole(docId: string, userId: string, role: DocRole): Promise<void>;
  removeAclRole(docId: string, userId: string): Promise<boolean>;
  listAcl(docId: string): Promise<AclEntry[]>;
  setLinkRole(docId: string, role: DocRole | 'none'): Promise<void>;

  close(): Promise<void>;
}

interface MetaRow {
  doc_id: string;
  name: string;
  path: string | null;
  created_at: string;
  updated_at: string;
  owner_id: string | null;
  link_role: string | null;
}

function toMeta(row: MetaRow): DocMeta {
  return {
    docId: row.doc_id,
    name: row.name,
    path: row.path ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ownerId: row.owner_id ?? undefined,
    linkRole: (row.link_role as DocMeta['linkRole']) ?? undefined,
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
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS api_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        scope TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS doc_acl (
        doc_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        PRIMARY KEY (doc_id, user_id)
      );
    `);
    // Migrations: older databases lack these doc_meta columns.
    const cols = this.db.prepare('PRAGMA table_info(doc_meta)').all() as Array<{
      name: string;
    }>;
    for (const [col, ddl] of [
      ['path', 'ALTER TABLE doc_meta ADD COLUMN path TEXT'],
      ['owner_id', 'ALTER TABLE doc_meta ADD COLUMN owner_id TEXT'],
      ['link_role', 'ALTER TABLE doc_meta ADD COLUMN link_role TEXT'],
    ] as const) {
      if (!cols.some((c) => c.name === col)) this.db.exec(ddl);
    }
  }

  async create(
    docId: string,
    name: string,
    path?: string,
    ownerId?: string,
  ): Promise<DocMeta> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        'INSERT INTO doc_meta (doc_id, name, path, created_at, updated_at, owner_id) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(docId, name, path ?? null, now, now, ownerId ?? null);
    return { docId, name, path, createdAt: now, updatedAt: now, ownerId };
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

  async rename(
    docId: string,
    fields: { name?: string; path?: string },
  ): Promise<DocMeta | undefined> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (fields.name !== undefined) {
      sets.push('name = ?');
      vals.push(fields.name);
    }
    if (fields.path !== undefined) {
      sets.push('path = ?');
      vals.push(fields.path);
    }
    if (sets.length) {
      sets.push('updated_at = ?');
      vals.push(new Date().toISOString());
      vals.push(docId);
      this.db
        .prepare(`UPDATE doc_meta SET ${sets.join(', ')} WHERE doc_id = ?`)
        .run(...vals);
    }
    return this.get(docId);
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

  // --- Identity -------------------------------------------------------------

  async upsertUser(id: string, email: string, name: string): Promise<AuthUser> {
    const existing = this.db
      .prepare('SELECT * FROM users WHERE email = ?')
      .get(email) as
      | { id: string; email: string; name: string; created_at: string }
      | undefined;
    if (existing) {
      if (existing.name !== name) {
        this.db
          .prepare('UPDATE users SET name = ? WHERE id = ?')
          .run(name, existing.id);
      }
      return {
        id: existing.id,
        email: existing.email,
        name,
        createdAt: existing.created_at,
      };
    }
    const now = new Date().toISOString();
    this.db
      .prepare(
        'INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(id, email, name, now);
    return { id, email, name, createdAt: now };
  }

  async getUser(id: string): Promise<AuthUser | undefined> {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as
      | { id: string; email: string; name: string; created_at: string }
      | undefined;
    return row
      ? { id: row.id, email: row.email, name: row.name, createdAt: row.created_at }
      : undefined;
  }

  async createSession(
    tokenHash: string,
    userId: string,
    expiresAt: string,
  ): Promise<void> {
    this.db
      .prepare(
        'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      )
      .run(tokenHash, userId, new Date().toISOString(), expiresAt);
  }

  async getSession(tokenHash: string): Promise<SessionRow | undefined> {
    const row = this.db
      .prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?')
      .get(tokenHash) as { user_id: string; expires_at: string } | undefined;
    return row ? { userId: row.user_id, expiresAt: row.expires_at } : undefined;
  }

  async deleteSession(tokenHash: string): Promise<void> {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  async createApiToken(t: ApiTokenRow & { tokenHash: string }): Promise<void> {
    this.db
      .prepare(
        'INSERT INTO api_tokens (id, user_id, name, scope, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(t.id, t.userId, t.name, t.scope, t.tokenHash, new Date().toISOString());
  }

  async getApiTokenByHash(tokenHash: string): Promise<ApiTokenRow | undefined> {
    const row = this.db
      .prepare('SELECT id, user_id, name, scope FROM api_tokens WHERE token_hash = ?')
      .get(tokenHash) as
      | { id: string; user_id: string; name: string; scope: TokenScope }
      | undefined;
    if (!row) return undefined;
    this.db
      .prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?')
      .run(new Date().toISOString(), row.id);
    return { id: row.id, userId: row.user_id, name: row.name, scope: row.scope };
  }

  async listApiTokens(userId: string): Promise<ApiTokenMeta[]> {
    const rows = this.db
      .prepare(
        'SELECT id, name, scope, created_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC',
      )
      .all(userId) as Array<{
      id: string;
      name: string;
      scope: TokenScope;
      created_at: string;
      last_used_at: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      scope: r.scope,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at ?? undefined,
    }));
  }

  async deleteApiToken(userId: string, id: string): Promise<boolean> {
    const res = this.db
      .prepare('DELETE FROM api_tokens WHERE user_id = ? AND id = ?')
      .run(userId, id);
    return res.changes > 0;
  }

  async getUserByEmail(email: string): Promise<AuthUser | undefined> {
    const row = this.db
      .prepare('SELECT * FROM users WHERE email = ?')
      .get(email) as
      | { id: string; email: string; name: string; created_at: string }
      | undefined;
    return row
      ? { id: row.id, email: row.email, name: row.name, createdAt: row.created_at }
      : undefined;
  }

  // --- Per-doc roles ----------------------------------------------------------

  async getAclRole(docId: string, userId: string): Promise<DocRole | undefined> {
    const row = this.db
      .prepare('SELECT role FROM doc_acl WHERE doc_id = ? AND user_id = ?')
      .get(docId, userId) as { role: DocRole } | undefined;
    return row?.role;
  }

  async setAclRole(docId: string, userId: string, role: DocRole): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO doc_acl (doc_id, user_id, role) VALUES (?, ?, ?)
         ON CONFLICT (doc_id, user_id) DO UPDATE SET role = excluded.role`,
      )
      .run(docId, userId, role);
  }

  async removeAclRole(docId: string, userId: string): Promise<boolean> {
    const res = this.db
      .prepare('DELETE FROM doc_acl WHERE doc_id = ? AND user_id = ?')
      .run(docId, userId);
    return res.changes > 0;
  }

  async listAcl(docId: string): Promise<AclEntry[]> {
    return this.db
      .prepare(
        `SELECT a.user_id AS userId, a.role, u.email, u.name
         FROM doc_acl a LEFT JOIN users u ON u.id = a.user_id
         WHERE a.doc_id = ? ORDER BY u.email`,
      )
      .all(docId) as AclEntry[];
  }

  async setLinkRole(docId: string, role: DocRole | 'none'): Promise<void> {
    this.db
      .prepare('UPDATE doc_meta SET link_role = ? WHERE doc_id = ?')
      .run(role, docId);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
