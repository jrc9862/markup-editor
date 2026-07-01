import Database from 'better-sqlite3';
import type {
  AclEntry,
  ApiTokenMeta,
  AuthUser,
  DocMeta,
  DocRole,
  TokenScope,
  VersionMeta,
  Workspace,
  WorkspaceMember,
  WorkspaceRole,
  WorkspaceWithRole,
} from '@markup/sync-core';

export interface SessionRow {
  userId: string;
  expiresAt: string;
}

/**
 * Edit-history retention policy (Phase 2). `doc_versions` is the one
 * genuinely unbounded growth vector in this storage model (a full-content
 * snapshot is appended every ~60s of active editing), so it gets a retention
 * cap. Both limits are independently disable-able; user-named versions and
 * the single most-recent version are always kept.
 */
export interface RetentionPolicy {
  /** Keep at most this many versions per doc (newest wins); `<=0` disables. */
  maxCount: number;
  /** Drop versions older than this many days; `<=0` disables. */
  maxAgeDays: number;
}

/** A retention policy that prunes nothing — used to short-circuit when both caps are off. */
export function retentionDisabled(p: RetentionPolicy): boolean {
  return p.maxCount <= 0 && p.maxAgeDays <= 0;
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
    workspaceId?: string,
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
    author?: string,
    authorId?: string,
  ): Promise<boolean>;
  listVersions(docId: string): Promise<VersionMeta[]>;
  getVersionContent(
    docId: string,
    versionId: number,
  ): Promise<string | undefined>;
  /** Give a version a human label; returns false if the version is gone. */
  nameVersion(
    docId: string,
    versionId: number,
    name: string,
  ): Promise<boolean>;
  /**
   * Enforce the retention policy for one doc's version history. Never deletes
   * a user-named version or the single most-recent version. Returns the
   * number of versions pruned.
   */
  pruneVersions(docId: string, policy: RetentionPolicy): Promise<number>;
  /** Apply `pruneVersions` across every doc (a startup sweep so the age cap
   * also reaches docs that are no longer being edited). Returns total pruned. */
  pruneAllVersions(policy: RetentionPolicy): Promise<number>;

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

  // --- Workspaces (Phase 3). A doc may belong to one workspace; membership
  // grants a baseline doc role and admins act as owner (see auth.roleFor).
  createWorkspace(
    id: string,
    name: string,
    slug: string,
    defaultRole: DocRole,
  ): Promise<Workspace>;
  getWorkspace(id: string): Promise<Workspace | undefined>;
  getWorkspaceBySlug(slug: string): Promise<Workspace | undefined>;
  /** Workspaces the user belongs to, each with the user's membership role. */
  listWorkspacesForUser(userId: string): Promise<WorkspaceWithRole[]>;
  updateWorkspace(
    id: string,
    fields: { name?: string; defaultRole?: DocRole },
  ): Promise<Workspace | undefined>;
  /** Delete a workspace and detach its docs (workspace_id -> NULL). */
  deleteWorkspace(id: string): Promise<boolean>;
  /** Add or update a membership. */
  addMember(
    workspaceId: string,
    userId: string,
    role: WorkspaceRole,
  ): Promise<void>;
  getMembership(
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceRole | undefined>;
  listMembers(workspaceId: string): Promise<WorkspaceMember[]>;
  /** Count members at a given role (used to guard the last admin). */
  countMembersWithRole(
    workspaceId: string,
    role: WorkspaceRole,
  ): Promise<number>;
  removeMember(workspaceId: string, userId: string): Promise<boolean>;
  /** Move a doc into a workspace (or `null` to detach it). */
  setDocWorkspace(docId: string, workspaceId: string | null): Promise<void>;

  /** Readiness probe: round-trips a trivial query, throws if unreachable. */
  ping(): Promise<void>;
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
  workspace_id: string | null;
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
    workspaceId: row.workspace_id ?? undefined,
  };
}

interface WorkspaceRow {
  id: string;
  name: string;
  slug: string;
  default_role: string;
  created_at: string;
}

