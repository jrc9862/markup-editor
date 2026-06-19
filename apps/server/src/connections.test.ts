import { describe, it, expect } from 'vitest';
import { ConnectionCounter } from './connections.js';

describe('ConnectionCounter', () => {
  it('enforces the per-user cap and frees slots on release', () => {
    const c = new ConnectionCounter();
    expect(c.tryAcquire('u1', 2)).toBe(true);
    expect(c.tryAcquire('u1', 2)).toBe(true);
    // At the cap: rejected, and nothing is reserved.
    expect(c.tryAcquire('u1', 2)).toBe(false);
    expect(c.count('u1')).toBe(2);

    c.release('u1');
    expect(c.count('u1')).toBe(1);
    expect(c.tryAcquire('u1', 2)).toBe(true);
  });

  it('counts users independently', () => {
    const c = new ConnectionCounter();
    c.tryAcquire('a', 5);
    c.tryAcquire('b', 5);
    expect(c.count('a')).toBe(1);
    expect(c.count('b')).toBe(1);
  });

  it('treats max <= 0 as unlimited', () => {
    const c = new ConnectionCounter();
    for (let i = 0; i < 100; i++) expect(c.tryAcquire('u', 0)).toBe(true);
    expect(c.count('u')).toBe(100);
  });

  it('clamps release below zero and forgets idle users', () => {
    const c = new ConnectionCounter();
    c.release('ghost');
    expect(c.count('ghost')).toBe(0);
    c.tryAcquire('u', 1);
    c.release('u');
    expect(c.count('u')).toBe(0);
  });
});
