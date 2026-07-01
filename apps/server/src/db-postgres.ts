import pg from 'pg';
import type {
  AclEntry,
  ApiTokenMeta,
  AuditEntry,
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
import type {
  ApiTokenRow,
  MetaStore,
  RetentionPolicy,
  SessionRow,
} from './db.js';
import { retentionDisabled } from './db.js';

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
  // Phase 1 milestone 2: per-doc roles.
  `ALTER TABLE doc_meta ADD COLUMN owner_id TEXT`,
  `ALTER TABLE doc_meta ADD COLUMN link_role TEXT`,
  `CREATE TABLE doc_acl (
     doc_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     role TEXT NOT NULL,
     PRIMARY KEY (doc_id, user_id)
   )`,
  // Named versions + per-author attribution (roadmap #5).
  `ALTER TABLE doc_versions ADD COLUMN name TEXT`,
  `ALTER TABLE doc_versions ADD COLUMN author TEXT`,
  `ALTER TABLE doc_versions ADD COLUMN author_id TEXT`,
  // Phase 3: workspaces (a doc may belong to one; membership grants a baseline
  // doc role and admins act as owner — see auth.roleFor).
  `CREATE TABLE workspaces (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     slug TEXT NOT NULL UNIQUE,
     default_role TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
  `CREATE TABLE workspace_members (
     workspace_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     role TEXT NOT NULL,
     created_at TEXT NOT NULL,
     PRIMARY KEY (workspace_id, user_id)
   )`,
  `ALTER TABLE doc_meta ADD COLUMN workspace_id TEXT`,
  // Phase 3: audit log — workspace-administrative actions, scoped to a
  // workspace and cascade-deleted with it (see db.ts appendAudit/listAudit).
  `CREATE TABLE audit_log (
     id BIGSERIAL PRIMARY KEY,
     workspace_id TEXT NOT NULL,
     ts TEXT NOT NULL,
     actor_id TEXT,
     actor_name TEXT,
     action TEXT NOT NULL,
     target_type TEXT NOT NULL,
     target_id TEXT,
     detail TEXT
   )`,
  `CREATE INDEX idx_audit_ws ON audit_log (workspace_id, id)`,
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

interface AuditRow {
  id: string | number;
  workspace_id: string;
  ts: string;
  actor_id: string | null;
  actor_name: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  detail: string | null;
}

function toAudit(row: AuditRow): AuditEntry {
  return {
    // BIGSERIAL arrives as a string from node-postgres; ids stay well under
    // 2^53 in practice, so Number() is safe for the cursor.
    id: Number(row.id),
    workspaceId: row.workspace_id,
    ts: row.ts,
    actorId: row.actor_id ?? undefined,
    actorName: row.actor_name ?? undefined,
    action: row.action as AuditEntry['action'],
    targetType: row.target_type as AuditEntry['targetType'],
    targetId: row.target_id ?? undefined,
    detail: row.detail ? (JSON.parse(row.detail) as Record<string, unknown>) : undefined,
  };
}

export class PostgresMetaStore implements MetaStore {
  constructor(private pool: pg.Pool) {}

  async init(): Promise<void> {
    await runMigrations(this.pool);
  }

  async create(
    docId: string,
    name: string,
    path?: string,
    ownerId?: string,
    workspaceId?: string,
  ): Promise<DocMeta> {
    const now = new Date().toISOString();
    await this.pool.query(
      'INSERT INTO doc_meta (doc_id, name, path, created_at, updated_at, owner_id, workspace_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [docId, name, path ?? null, now, now, ownerId ?? null, workspaceId ?? null],
    );
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

  async rename(
    docId: string,
    fields: { name?: string; path?: string },
  ): Promise<DocMeta | undefined> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (fields.name !== undefined) {
      vals.push(fields.name);
      sets.push(`name = $${vals.length}`);
    }
    if (fields.path !== undefined) {
      vals.push(fields.path);
      sets.push(`path = $${vals.length}`);
    }
    if (sets.length) {
      vals.push(new Date().toISOString());
      sets.push(`updated_at = $${vals.length}`);
      vals.push(docId);
      await this.pool.query(
        `UPDATE doc_meta SET ${sets.join(', ')} WHERE doc_id = $${vals.length}`,
        vals,
      );
    }
    return this.get(docId);
  }

  async maybeAddVersion(
    docId: string,
    content: string,
    minIntervalMs = 60_000,
    author?: string,
    authorId?: string,
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
      'INSERT INTO doc_versions (doc_id, content, created_at, author, author_id) VALUES ($1, $2, $3, $4, $5)',
      [docId, content, new Date().toISOString(), author ?? null, authorId ?? null],
    );
    return true;
  }

  async listVersions(docId: string): Promise<VersionMeta[]> {
    const { rows } = await this.pool.query<{
      id: string;
      created_at: string;
      name: string | null;
      author: string | null;
      author_id: string | null;
      size: string;
    }>(
      'SELECT id, created_at, name, author, author_id, LENGTH(content) AS size FROM doc_versions WHERE doc_id = $1 ORDER BY id DESC',
      [docId],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      docId,
      createdAt: r.created_at,
      size: Number(r.size),
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
    const res = await this.pool.query(
      'UPDATE doc_versions SET name = $1 WHERE doc_id = $2 AND id = $3',
      [name, docId, versionId],
    );
    return (res.rowCount ?? 0) > 0;
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

  async pruneVersions(docId: string, policy: RetentionPolicy): Promise<number> {
    if (retentionDisabled(policy)) return 0;
    const ageCutoff =
      policy.maxAgeDays > 0
        ? new Date(Date.now() - policy.maxAgeDays * 86_400_000).toISOString()
        : null;
    const res = await this.pool.query(
      `DELETE FROM doc_versions
       WHERE doc_id = $1
         AND name IS NULL
         AND id <> (SELECT id FROM doc_versions WHERE doc_id = $1 ORDER BY id DESC LIMIT 1)
         AND (
               ($2 > 0 AND id NOT IN (
                  SELECT id FROM doc_versions WHERE doc_id = $1 ORDER BY id DESC LIMIT $2))
            OR ($3::text IS NOT NULL AND created_at < $3)
         )`,
      [docId, policy.maxCount, ageCutoff],
    );
    return res.rowCount ?? 0;
  }

  async pruneAllVersions(policy: RetentionPolicy): Promise<number> {
    if (retentionDisabled(policy)) return 0;
    const { rows } = await this.pool.query<{ doc_id: string }>(
      'SELECT DISTINCT doc_id FROM doc_versions',
    );
    let total = 0;
    for (const r of rows) total += await this.pruneVersions(r.doc_id, policy);
    return total;
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

  async getUserByEmail(email: string): Promise<AuthUser | undefined> {
    const { rows } = await this.pool.query<{
      id: string;
      email: string;
      name: string;
      created_at: string;
    }>('SELECT id, email, name, created_at FROM users WHERE email = $1', [
      email,
    ]);
    const r = rows[0];
    return r
      ? { id: r.id, email: r.email, name: r.name, createdAt: r.created_at }
      : undefined;
  }

  // --- Per-doc roles ----------------------------------------------------------

  async getAclRole(docId: string, userId: string): Promise<DocRole | undefined> {
    const { rows } = await this.pool.query<{ role: DocRole }>(
      'SELECT role FROM doc_acl WHERE doc_id = $1 AND user_id = $2',
      [docId, userId],
    );
    return rows[0]?.role;
  }

  async setAclRole(docId: string, userId: string, role: DocRole): Promise<void> {
    await this.pool.query(
      `INSERT INTO doc_acl (doc_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (doc_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [docId, userId, role],
    );
  }

  async removeAclRole(docId: string, userId: string): Promise<boolean> {
    const res = await this.pool.query(
      'DELETE FROM doc_acl WHERE doc_id = $1 AND user_id = $2',
      [docId, userId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async listAcl(docId: string): Promise<AclEntry[]> {
    const { rows } = await this.pool.query<{
      user_id: string;
      role: DocRole;
      email: string | null;
      name: string | null;
    }>(
      `SELECT a.user_id, a.role, u.email, u.name
       FROM doc_acl a LEFT JOIN users u ON u.id = a.user_id
       WHERE a.doc_id = $1 ORDER BY u.email`,
      [docId],
    );
    return rows.map((r) => ({
      userId: r.user_id,
      role: r.role,
      email: r.email ?? undefined,
      name: r.name ?? undefined,
    }));
  }

  async setLinkRole(docId: string, role: DocRole | 'none'): Promise<void> {
    await this.pool.query(
      'UPDATE doc_meta SET link_role = $1 WHERE doc_id = $2',
      [role, docId],
    );
  }

  // --- Workspaces -------------------------------------------------------------

  async createWorkspace(
    id: string,
    name: string,
    slug: string,
    defaultRole: DocRole,
  ): Promise<Workspace> {
    const now = new Date().toISOString();
    await this.pool.query(
      'INSERT INTO workspaces (id, name, slug, default_role, created_at) VALUES ($1, $2, $3, $4, $5)',
      [id, name, slug, defaultRole, now],
    );
    return { id, name, slug, defaultRole, createdAt: now };
  }

  async getWorkspace(id: string): Promise<Workspace | undefined> {
    const { rows } = await this.pool.query<WorkspaceRow>(
      'SELECT * FROM workspaces WHERE id = $1',
      [id],
    );
    return rows[0] ? toWorkspace(rows[0]) : undefined;
  }

  async getWorkspaceBySlug(slug: string): Promise<Workspace | undefined> {
    const { rows } = await this.pool.query<WorkspaceRow>(
      'SELECT * FROM workspaces WHERE slug = $1',
      [slug],
    );
    return rows[0] ? toWorkspace(rows[0]) : undefined;
  }

  async listWorkspacesForUser(userId: string): Promise<WorkspaceWithRole[]> {
    const { rows } = await this.pool.query<
      WorkspaceRow & { member_role: WorkspaceRole }
    >(
      `SELECT w.*, m.role AS member_role
       FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
       WHERE m.user_id = $1 ORDER BY w.name`,
      [userId],
    );
    return rows.map((r) => ({ ...toWorkspace(r), role: r.member_role }));
  }

  async updateWorkspace(
    id: string,
    fields: { name?: string; defaultRole?: DocRole },
  ): Promise<Workspace | undefined> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (fields.name !== undefined) {
      sets.push(`name = $${vals.length + 1}`);
      vals.push(fields.name);
    }
    if (fields.defaultRole !== undefined) {
      sets.push(`default_role = $${vals.length + 1}`);
      vals.push(fields.defaultRole);
    }
    if (sets.length) {
      vals.push(id);
      await this.pool.query(
        `UPDATE workspaces SET ${sets.join(', ')} WHERE id = $${vals.length}`,
        vals,
      );
    }
    return this.getWorkspace(id);
  }

  async deleteWorkspace(id: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE doc_meta SET workspace_id = NULL WHERE workspace_id = $1',
        [id],
      );
      await client.query('DELETE FROM workspace_members WHERE workspace_id = $1', [
        id,
      ]);
      await client.query('DELETE FROM audit_log WHERE workspace_id = $1', [id]);
      const res = await client.query('DELETE FROM workspaces WHERE id = $1', [id]);
      await client.query('COMMIT');
      return (res.rowCount ?? 0) > 0;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async addMember(
    workspaceId: string,
    userId: string,
    role: WorkspaceRole,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [workspaceId, userId, role, new Date().toISOString()],
    );
  }

  async getMembership(
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceRole | undefined> {
    const { rows } = await this.pool.query<{ role: WorkspaceRole }>(
      'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [workspaceId, userId],
    );
    return rows[0]?.role;
  }

  async listMembers(workspaceId: string): Promise<WorkspaceMember[]> {
    const { rows } = await this.pool.query<{
      user_id: string;
      role: WorkspaceRole;
      email: string | null;
      name: string | null;
    }>(
      `SELECT m.user_id, m.role, u.email, u.name
       FROM workspace_members m LEFT JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = $1 ORDER BY u.email`,
      [workspaceId],
    );
    return rows.map((r) => ({
      userId: r.user_id,
      role: r.role,
      email: r.email ?? undefined,
      name: r.name ?? undefined,
    }));
  }

  async countMembersWithRole(
    workspaceId: string,
    role: WorkspaceRole,
  ): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = $1 AND role = $2',
      [workspaceId, role],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async removeMember(workspaceId: string, userId: string): Promise<boolean> {
    const res = await this.pool.query(
      'DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [workspaceId, userId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async setDocWorkspace(
    docId: string,
    workspaceId: string | null,
  ): Promise<void> {
    await this.pool.query(
      'UPDATE doc_meta SET workspace_id = $1 WHERE doc_id = $2',
      [workspaceId, docId],
    );
  }

  async appendAudit(entry: Omit<AuditEntry, 'id'>): Promise<AuditEntry> {
    const res = await this.pool.query(
      `INSERT INTO audit_log
         (workspace_id, ts, actor_id, actor_name, action, target_type, target_id, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        entry.workspaceId,
        entry.ts,
        entry.actorId ?? null,
        entry.actorName ?? null,
        entry.action,
        entry.targetType,
        entry.targetId ?? null,
        entry.detail ? JSON.stringify(entry.detail) : null,
      ],
    );
    return { ...entry, id: Number(res.rows[0].id) };
  }

  async listAudit(
    workspaceId: string,
    opts?: { limit?: number; before?: number },
  ): Promise<AuditEntry[]> {
    const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 1000);
    const res =
      opts?.before !== undefined
        ? await this.pool.query(
            `SELECT * FROM audit_log WHERE workspace_id = $1 AND id < $2
             ORDER BY id DESC LIMIT $3`,
            [workspaceId, opts.before, limit],
          )
        : await this.pool.query(
            `SELECT * FROM audit_log WHERE workspace_id = $1
             ORDER BY id DESC LIMIT $2`,
            [workspaceId, limit],
          );
    return (res.rows as AuditRow[]).map(toAudit);
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
