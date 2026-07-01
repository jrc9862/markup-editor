import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SqliteMetaStore } from './db.js';
import {
  effectiveScope,
  newApiTokenSecret,
  resolvePrincipal,
  roleFor,
  scopeAllows,
  sessionCookie,
  sha256,
  startSession,
  SESSION_COOKIE,
  type Principal,
} from './auth.js';

describe('scopes', () => {
  it('orders read < comment < suggest < write', () => {
    expect(scopeAllows('write', 'read')).toBe(true);
    expect(scopeAllows('suggest', 'comment')).toBe(true);
    expect(scopeAllows('suggest', 'write')).toBe(false);
    expect(scopeAllows('read', 'comment')).toBe(false);
    expect(scopeAllows('comment', 'comment')).toBe(true);
  });
});

describe('resolvePrincipal', () => {
  const store = new SqliteMetaStore(':memory:');
  const LEGACY = 'shared-secret';

  beforeAll(async () => {
    await store.init();
    await store.upsertUser('u-1', 'ada@example.com', 'Ada');
  });

  afterAll(async () => {
    await store.close();
  });

  it('resolves a session cookie to a user principal', async () => {
    const { secret } = await startSession(store, 'u-1');
    const p = await resolvePrincipal(store, {
      cookieHeader: `${SESSION_COOKIE}=${secret}`,
    });
    expect(p).toMatchObject({ kind: 'user', scope: 'write' });
    expect(p!.kind === 'user' && p!.user.name).toBe('Ada');
  });

  it('rejects expired sessions', async () => {
    const secret = 'expired-secret';
    await store.createSession(
      sha256(secret),
      'u-1',
      new Date(Date.now() - 1000).toISOString(),
    );
    const p = await resolvePrincipal(store, {
      cookieHeader: `${SESSION_COOKIE}=${secret}`,
    });
    expect(p).toBeNull();
  });

  it('resolves an API token to an agent principal with its scope', async () => {
    const secret = newApiTokenSecret();
    await store.createApiToken({
      id: 'tok-1',
      userId: 'u-1',
      name: 'reviewer-bot',
      scope: 'suggest',
      tokenHash: sha256(secret),
    });
    const p = await resolvePrincipal(store, { bearer: secret });
    expect(p).toMatchObject({
      kind: 'agent',
      scope: 'suggest',
      tokenName: 'reviewer-bot',
    });
  });

  it('accepts the legacy shared token and rejects everything else', async () => {
    expect(
      await resolvePrincipal(store, { bearer: LEGACY, legacyToken: LEGACY }),
    ).toMatchObject({ kind: 'legacy', scope: 'write' });
    expect(
      await resolvePrincipal(store, { bearer: 'wrong', legacyToken: LEGACY }),
    ).toBeNull();
    expect(await resolvePrincipal(store, {})).toBeNull();
    // An mkp_-prefixed token that isn't in the store never falls through
    // to the legacy comparison.
    expect(
      await resolvePrincipal(store, {
        bearer: newApiTokenSecret(),
        legacyToken: LEGACY,
      }),
    ).toBeNull();
  });

  it('prefers the session cookie over a bearer token', async () => {
    const { secret } = await startSession(store, 'u-1');
    const p = await resolvePrincipal(store, {
      cookieHeader: `other=1; ${SESSION_COOKIE}=${secret}`,
      bearer: LEGACY,
      legacyToken: LEGACY,
    });
    expect(p).toMatchObject({ kind: 'user' });
  });

  it('formats the session cookie', () => {
    expect(sessionCookie('abc', { secure: false })).toBe(
      `${SESSION_COOKIE}=abc; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax`,
    );
    expect(sessionCookie('abc', { secure: true })).toContain('; Secure');
  });
});

