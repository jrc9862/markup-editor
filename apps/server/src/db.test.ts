import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { SqliteMetaStore, type MetaStore } from './db.js';
import {
  PostgresMetaStore,
  fetchYjsState,
  storeYjsState,
} from './db-postgres.js';

/**
 * One contract, two backends. The Postgres half runs only when DATABASE_URL
 * is set (CI provides a service container); locally it skips so `npm test`
 * needs no infrastructure.
 */
function metaStoreContract(makeStore: () => Promise<MetaStore>) {
  let store: MetaStore;

  beforeAll(async () => {
    store = await makeStore();
    await store.init();
  });

  afterAll(async () => {
    await store.close();
  });

  it('creates and fetches a doc', async () => {
    const created = await store.create('doc-1', 'README.md', '/repo/README.md');
    expect(created.docId).toBe('doc-1');

    const fetched = await store.get('doc-1');
    expect(fetched).toEqual(created);
    expect(await store.get('nope')).toBeUndefined();
  });

  it('lists docs most-recently-updated first', async () => {
    await store.create('doc-2', 'other.md');
    // updated_at has millisecond precision; without this the create and the
    // touch can tie and the ORDER BY has no defined winner.
    await new Promise((r) => setTimeout(r, 5));
    await store.touch('doc-1');
    const list = await store.list();
    expect(list.map((d) => d.docId)).toEqual(['doc-1', 'doc-2']);
  });

  it('upserts users by email with a stable id', async () => {
    const created = await store.upsertUser('u-1', 'a@example.com', 'Ada');
    expect(created.id).toBe('u-1');

    // Same email, new name and candidate id: keeps the original id.
    const updated = await store.upsertUser('u-2', 'a@example.com', 'Ada L.');
    expect(updated.id).toBe('u-1');
    expect(updated.name).toBe('Ada L.');
    expect(await store.getUser('u-1')).toEqual(updated);
    expect(await store.getUser('u-2')).toBeUndefined();
  });

  it('round-trips sessions', async () => {
    await store.createSession('hash-1', 'u-1', '2099-01-01T00:00:00.000Z');
    expect(await store.getSession('hash-1')).toEqual({
      userId: 'u-1',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    await store.deleteSession('hash-1');
    expect(await store.getSession('hash-1')).toBeUndefined();
  });

  it('manages API tokens by hash, scoped per user', async () => {
    await store.createApiToken({
      id: 'tok-1',
      userId: 'u-1',
      name: 'ci-bot',
      scope: 'suggest',
      tokenHash: 'th-1',
    });
    expect(await store.getApiTokenByHash('th-1')).toEqual({
      id: 'tok-1',
      userId: 'u-1',
      name: 'ci-bot',
      scope: 'suggest',
    });
    expect(await store.getApiTokenByHash('nope')).toBeUndefined();

    const listed = await store.listApiTokens('u-1');
    expect(listed).toHaveLength(1);
    expect(listed[0].lastUsedAt).toBeDefined(); // bumped by the hash lookup

    // Deleting someone else's token is a no-op.
    expect(await store.deleteApiToken('u-other', 'tok-1')).toBe(false);
    expect(await store.deleteApiToken('u-1', 'tok-1')).toBe(true);
    expect(await store.getApiTokenByHash('th-1')).toBeUndefined();
  });

  it('manages per-doc ACL entries and the link role', async () => {
    await store.create('doc-acl', 'shared.md', undefined, 'u-1');
    expect((await store.get('doc-acl'))!.ownerId).toBe('u-1');

    expect(await store.getAclRole('doc-acl', 'u-1')).toBeUndefined();
    await store.setAclRole('doc-acl', 'u-9', 'viewer');
    await store.setAclRole('doc-acl', 'u-9', 'suggester'); // upsert
    expect(await store.getAclRole('doc-acl', 'u-9')).toBe('suggester');

    const acl = await store.listAcl('doc-acl');
    expect(acl).toHaveLength(1);
    expect(acl[0]).toMatchObject({ userId: 'u-9', role: 'suggester' });

    await store.setLinkRole('doc-acl', 'none');
    expect((await store.get('doc-acl'))!.linkRole).toBe('none');

    expect(await store.removeAclRole('doc-acl', 'u-9')).toBe(true);
    expect(await store.removeAclRole('doc-acl', 'u-9')).toBe(false);
  });

  it('renames a doc (name and/or path), leaving omitted fields intact', async () => {
    await store.create('doc-mv', 'old.md', 'dir/old.md');
    const renamed = await store.rename('doc-mv', {
      name: 'new.md',
      path: 'dir/new.md',
    });
    expect(renamed).toMatchObject({ name: 'new.md', path: 'dir/new.md' });

    // Partial update: only the name changes, path is preserved.
    const partial = await store.rename('doc-mv', { name: 'newer.md' });
    expect(partial).toMatchObject({ name: 'newer.md', path: 'dir/new.md' });

    expect(await store.rename('missing', { name: 'x' })).toBeUndefined();
  });

  it('debounces version snapshots', async () => {
    expect(await store.maybeAddVersion('doc-1', 'v1', 0)).toBe(true);
    // identical content → no new version, regardless of interval
    expect(await store.maybeAddVersion('doc-1', 'v1', 0)).toBe(false);
    // changed content but within the interval → debounced
    expect(await store.maybeAddVersion('doc-1', 'v2', 60_000)).toBe(false);
    // changed content, interval elapsed (0ms) → recorded
    expect(await store.maybeAddVersion('doc-1', 'v2', 0)).toBe(true);

    const versions = await store.listVersions('doc-1');
    expect(versions).toHaveLength(2);
    // newest first
    expect(versions[0].size).toBe(2);
    expect(await store.getVersionContent('doc-1', versions[1].id)).toBe('v1');
    expect(await store.getVersionContent('doc-1', 9999)).toBeUndefined();
  });

  it('records version attribution and names', async () => {
    await store.create('doc-attr', 'attr.md');
    expect(
      await store.maybeAddVersion('doc-attr', 'hello', 0, 'Ada', 'u-1'),
    ).toBe(true);
    const [v] = await store.listVersions('doc-attr');
    expect(v.author).toBe('Ada');
    expect(v.authorId).toBe('u-1');
    expect(v.name).toBeUndefined();

    expect(await store.nameVersion('doc-attr', v.id, 'first draft')).toBe(true);
    expect(await store.nameVersion('doc-attr', 9999, 'nope')).toBe(false);
    const [named] = await store.listVersions('doc-attr');
    expect(named.name).toBe('first draft');
  });

  it('prunes version history to the count cap, keeping the newest', async () => {
    await store.create('doc-ret', 'ret.md');
    for (const c of ['a', 'b', 'c', 'd', 'e']) {
      expect(await store.maybeAddVersion('doc-ret', c, 0)).toBe(true);
    }
    // 5 versions, keep the newest 3 → 2 pruned.
    expect(
      await store.pruneVersions('doc-ret', { maxCount: 3, maxAgeDays: 0 }),
    ).toBe(2);
    const left = await store.listVersions('doc-ret');
    expect(left).toHaveLength(3);
    expect(await store.getVersionContent('doc-ret', left[0].id)).toBe('e');
    expect(await store.getVersionContent('doc-ret', left[2].id)).toBe('c');
    // Idempotent: a second prune at the same cap removes nothing.
    expect(
      await store.pruneVersions('doc-ret', { maxCount: 3, maxAgeDays: 0 }),
    ).toBe(0);
  });

  it('never prunes named versions or the single most-recent version', async () => {
    await store.create('doc-ret2', 'ret2.md');
    for (const c of ['x', 'y', 'z'] /* oldest → newest */) {
      expect(await store.maybeAddVersion('doc-ret2', c, 0)).toBe(true);
    }
    const all = await store.listVersions('doc-ret2'); // z, y, x
    const oldest = all[2];
    expect(await store.nameVersion('doc-ret2', oldest.id, 'pinned')).toBe(true);

    // maxCount=1 would keep only the newest, but the named oldest is exempt,
    // so only the unnamed middle version is dropped.
    expect(
      await store.pruneVersions('doc-ret2', { maxCount: 1, maxAgeDays: 0 }),
    ).toBe(1);
    const left = await store.listVersions('doc-ret2');
    expect(left.map((v) => v.id)).toEqual([all[0].id, oldest.id]); // z, pinned x
  });

  it('does not prune fresh versions under an age cap, and no-ops when disabled', async () => {
    await store.create('doc-ret3', 'ret3.md');
    for (const c of ['1', '2', '3']) {
      await store.maybeAddVersion('doc-ret3', c, 0);
    }
    // Just-written versions are far younger than 30 days.
    expect(
      await store.pruneVersions('doc-ret3', { maxCount: 0, maxAgeDays: 30 }),
    ).toBe(0);
    // Both caps off → never touches anything.
    expect(
      await store.pruneVersions('doc-ret3', { maxCount: 0, maxAgeDays: 0 }),
    ).toBe(0);
    expect(await store.listVersions('doc-ret3')).toHaveLength(3);
  });

  it('sweeps every doc with pruneAllVersions', async () => {
    await store.create('doc-sweep-a', 'a.md');
    await store.create('doc-sweep-b', 'b.md');
    for (const c of ['p', 'q', 'r']) {
      await store.maybeAddVersion('doc-sweep-a', c, 0);
      await store.maybeAddVersion('doc-sweep-b', c, 0);
    }
    // Keep newest 1 per doc → 2 pruned from each of the two docs.
    const total = await store.pruneAllVersions({ maxCount: 1, maxAgeDays: 0 });
    expect(total).toBeGreaterThanOrEqual(4);
    expect(await store.listVersions('doc-sweep-a')).toHaveLength(1);
    expect(await store.listVersions('doc-sweep-b')).toHaveLength(1);
  });

  it('manages workspaces and membership', async () => {
    await store.upsertUser('ws-admin', 'wsadmin@example.com', 'WS Admin');
    await store.upsertUser('ws-member', 'wsmember@example.com', 'WS Member');

    const ws = await store.createWorkspace('ws-1', 'Acme', 'acme', 'suggester');
    expect(ws).toMatchObject({ id: 'ws-1', slug: 'acme', defaultRole: 'suggester' });
    expect(await store.getWorkspace('ws-1')).toEqual(ws);
    expect(await store.getWorkspaceBySlug('acme')).toEqual(ws);
    expect(await store.getWorkspace('nope')).toBeUndefined();

    await store.addMember('ws-1', 'ws-admin', 'admin');
    await store.addMember('ws-1', 'ws-member', 'member');
    expect(await store.getMembership('ws-1', 'ws-admin')).toBe('admin');
    expect(await store.getMembership('ws-1', 'ws-member')).toBe('member');
    expect(await store.getMembership('ws-1', 'stranger')).toBeUndefined();
    expect(await store.countMembersWithRole('ws-1', 'admin')).toBe(1);

    const forUser = await store.listWorkspacesForUser('ws-member');
    expect(forUser).toEqual([{ ...ws, role: 'member' }]);

    const members = await store.listMembers('ws-1');
    expect(members).toEqual(
      expect.arrayContaining([
        { userId: 'ws-admin', role: 'admin', email: 'wsadmin@example.com', name: 'WS Admin' },
        { userId: 'ws-member', role: 'member', email: 'wsmember@example.com', name: 'WS Member' },
      ]),
    );

    // addMember upserts the role
    await store.addMember('ws-1', 'ws-member', 'admin');
    expect(await store.getMembership('ws-1', 'ws-member')).toBe('admin');
    expect(await store.countMembersWithRole('ws-1', 'admin')).toBe(2);

    const updated = await store.updateWorkspace('ws-1', { defaultRole: 'commenter' });
    expect(updated?.defaultRole).toBe('commenter');

    expect(await store.removeMember('ws-1', 'ws-member')).toBe(true);
    expect(await store.removeMember('ws-1', 'ws-member')).toBe(false);
  });

  it('provisions users via SCIM: active toggle, filter, externalId, sessions', async () => {
    const u = await store.upsertUser('scim-u', 'scim@example.com', 'SCIM User');
    expect(u.active).toBe(true);

    // externalId lookup + userName filter
    await store.updateUser('scim-u', { externalId: 'idp-123' });
    expect((await store.getUserByExternalId('idp-123'))?.id).toBe('scim-u');
    const filtered = await store.listUsers({ filter: { userName: 'scim@example.com' } });
    expect(filtered.map((x) => x.id)).toEqual(['scim-u']);
    expect(await store.listUsers({ filter: { userName: 'none@example.com' } })).toEqual([]);

    // deactivation flows through getUser/getUserByEmail
    await store.createSession('scim-sess', 'scim-u', '2099-01-01T00:00:00.000Z');
    await store.updateUser('scim-u', { active: false });
    expect((await store.getUser('scim-u'))?.active).toBe(false);
    expect((await store.getUserByEmail('scim@example.com'))?.active).toBe(false);

    // dropping sessions signs the user out everywhere
    await store.deleteUserSessions('scim-u');
    expect(await store.getSession('scim-sess')).toBeUndefined();

    // reactivation
    await store.updateUser('scim-u', { active: true });
    expect((await store.getUser('scim-u'))?.active).toBe(true);
  });

  it('links a SCIM Group to a workspace via externalId', async () => {
    const ws = await store.createWorkspace('ws-scim', 'Eng', 'eng', 'editor', 'grp-9');
    expect(await store.getWorkspaceByExternalId('grp-9')).toEqual(ws);
    expect(await store.getWorkspaceByExternalId('missing')).toBeUndefined();
  });

  it('assigns docs to a workspace and detaches on delete', async () => {
    await store.createWorkspace('ws-2', 'Beta', 'beta', 'editor');
    const doc = await store.create('ws-doc', 'w.md', undefined, undefined, 'ws-2');
    expect(doc.workspaceId).toBe('ws-2');
    expect((await store.get('ws-doc'))?.workspaceId).toBe('ws-2');

    await store.setDocWorkspace('ws-doc', null);
    expect((await store.get('ws-doc'))?.workspaceId).toBeUndefined();

    await store.setDocWorkspace('ws-doc', 'ws-2');
    // deleting the workspace detaches its docs rather than orphaning them
    expect(await store.deleteWorkspace('ws-2')).toBe(true);
    expect(await store.getWorkspace('ws-2')).toBeUndefined();
    expect((await store.get('ws-doc'))?.workspaceId).toBeUndefined();
  });

  it('appends and paginates audit entries, newest first', async () => {
    await store.createWorkspace('ws-a', 'Audited', 'audited', 'editor');
    const first = await store.appendAudit({
      workspaceId: 'ws-a',
      ts: '2026-07-01T00:00:00.000Z',
      actorId: 'u-1',
      actorName: 'Alice',
      action: 'workspace.create',
      targetType: 'workspace',
      targetId: 'ws-a',
      detail: { name: 'Audited' },
    });
    expect(first.id).toBeGreaterThan(0);
    for (let i = 0; i < 3; i++) {
      await store.appendAudit({
        workspaceId: 'ws-a',
        ts: '2026-07-01T00:00:01.000Z',
        action: 'member.add',
        targetType: 'member',
        targetId: `u-${i}`,
      });
    }
    // Entries scoped to another workspace never leak in.
    await store.appendAudit({
      workspaceId: 'ws-other',
      ts: '2026-07-01T00:00:02.000Z',
      action: 'member.add',
      targetType: 'member',
      targetId: 'u-x',
    });

    const all = await store.listAudit('ws-a');
    expect(all).toHaveLength(4);
    // Newest first (descending id), detail round-trips as an object.
    expect(all[0].action).toBe('member.add');
    expect(all[3].action).toBe('workspace.create');
    expect(all[3].detail).toEqual({ name: 'Audited' });
    expect(all[3].actorName).toBe('Alice');

    const page = await store.listAudit('ws-a', { limit: 2 });
    expect(page).toHaveLength(2);
    const next = await store.listAudit('ws-a', { limit: 2, before: page[1].id });
    expect(next).toHaveLength(2);
    expect(next[0].id).toBeLessThan(page[1].id);
  });

  it('cascade-deletes a workspace audit log when the workspace is deleted', async () => {
    await store.createWorkspace('ws-del', 'Doomed', 'doomed', 'editor');
    await store.appendAudit({
      workspaceId: 'ws-del',
      ts: '2026-07-01T00:00:00.000Z',
      action: 'workspace.create',
      targetType: 'workspace',
      targetId: 'ws-del',
    });
    expect(await store.listAudit('ws-del')).toHaveLength(1);
    await store.deleteWorkspace('ws-del');
    expect(await store.listAudit('ws-del')).toHaveLength(0);
  });

  it('ping resolves while the store is reachable', async () => {
    await expect(store.ping()).resolves.toBeUndefined();
  });
}

describe('SqliteMetaStore', () => {
  metaStoreContract(async () => new SqliteMetaStore(':memory:'));
});

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('PostgresMetaStore', () => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });

  beforeAll(async () => {
    // Tests own the schema: start clean so the contract's fixed ids work.
    await pool.query(
      'DROP TABLE IF EXISTS doc_meta, doc_versions, documents, users, sessions, api_tokens, doc_acl, workspaces, workspace_members, audit_log, schema_migrations CASCADE',
    );
  });

  metaStoreContract(async () => new PostgresMetaStore(pool));

  it('round-trips Yjs state blobs', async () => {
    const state = Buffer.from([1, 2, 3, 250, 251, 252]);
    await storeYjsState(pool, 'doc-1', state);
    expect(await fetchYjsState(pool, 'doc-1')).toEqual(new Uint8Array(state));

    const updated = Buffer.from([9, 9]);
    await storeYjsState(pool, 'doc-1', updated);
    expect(await fetchYjsState(pool, 'doc-1')).toEqual(new Uint8Array(updated));
    expect(await fetchYjsState(pool, 'missing')).toBeNull();
  });
});
