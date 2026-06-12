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
      'DROP TABLE IF EXISTS doc_meta, doc_versions, documents, schema_migrations',
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
