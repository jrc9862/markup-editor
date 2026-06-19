import { EventEmitter } from 'node:events';

/**
 * Realtime doc events for agent (and human) subscribers. Agents are a
 * first-class audience: instead of polling the REST surface, they open the
 * SSE stream (`GET /api/docs/:id/events`) and react to comments, suggestions,
 * reviews, mentions, and edits as they happen.
 */
export type DocEventType =
  | 'comment'
  | 'comment.reply'
  | 'comment.resolve'
  | 'suggestion'
  | 'suggestion.update'
  | 'suggestion.reply'
  | 'suggestion.accept'
  | 'suggestion.reject'
  | 'content'
  | 'mention';

export interface DocEvent {
  type: DocEventType;
  docId: string;
  /** ISO timestamp. */
  ts: string;
  /** Display name of the actor, when known. */
  author?: string;
  /** Stable user id of the actor, when known. */
  authorId?: string;
  /** True when the actor is an agent principal (API token), not a human. */
  agent?: boolean;
  /** Comment thread id (comment* events). */
  threadId?: string;
  /** Suggestion id (suggestion* events). */
  suggestionId?: string;
  /** The @-handle that was mentioned (mention events). */
  mention?: string;
  /** Free-text payload (comment/reply text), when relevant. */
  text?: string;
}

export class DocEventBus extends EventEmitter {
  // When set (multi-node, see redis.ts), publish() routes through this
  // transport instead of delivering locally. The transport fans the event out
  // to every node over Redis pub/sub, and each node — including this one —
  // delivers to its local SSE subscribers via deliver() when the message comes
  // back. One uniform path, so no de-duplication is needed.
  private transport?: (e: DocEvent) => void;

  constructor() {
    super();
    // Many concurrent SSE subscribers per doc are expected.
    this.setMaxListeners(0);
  }

  /** Install (or clear, with `undefined`) the cross-node transport. */
  setTransport(fn: ((e: DocEvent) => void) | undefined): void {
    this.transport = fn;
  }

  publish(event: DocEvent): void {
    if (this.transport) this.transport(event);
    else this.deliver(event);
  }

  /** Fan an event out to this node's local SSE subscribers. */
  deliver(event: DocEvent): void {
    this.emit(event.docId, event);
  }

  /** Subscribe to one doc's events; returns an unsubscribe function. */
  subscribe(docId: string, fn: (e: DocEvent) => void): () => void {
    this.on(docId, fn);
    return () => this.off(docId, fn);
  }
}

export const docEvents = new DocEventBus();

/** Extract @mentions (`@name`, `@some-handle`) from free text. */
export function extractMentions(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/(?:^|[^\w@])@([\w][\w.-]*)/g)) {
    found.add(m[1]);
  }
  return [...found];
}
