import { describe, it, expect } from 'vitest';
import { DocEventBus, type DocEvent } from './events.js';
import { localEditorStore, redisFromEnv } from './redis.js';

describe('localEditorStore', () => {
  it('round-trips the most-recent editor and is undefined when unknown', async () => {
    const store = localEditorStore();
    expect(await store.get('doc-1')).toBeUndefined();

    store.set('doc-1', { author: 'Ada', authorId: 'u-1' });
    expect(await store.get('doc-1')).toEqual({ author: 'Ada', authorId: 'u-1' });

    // Overwrites — only the latest editor is kept.
    store.set('doc-1', { author: 'Bob', authorId: 'u-2' });
    expect(await store.get('doc-1')).toEqual({ author: 'Bob', authorId: 'u-2' });
  });
});

describe('DocEventBus transport seam', () => {
  it('delivers locally when no transport is installed (single node)', () => {
    const bus = new DocEventBus();
    const seen: DocEvent[] = [];
    bus.subscribe('doc-x', (e) => seen.push(e));

    bus.publish({ type: 'comment', docId: 'doc-x', ts: 't1' });
    expect(seen).toHaveLength(1);
  });

  it('routes publish through the transport instead of delivering directly', () => {
    const bus = new DocEventBus();
    const seen: DocEvent[] = [];
    const transported: DocEvent[] = [];
    bus.subscribe('doc-x', (e) => seen.push(e));
    bus.setTransport((e) => transported.push(e));

    bus.publish({ type: 'comment', docId: 'doc-x', ts: 't1' });
    // With a transport, publish does NOT fan out locally — that happens only
    // when the event comes back via deliver() (driven by the Redis subscriber).
    expect(transported).toHaveLength(1);
    expect(seen).toHaveLength(0);

    // Simulate the message arriving back over Redis: now it reaches subscribers.
    bus.deliver(transported[0]);
    expect(seen).toEqual(transported);
  });

  it('clearing the transport restores direct local delivery', () => {
    const bus = new DocEventBus();
    const seen: DocEvent[] = [];
    bus.subscribe('doc-x', (e) => seen.push(e));
    bus.setTransport(() => {});
    bus.setTransport(undefined);

    bus.publish({ type: 'content', docId: 'doc-x', ts: 't1' });
    expect(seen).toHaveLength(1);
  });
});

describe('redisFromEnv', () => {
  it('returns null (single-node path) when REDIS_URL is unset', () => {
    const saved = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    try {
      const bus = new DocEventBus();
      expect(redisFromEnv(bus)).toBeNull();
      // The bus is untouched: publish still delivers locally.
      const seen: DocEvent[] = [];
      bus.subscribe('d', (e) => seen.push(e));
      bus.publish({ type: 'content', docId: 'd', ts: 't' });
      expect(seen).toHaveLength(1);
    } finally {
      if (saved !== undefined) process.env.REDIS_URL = saved;
    }
  });
});
