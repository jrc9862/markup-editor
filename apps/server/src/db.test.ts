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
