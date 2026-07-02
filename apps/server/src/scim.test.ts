import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { pino } from 'pino';
import { SqliteMetaStore } from './db.js';
import { parseScimFilter, registerScimRoutes } from './scim.js';

describe('parseScimFilter', () => {
  it('parses the `attr eq "value"` form IdPs send before create', () => {
    expect(parseScimFilter('userName eq "a@example.com"')).toEqual({
      attr: 'userName',
      value: 'a@example.com',
    });
    expect(parseScimFilter('displayName eq "Eng Team"')).toEqual({
      attr: 'displayName',
      value: 'Eng Team',
    });
    expect(parseScimFilter('externalId eq "idp-1"')).toEqual({
      attr: 'externalId',
      value: 'idp-1',
    });
  });

  it('tolerates surrounding whitespace and unescapes quotes', () => {
    expect(parseScimFilter('  userName eq "x"  ')).toEqual({
      attr: 'userName',
      value: 'x',
    });
    expect(parseScimFilter('displayName eq "a\\"b"')).toEqual({
      attr: 'displayName',
      value: 'a"b',
    });
  });

  it('returns null for empty or unsupported filters (caller lists all)', () => {
    expect(parseScimFilter(undefined)).toBeNull();
    expect(parseScimFilter('')).toBeNull();
    expect(parseScimFilter('userName co "x"')).toBeNull();
    expect(parseScimFilter('userName eq x')).toBeNull();
  });
});

describe('SCIM Users routes', () => {
  const TOKEN = 'scim-test-token';
  let store: SqliteMetaStore;
  let server: Server;
  let base: string;

  const scimFetch = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/scim+json',
        ...init.headers,
      },
    });

  beforeAll(async () => {
    store = new SqliteMetaStore(':memory:');
    await store.init();
    const app = express();
    registerScimRoutes(app, store, {
      token: TOKEN,
      serverOrigin: 'http://localhost',
      logger: pino({ enabled: false }),
    });
    server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}/scim/v2`;
  });

  afterAll(async () => {
    server.close();
    await store.close();
  });

  it('a full PUT without `active` preserves a deprovisioned state', async () => {
    const user = await store.upsertUser('scim-u1', 'eve@example.com', 'Eve');
    await store.updateUser(user.id, { active: false });

    // An IdP name-only replace must not silently reactivate the user.
    const res = await scimFetch(`/Users/${user.id}`, {
      method: 'PUT',
      body: JSON.stringify({ displayName: 'Eve Updated' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { active: boolean };
    expect(body.active).toBe(false);
    expect((await store.getUser(user.id))!.active).toBe(false);

    // An explicit active:true still reactivates.
    const res2 = await scimFetch(`/Users/${user.id}`, {
      method: 'PUT',
      body: JSON.stringify({ active: true }),
    });
    expect(((await res2.json()) as { active: boolean }).active).toBe(true);
  });
});
