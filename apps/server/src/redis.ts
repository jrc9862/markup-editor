/**
 * Cross-node layer (Phase 2, multi-node). Gated by `REDIS_URL` exactly like
 * the data layer is gated by `DATABASE_URL`: unset ⇒ the single-node in-process
 * path (an EventEmitter bus + a Map), set ⇒ everything that was node-local
 * moves onto Redis so any node can serve any doc.
 *
 * Three things were in-process and break across nodes; this module fixes all
 * three when Redis is configured:
 *
 *  1. **Yjs update + awareness fan-out** — the Hocuspocus Redis extension
 *     pub/subs document updates so an edit on node A reaches a client on node B.
 *  2. **The `docEvents` bus** (SSE) — bridged onto a Redis channel so a comment
 *     posted via REST on node A is delivered to an SSE subscriber on node B.
 *  3. **The `lastEditor` map** (version attribution) — moved into Redis so the
 *     node that stores a version snapshot can read the most-recent editor even
 *     when the edit arrived on a different node.
 *
 * The per-user WebSocket connection cap (connections.ts) stays in-process on
 * purpose: it becomes a per-node cap under Redis, which is still a useful
 * self-protection guard. Cross-node connection accounting is not worth a
 * round-trip on every connect.
 */
import IORedis from 'ioredis';
import { Redis as HocuspocusRedis } from '@hocuspocus/extension-redis';
import type { DocEventBus, DocEvent } from './events.js';

type IORedisClient = IORedis.Redis;

const EVENTS_CHANNEL = 'markup:docevents';
const LAST_EDITOR_PREFIX = 'markup:lasteditor:';
// Attribution is a display nicety; a stale entry just means a slightly wrong
// author label on a version, so a generous TTL keeps Redis from accumulating
// keys for docs that go idle.
const LAST_EDITOR_TTL_S = 3600;

export interface EditorAttribution {
  author?: string;
  authorId?: string;
}

/** The most-recent-editor store, abstracted over in-process vs Redis. */
export interface EditorStore {
  /** Record the latest editor for a doc (fire-and-forget). */
  set(docId: string, who: EditorAttribution): void;
  /** Best-effort lookup; resolves undefined when unknown or unreachable. */
  get(docId: string): Promise<EditorAttribution | undefined>;
}

/** Single-node default: the original in-memory Map behavior. */
class LocalEditorStore implements EditorStore {
  private map = new Map<string, EditorAttribution>();
  set(docId: string, who: EditorAttribution): void {
    this.map.set(docId, who);
  }
  async get(docId: string): Promise<EditorAttribution | undefined> {
    return this.map.get(docId);
  }
}

class RedisEditorStore implements EditorStore {
  constructor(private cmd: IORedisClient) {}
  set(docId: string, who: EditorAttribution): void {
    // Best-effort: never let attribution bookkeeping reject a hot-path edit.
    void this.cmd
      .set(LAST_EDITOR_PREFIX + docId, JSON.stringify(who), 'EX', LAST_EDITOR_TTL_S)
      .catch(() => {});
  }
  async get(docId: string): Promise<EditorAttribution | undefined> {
    try {
      const raw = await this.cmd.get(LAST_EDITOR_PREFIX + docId);
      return raw ? (JSON.parse(raw) as EditorAttribution) : undefined;
    } catch {
      // Redis blip → fall back to no attribution rather than failing the store.
      return undefined;
    }
  }
}

export function localEditorStore(): EditorStore {
  return new LocalEditorStore();
}

export interface RedisLayer {
  /** Add to the Hocuspocus `extensions` array for cross-node Yjs fan-out. */
  extension: HocuspocusRedis;
  /** Redis-backed version attribution. */
  editors: EditorStore;
  /** Tear down our own pub/sub clients (the extension closes its own). */
  close(): Promise<void>;
}

/**
 * Wire the cross-node layer if `REDIS_URL` is set, else return null so callers
 * keep the in-process path. `bus` is mutated in place: its publish path is
 * redirected through Redis and its local delivery is driven by the subscriber.
 */
export function redisFromEnv(bus: DocEventBus): RedisLayer | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;

  // Two dedicated clients: ioredis puts a connection into subscriber mode once
  // it subscribes, after which it can only run pub/sub commands — so the
  // command client (publish + lastEditor get/set) must be separate from the
  // subscriber.
  const opts = { maxRetriesPerRequest: null as number | null };
  const cmd = new IORedis(url, opts);
  const sub = new IORedis(url, opts);

  // Bridge the in-process bus onto Redis pub/sub.
  bus.setTransport((event) => {
    void cmd.publish(EVENTS_CHANNEL, JSON.stringify(event)).catch(() => {});
  });
  void sub.subscribe(EVENTS_CHANNEL);
  sub.on('message', (_channel: string, payload: string) => {
    try {
      bus.deliver(JSON.parse(payload) as DocEvent);
    } catch {
      // Ignore anything that isn't a well-formed event.
    }
  });

  // The extension manages its own pub/sub pair (and a redlock) off this
  // factory; give it a fresh client each call.
  const extension = new HocuspocusRedis({
    createClient: () => new IORedis(url, opts),
  });

  return {
    extension,
    editors: new RedisEditorStore(cmd),
    async close() {
      bus.setTransport(undefined);
      cmd.disconnect();
      sub.disconnect();
    },
  };
}
