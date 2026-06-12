import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { applyStringToYText } from './ytext.js';

function freshText(initial = ''): Y.Text {
  const doc = new Y.Doc();
  const t = doc.getText('content');
  if (initial) t.insert(0, initial);
  return t;
}

describe('applyStringToYText', () => {
  it('is a no-op when the string is already equal', () => {
    const t = freshText('# Hello\n');
    const changed = applyStringToYText(t, '# Hello\n');
    expect(changed).toBe(false);
    expect(t.toString()).toBe('# Hello\n');
  });

  it('reconciles to the target string', () => {
    const t = freshText('# Hello\n');
    const changed = applyStringToYText(t, '# Hello world\n\nA paragraph.\n');
    expect(changed).toBe(true);
    expect(t.toString()).toBe('# Hello world\n\nA paragraph.\n');
  });

  it('handles insertion at the start', () => {
    const t = freshText('world');
    applyStringToYText(t, 'hello world');
    expect(t.toString()).toBe('hello world');
  });

  it('handles deletion in the middle', () => {
    const t = freshText('hello cruel world');
    applyStringToYText(t, 'hello world');
    expect(t.toString()).toBe('hello world');
  });

  it('handles full replacement', () => {
    const t = freshText('completely different');
    applyStringToYText(t, 'brand new content');
    expect(t.toString()).toBe('brand new content');
  });

  it('handles emptying the text', () => {
    const t = freshText('some content');
    applyStringToYText(t, '');
    expect(t.toString()).toBe('');
  });

  it('applies as a single transaction', () => {
    const doc = new Y.Doc();
    const t = doc.getText('content');
    t.insert(0, 'the quick brown fox');
    let transactions = 0;
    doc.on('afterTransaction', () => {
      transactions++;
    });
    applyStringToYText(t, 'the slow brown dog');
    expect(transactions).toBe(1);
    expect(t.toString()).toBe('the slow brown dog');
  });

  it('preserves a concurrent insert in an untouched region (CRDT merge)', () => {
    // Two peers start from the same state.
    const docA = new Y.Doc();
    const a = docA.getText('content');
    a.insert(0, 'AAAA\nBBBB\n');

    const docB = new Y.Doc();
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const b = docB.getText('content');

    // Peer A edits the first line via a full-string reconcile.
    applyStringToYText(a, 'AXAA\nBBBB\n');
    // Peer B concurrently appends a new line at the end.
    b.insert(b.length, 'CCCC\n');

    // Exchange updates.
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));

    // Both peers converge and B's untouched-region edit survives.
    expect(a.toString()).toBe(b.toString());
    expect(a.toString()).toBe('AXAA\nBBBB\nCCCC\n');
  });

  it('tags the transaction with the provided origin', () => {
    const doc = new Y.Doc();
    const t = doc.getText('content');
    t.insert(0, 'start');
    const origin = Symbol('disk');
    let seen: unknown = null;
    doc.on('afterTransaction', (tr) => {
      seen = tr.origin;
    });
    applyStringToYText(t, 'started', origin);
    expect(seen).toBe(origin);
  });
});
