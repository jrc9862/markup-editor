import * as Y from 'yjs';

/**
 * Comments and suggestions live in the same Y.Doc as the text, so they sync,
 * resolve, and persist exactly like edits do. Ranges are anchored with
 * Y.RelativePosition, which survives concurrent edits (the anchor follows
 * the text it was attached to, even as other people type around it).
 */
export const COMMENTS_FIELD = 'comments';
export const SUGGESTIONS_FIELD = 'suggestions';

// --- Relative-position anchors ---------------------------------------------

function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

function fromBase64(s: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(s, 'base64'));
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Encode a text index as a portable relative-position anchor. */
export function encodeAnchor(ytext: Y.Text, index: number, assoc = 0): string {
  const rel = Y.createRelativePositionFromTypeIndex(ytext, index, assoc);
  return toBase64(Y.encodeRelativePosition(rel));
}

/** Resolve an anchor back to a current text index (null if its text is gone). */
export function resolveAnchor(doc: Y.Doc, encoded: string): number | null {
  const rel = Y.decodeRelativePosition(fromBase64(encoded));
  const abs = Y.createAbsolutePositionFromRelativePosition(rel, doc);
  return abs ? abs.index : null;
}

// --- Plain snapshots (what the UI renders) ----------------------------------

export interface CommentReplyData {
  id: string;
  author: string;
  text: string;
  createdAt: string;
}

export interface CommentThreadData {
  id: string;
  /** Current absolute range, or null if the anchored text was deleted. */
  from: number | null;
  to: number | null;
  resolved: boolean;
  createdAt: string;
  replies: CommentReplyData[];
}

export type SuggestionStatus = 'open' | 'accepted' | 'rejected';

export interface SuggestionData {
  id: string;
  from: number | null;
  to: number | null;
  author: string;
  /** The text as it was when the suggestion was made. */
  original: string;
  /** The proposed replacement. */
  proposed: string;
  status: SuggestionStatus;
  createdAt: string;
}

function newId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// --- Comments ----------------------------------------------------------------

export function addComment(
  doc: Y.Doc,
  ytext: Y.Text,
  opts: { from: number; to: number; author: string; text: string },
): string {
  const id = newId();
  const threads = doc.getArray<Y.Map<unknown>>(COMMENTS_FIELD);
  doc.transact(() => {
    const thread = new Y.Map<unknown>();
    thread.set('id', id);
    thread.set('anchorStart', encodeAnchor(ytext, opts.from, 0));
    thread.set('anchorEnd', encodeAnchor(ytext, opts.to, -1));
    thread.set('resolved', false);
    thread.set('createdAt', new Date().toISOString());
    const replies = new Y.Array<CommentReplyData>();
    replies.push([
      {
        id: newId(),
        author: opts.author,
        text: opts.text,
        createdAt: new Date().toISOString(),
      },
    ]);
    thread.set('replies', replies);
    threads.push([thread]);
  });
  return id;
}

export function addReply(
  doc: Y.Doc,
  threadId: string,
  opts: { author: string; text: string },
): void {
  const thread = findById(doc.getArray<Y.Map<unknown>>(COMMENTS_FIELD), threadId);
  if (!thread) return;
  const replies = thread.get('replies') as Y.Array<CommentReplyData>;
  replies.push([
    {
      id: newId(),
      author: opts.author,
      text: opts.text,
      createdAt: new Date().toISOString(),
    },
  ]);
}

export function setResolved(doc: Y.Doc, threadId: string, resolved: boolean): void {
  const thread = findById(doc.getArray<Y.Map<unknown>>(COMMENTS_FIELD), threadId);
  thread?.set('resolved', resolved);
}

export function snapshotComments(doc: Y.Doc): CommentThreadData[] {
  const threads = doc.getArray<Y.Map<unknown>>(COMMENTS_FIELD);
  return threads.map((t) => ({
    id: t.get('id') as string,
    from: resolveAnchor(doc, t.get('anchorStart') as string),
    to: resolveAnchor(doc, t.get('anchorEnd') as string),
    resolved: Boolean(t.get('resolved')),
    createdAt: t.get('createdAt') as string,
    replies: (t.get('replies') as Y.Array<CommentReplyData>).toArray(),
  }));
}

// --- Suggestions ---------------------------------------------------------------