describe('roles', () => {
  const store = new SqliteMetaStore(':memory:');
  const asUser = (id: string, name = id): Principal => ({
    kind: 'user',
    user: { id, email: `${id}@x.com`, name, createdAt: '' },
    scope: 'write',
  });
  const legacy: Principal = { kind: 'legacy', scope: 'write' };

  beforeAll(async () => {
    await store.init();
    await store.upsertUser('owner', 'owner@x.com', 'Owner');
    await store.upsertUser('peer', 'peer@x.com', 'Peer');
  });

  afterAll(async () => {
    await store.close();
  });

  it('resolves owner > acl > link role, defaulting open', async () => {
    const doc = await store.create('d1', 'a.md', undefined, 'owner');
    expect(await roleFor(store, asUser('owner'), doc)).toBe('owner');
    // no ACL entry, no explicit link role: open collaboration
    expect(await roleFor(store, asUser('peer'), doc)).toBe('editor');

    await store.setAclRole('d1', 'peer', 'commenter');
    const doc2 = (await store.get('d1'))!;
    expect(await roleFor(store, asUser('peer'), doc2)).toBe('commenter');

    await store.setLinkRole('d1', 'none');
    const doc3 = (await store.get('d1'))!;
    // ACL entry still wins over a private link role
    expect(await roleFor(store, asUser('peer'), doc3)).toBe('commenter');
    expect(await roleFor(store, asUser('stranger'), doc3)).toBe('none');
    // legacy shared token bypasses roles until MARKUP_REQUIRE_AUTH
    expect(await roleFor(store, legacy, doc3)).toBe('owner');
  });

  it('unowned (pre-identity) docs stay open', async () => {
    const doc = await store.create('d2', 'b.md');
    expect(await roleFor(store, asUser('anyone'), doc)).toBe('editor');
  });

  it('effective capability is the weaker of token scope and role', async () => {
    const doc = (await store.get('d1'))!; // peer is commenter via ACL
    expect(await effectiveScope(store, asUser('peer'), doc)).toBe('comment');

    const agentSuggest: Principal = {
      kind: 'agent',
      user: { id: 'owner', email: 'owner@x.com', name: 'Owner', createdAt: '' },
      tokenName: 'bot',
      scope: 'suggest',
    };
    // owner role allows write, but the token only carries suggest
    expect(await effectiveScope(store, agentSuggest, doc)).toBe('suggest');
    expect(await effectiveScope(store, asUser('stranger'), doc)).toBeNull();
  });
});

describe('roleFor with workspaces', () => {
  const store = new SqliteMetaStore(':memory:');
  const asUser = (id: string): Principal => ({
    kind: 'user',
    user: { id, email: `${id}@x.com`, name: id, createdAt: '' },
    scope: 'write',
  });

  beforeAll(async () => {
    await store.init();
    for (const id of ['owner', 'admin', 'member', 'stranger']) {
      await store.upsertUser(id, `${id}@x.com`, id);
    }
    await store.createWorkspace('ws', 'Acme', 'acme', 'suggester');
    await store.addMember('ws', 'admin', 'admin');
    await store.addMember('ws', 'member', 'member');
  });

  afterAll(async () => {
    await store.close();
  });

  it('workspace admin acts as owner; members get the baseline; non-members follow link role', async () => {
    const doc = await store.create('wd', 'w.md', undefined, 'owner', 'ws');
    // doc owner keeps ownership even inside a workspace
    expect(await roleFor(store, asUser('owner'), doc)).toBe('owner');
    // admin override
    expect(await roleFor(store, asUser('admin'), doc)).toBe('owner');
    // member gets the workspace's defaultRole
    expect(await roleFor(store, asUser('member'), doc)).toBe('suggester');
    // non-member falls through to the link role (default editor)
    expect(await roleFor(store, asUser('stranger'), doc)).toBe('editor');
  });

  it('an owner ACL grant promotes a member above the workspace baseline', async () => {
    await store.setAclRole('wd', 'member', 'editor');
    const doc = (await store.get('wd'))!;
    // stronger of ACL (editor) and baseline (suggester) wins
    expect(await roleFor(store, asUser('member'), doc)).toBe('editor');
  });

  it('the workspace baseline still applies when the ACL grant is weaker', async () => {
    await store.setAclRole('wd', 'member', 'viewer');
    const doc = (await store.get('wd'))!;
    // baseline suggester beats a weaker viewer grant
    expect(await roleFor(store, asUser('member'), doc)).toBe('suggester');
  });

  it('detaching the doc from the workspace drops membership-derived roles', async () => {
    await store.setDocWorkspace('wd', null);
    const doc = (await store.get('wd'))!;
    expect(await roleFor(store, asUser('admin'), doc)).toBe('editor'); // link role
    // member keeps only its explicit ACL grant (viewer, set above)
    expect(await roleFor(store, asUser('member'), doc)).toBe('viewer');
  });
});
