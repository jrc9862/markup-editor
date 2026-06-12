import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SqliteMetaStore } from './db.js';
import {
  newApiTokenSecret,
  resolvePrincipal,
  scopeAllows,
  sessionCookie,
  sha256,
  startSession,
  SESSION_COOKIE,
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