export function addSuggestion(
  doc: Y.Doc,
  ytext: Y.Text,
  opts: {
    from: number;
    to: number;
    author: string;
    original: string;
    proposed: string;
  },
): string {
  const id = newId();
  const arr = doc.getArray<Y.Map<unknown>>(SUGGESTIONS_FIELD);
  doc.transact(() => {
    const s = new Y.Map<unknown>();
    s.set('id', id);
    s.set('anchorStart', encodeAnchor(ytext, opts.from, 0));
    s.set('anchorEnd', encodeAnchor(ytext, opts.to, -1));
    s.set('author', opts.author);
    s.set('original', opts.original);
    s.set('proposed', opts.proposed);
    s.set('status', 'open' satisfies SuggestionStatus);
    s.set('createdAt', new Date().toISOString());
    arr.push([s]);
  });
  return id;
}

/**
 * Apply a suggestion to the text and mark it accepted. The anchors are
 * resolved at accept time, so the replacement lands in the right place even
 * if surrounding text has changed since the suggestion was made. Returns
 * false (and marks it rejected) if the anchored range no longer exists.
 */
export function acceptSuggestion(
  doc: Y.Doc,
  ytext: Y.Text,
  suggestionId: string,
  origin?: unknown,
): boolean {
  const s = findById(doc.getArray<Y.Map<unknown>>(SUGGESTIONS_FIELD), suggestionId);
  if (!s || s.get('status') !== 'open') return false;

  const from = resolveAnchor(doc, s.get('anchorStart') as string);
  const to = resolveAnchor(doc, s.get('anchorEnd') as string);
  if (from === null || to === null || to < from) {
    s.set('status', 'rejected' satisfies SuggestionStatus);
    return false;
  }

  doc.transact(() => {
    if (to > from) ytext.delete(from, to - from);
    const proposed = s.get('proposed') as string;
    if (proposed) ytext.insert(from, proposed);
    s.set('status', 'accepted' satisfies SuggestionStatus);
  }, origin);
  return true;
}

export function rejectSuggestion(doc: Y.Doc, suggestionId: string): void {
  const s = findById(doc.getArray<Y.Map<unknown>>(SUGGESTIONS_FIELD), suggestionId);
  if (s && s.get('status') === 'open') {
    s.set('status', 'rejected' satisfies SuggestionStatus);
  }
}

/**
 * Re-target an open suggestion: re-anchor it to [from, to), refresh `original`
 * from the current text, and replace `proposed`. This is how realtime
 * suggesting coalesces a stream of keystrokes into one reviewable suggestion
 * instead of one suggestion per keypress.
 */
export function updateSuggestion(
  doc: Y.Doc,
  ytext: Y.Text,
  suggestionId: string,
  opts: { from: number; to: number; proposed: string },
): boolean {
  const s = findById(doc.getArray<Y.Map<unknown>>(SUGGESTIONS_FIELD), suggestionId);
  if (!s || s.get('status') !== 'open') return false;
  doc.transact(() => {
    s.set('anchorStart', encodeAnchor(ytext, opts.from, 0));
    s.set('anchorEnd', encodeAnchor(ytext, opts.to, -1));
    s.set('original', ytext.toString().slice(opts.from, opts.to));
    s.set('proposed', opts.proposed);
  });
  return true;
}

/** Delete a suggestion outright (used when a realtime suggestion is undone to a no-op). */
export function removeSuggestion(doc: Y.Doc, suggestionId: string): void {
  const arr = doc.getArray<Y.Map<unknown>>(SUGGESTIONS_FIELD);
  for (let i = 0; i < arr.length; i++) {
    if (arr.get(i).get('id') === suggestionId) {
      arr.delete(i, 1);
      return;
    }
  }
}

function toSuggestionData(doc: Y.Doc, s: Y.Map<unknown>): SuggestionData {
  return {
    id: s.get('id') as string,
    from: resolveAnchor(doc, s.get('anchorStart') as string),
    to: resolveAnchor(doc, s.get('anchorEnd') as string),
    author: s.get('author') as string,
    original: s.get('original') as string,
    proposed: s.get('proposed') as string,
    status: s.get('status') as SuggestionStatus,
    createdAt: s.get('createdAt') as string,
  };
}

export function getSuggestion(doc: Y.Doc, suggestionId: string): SuggestionData | null {
  const s = findById(doc.getArray<Y.Map<unknown>>(SUGGESTIONS_FIELD), suggestionId);
  return s ? toSuggestionData(doc, s) : null;
}

export function snapshotSuggestions(doc: Y.Doc): SuggestionData[] {
  const arr = doc.getArray<Y.Map<unknown>>(SUGGESTIONS_FIELD);
  return arr.map((s) => toSuggestionData(doc, s));
}

// --- shared ----------------------------------------------------------------

function findById(
  arr: Y.Array<Y.Map<unknown>>,
  id: string,
): Y.Map<unknown> | undefined {
  for (const item of arr) {
    if (item.get('id') === id) return item;
  }
  return undefined;
}