function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    defaultRole: row.default_role as DocRole,
    createdAt: row.created_at,
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
        created_at TEXT NOT NULL,
        name TEXT,
        author TEXT,
        author_id TEXT
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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        default_role TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspace_members (
        workspace_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, user_id)
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
      ['workspace_id', 'ALTER TABLE doc_meta ADD COLUMN workspace_id TEXT'],
    ] as const) {
      if (!cols.some((c) => c.name === col)) this.db.exec(ddl);
    }
    // Older doc_versions tables lack named-version / attribution columns.
    const vcols = this.db
      .prepare('PRAGMA table_info(doc_versions)')
      .all() as Array<{ name: string }>;
    for (const [col, ddl] of [
      ['name', 'ALTER TABLE doc_versions ADD COLUMN name TEXT'],
      ['author', 'ALTER TABLE doc_versions ADD COLUMN author TEXT'],
      ['author_id', 'ALTER TABLE doc_versions ADD COLUMN author_id TEXT'],
    ] as const) {
      if (!vcols.some((c) => c.name === col)) this.db.exec(ddl);
    }
  }

  async create(
    docId: string,
    name: string,
    path?: string,
    ownerId?: string,
    workspaceId?: string,
  ): Promise<DocMeta> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        'INSERT INTO doc_meta (doc_id, name, path, created_at, updated_at, owner_id, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(docId, name, path ?? null, now, now, ownerId ?? null, workspaceId ?? null);
    return {
      docId,
      name,
      path,
      createdAt: now,
      updatedAt: now,
      ownerId,
      workspaceId,
    };
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
    author?: string,
    authorId?: string,
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
        'INSERT INTO doc_versions (doc_id, content, created_at, author, author_id) VALUES (?, ?, ?, ?, ?)',
      )
      .run(docId, content, new Date().toISOString(), author ?? null, authorId ?? null);
    return true;
  }

  async listVersions(docId: string): Promise<VersionMeta[]> {
    const rows = this.db
      .prepare(
        'SELECT id, created_at, name, author, author_id, LENGTH(content) AS size FROM doc_versions WHERE doc_id = ? ORDER BY id DESC',
      )
      .all(docId) as Array<{
      id: number;
      created_at: string;
      name: string | null;
      author: string | null;
      author_id: string | null;
      size: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      docId,
      createdAt: r.created_at,
      size: r.size,
      name: r.name ?? undefined,
      author: r.author ?? undefined,
      authorId: r.author_id ?? undefined,
    }));
  }

  async nameVersion(
    docId: string,
    versionId: number,
    name: string,
  ): Promise<boolean> {
    const res = this.db
      .prepare('UPDATE doc_versions SET name = ? WHERE doc_id = ? AND id = ?')
      .run(name, docId, versionId);
    return res.changes > 0;
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

  async pruneVersions(docId: string, policy: RetentionPolicy): Promise<number> {
    if (retentionDisabled(policy)) return 0;
    const ageCutoff =
      policy.maxAgeDays > 0
        ? new Date(Date.now() - policy.maxAgeDays * 86_400_000).toISOString()
        : null;
    // Delete unnamed versions that breach either cap, but never the single
    // most-recent version (so a doc always keeps one restorable point).
    const res = this.db
      .prepare(
        `DELETE FROM doc_versions
         WHERE doc_id = @doc
           AND name IS NULL
           AND id <> (SELECT id FROM doc_versions WHERE doc_id = @doc ORDER BY id DESC LIMIT 1)
           AND (
                 (@maxCount > 0 AND id NOT IN (
                    SELECT id FROM doc_versions WHERE doc_id = @doc ORDER BY id DESC LIMIT @maxCount))
              OR (@ageCutoff IS NOT NULL AND created_at < @ageCutoff)
           )`,
      )
      .run({ doc: docId, maxCount: policy.maxCount, ageCutoff });
    return res.changes;
  }

  async pruneAllVersions(policy: RetentionPolicy): Promise<number> {
    if (retentionDisabled(policy)) return 0;
    const docs = this.db
      .prepare('SELECT DISTINCT doc_id FROM doc_versions')
      .all() as Array<{ doc_id: string }>;
    let total = 0;
    for (const d of docs) total += await this.pruneVersions(d.doc_id, policy);
    return total;
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

  // --- Workspaces -------------------------------------------------------------

  async createWorkspace(
    id: string,
    name: string,
    slug: string,
    defaultRole: DocRole,
  ): Promise<Workspace> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        'INSERT INTO workspaces (id, name, slug, default_role, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, name, slug, defaultRole, now);
    return { id, name, slug, defaultRole, createdAt: now };
  }

  async getWorkspace(id: string): Promise<Workspace | undefined> {
    const row = this.db
      .prepare('SELECT * FROM workspaces WHERE id = ?')
      .get(id) as WorkspaceRow | undefined;
    return row ? toWorkspace(row) : undefined;
  }

  async getWorkspaceBySlug(slug: string): Promise<Workspace | undefined> {
    const row = this.db
      .prepare('SELECT * FROM workspaces WHERE slug = ?')
      .get(slug) as WorkspaceRow | undefined;
    return row ? toWorkspace(row) : undefined;
  }

  async listWorkspacesForUser(userId: string): Promise<WorkspaceWithRole[]> {
    const rows = this.db
      .prepare(
        `SELECT w.*, m.role AS member_role
         FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
         WHERE m.user_id = ? ORDER BY w.name`,
      )
      .all(userId) as Array<WorkspaceRow & { member_role: WorkspaceRole }>;
    return rows.map((r) => ({ ...toWorkspace(r), role: r.member_role }));
  }

  async updateWorkspace(
    id: string,
    fields: { name?: string; defaultRole?: DocRole },
  ): Promise<Workspace | undefined> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (fields.name !== undefined) {
      sets.push('name = ?');
      vals.push(fields.name);
    }
    if (fields.defaultRole !== undefined) {
      sets.push('default_role = ?');
      vals.push(fields.defaultRole);
    }
    if (sets.length) {
      vals.push(id);
      this.db
        .prepare(`UPDATE workspaces SET ${sets.join(', ')} WHERE id = ?`)
        .run(...vals);
    }
    return this.getWorkspace(id);
  }

  async deleteWorkspace(id: string): Promise<boolean> {
    const tx = this.db.transaction((wid: string) => {
      this.db
        .prepare('UPDATE doc_meta SET workspace_id = NULL WHERE workspace_id = ?')
        .run(wid);
      this.db.prepare('DELETE FROM workspace_members WHERE workspace_id = ?').run(wid);
      return this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(wid);
    });
    return tx(id).changes > 0;
  }

  async addMember(
    workspaceId: string,
    userId: string,
    role: WorkspaceRole,
  ): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = excluded.role`,
      )
      .run(workspaceId, userId, role, new Date().toISOString());
  }

  async getMembership(
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceRole | undefined> {
    const row = this.db
      .prepare(
        'SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
      )
      .get(workspaceId, userId) as { role: WorkspaceRole } | undefined;
    return row?.role;
  }

  async listMembers(workspaceId: string): Promise<WorkspaceMember[]> {
    return this.db
      .prepare(
        `SELECT m.user_id AS userId, m.role, u.email, u.name
         FROM workspace_members m LEFT JOIN users u ON u.id = m.user_id
         WHERE m.workspace_id = ? ORDER BY u.email`,
      )
      .all(workspaceId) as WorkspaceMember[];
  }

  async countMembersWithRole(
    workspaceId: string,
    role: WorkspaceRole,
  ): Promise<number> {
    const row = this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ? AND role = ?',
      )
      .get(workspaceId, role) as { n: number };
    return row.n;
  }

  async removeMember(workspaceId: string, userId: string): Promise<boolean> {
    const res = this.db
      .prepare(
        'DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
      )
      .run(workspaceId, userId);
    return res.changes > 0;
  }

  async setDocWorkspace(
    docId: string,
    workspaceId: string | null,
  ): Promise<void> {
    this.db
      .prepare('UPDATE doc_meta SET workspace_id = ? WHERE doc_id = ?')
      .run(workspaceId, docId);
  }

  async ping(): Promise<void> {
    this.db.prepare('SELECT 1').get();
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
