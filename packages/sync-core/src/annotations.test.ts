import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import {
  addComment,
  addReply,
  setResolved,
  snapshotComments,
  addSuggestion,
  acceptSuggestion,
  rejectSuggestion,
  updateSuggestion,
  removeSuggestion,
  getSuggestion,
  snapshotSuggestions,
  encodeAnchor,
  resolveAnchor,
} from './annotations.js';

function makeDoc(content: string) {
  const doc = new Y.Doc();
  const ytext = doc.getText('content');
  ytext.insert(0, content);
  return { doc, ytext };
}

describe('ids', () => {
  it('generates unique uuid-shaped ids', () => {
    const { doc, ytext } = makeDoc('hello world hello world');
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const id = addComment(doc, ytext, {
        from: 0,
        to: 5,
        author: 'a',
        text: 't',
      });
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      ids.add(id);
    }
    expect(ids.size).toBe(100);
  });
});

describe('anchors', () => {
  it('round-trips an index', () => {
    const { doc, ytext } = makeDoc('hello world');
    const a = encodeAnchor(ytext, 6);
    expect(resolveAnchor(doc, a)).toBe(6);
  });

  it('follows text as edits happen before it', () => {
    const { doc, ytext } = makeDoc('hello world');
    const a = encodeAnchor(ytext, 6); // points at "world"
    ytext.insert(0, '>> ');
    expect(resolveAnchor(doc, a)).toBe(9);
  });
});

describe('comments', () => {
  it('creates a thread with an initial reply', () => {
    const { doc, ytext } = makeDoc('# Title\n\nSome text here.\n');
    addComment(doc, ytext, { from: 9, to: 13, author: 'james', text: 'why?' });
    const threads = snapshotComments(doc);
    expect(threads).toHaveLength(1);
    expect(threads[0].from).toBe(9);
    expect(threads[0].to).toBe(13);
    expect(threads[0].resolved).toBe(false);
    expect(threads[0].replies[0]).toMatchObject({ author: 'james', text: 'why?' });
  });

  it('replies and resolves', () => {
    const { doc, ytext } = makeDoc('abc def');
    const id = addComment(doc, ytext, { from: 0, to: 3, author: 'a', text: 'hm' });
    addReply(doc, id, { author: 'b', text: 'agreed' });
    setResolved(doc, id, true);
    const [t] = snapshotComments(doc);
    expect(t.replies).toHaveLength(2);
    expect(t.replies[1].text).toBe('agreed');
    expect(t.resolved).toBe(true);
  });

  it('keeps anchors attached through concurrent edits and syncs between peers', () => {
    const { doc, ytext } = makeDoc('one two three');
    addComment(doc, ytext, { from: 4, to: 7, author: 'a', text: 'on "two"' });

    // Sync to a second peer.
    const doc2 = new Y.Doc();
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc));

    // Peer 1 inserts text before the anchored range.
    ytext.insert(0, 'zero ');
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc));

    const [t] = snapshotComments(doc2);
    expect(t.from).toBe(9);
    expect(t.to).toBe(12);
    expect(doc2.getText('content').toString().slice(t.from!, t.to!)).toBe('two');
  });
});

describe('suggestions', () => {
  it('accepts a suggestion, replacing the anchored range', () => {
    const { doc, ytext } = makeDoc('the quick brown fox');
    const id = addSuggestion(doc, ytext, {
      from: 4,
      to: 9,
      author: 'a',
      original: 'quick',
      proposed: 'slow',
    });
    expect(acceptSuggestion(doc, ytext, id)).toBe(true);
    expect(ytext.toString()).toBe('the slow brown fox');
    expect(snapshotSuggestions(doc)[0].status).toBe('accepted');
  });

  it('accepts correctly even after earlier text changed', () => {
    const { doc, ytext } = makeDoc('the quick brown fox');
    const id = addSuggestion(doc, ytext, {
      from: 4,
      to: 9,
      author: 'a',
      original: 'quick',
      proposed: 'slow',
    });
    ytext.insert(0, 'look: '); // someone edits before the range
    expect(acceptSuggestion(doc, ytext, id)).toBe(true);
    expect(ytext.toString()).toBe('look: the slow brown fox');
  });

  it('rejects without changing the text', () => {
    const { doc, ytext } = makeDoc('hello');
    const id = addSuggestion(doc, ytext, {
      from: 0,
      to: 5,
      author: 'a',
      original: 'hello',
      proposed: 'goodbye',
    });
    rejectSuggestion(doc, id);
    expect(ytext.toString()).toBe('hello');
    expect(snapshotSuggestions(doc)[0].status).toBe('rejected');
    // A rejected suggestion can no longer be accepted.
    expect(acceptSuggestion(doc, ytext, id)).toBe(false);
    expect(ytext.toString()).toBe('hello');
  });

  it('handles pure insertion (empty range)', () => {
    const { doc, ytext } = makeDoc('ab');
    const id = addSuggestion(doc, ytext, {
      from: 1,
      to: 1,
      author: 'a',
      original: '',
      proposed: 'X',
    });
    expect(acceptSuggestion(doc, ytext, id)).toBe(true);
    expect(ytext.toString()).toBe('aXb');
  });
});

describe('realtime suggestion coalescing', () => {
  it('updateSuggestion re-anchors the range and refreshes original/proposed', () => {
    const { doc, ytext } = makeDoc('the quick brown fox');
    const id = addSuggestion(doc, ytext, {
      from: 4,
      to: 4,
      author: 'a',
      original: '',
      proposed: 'v',
    });
    // Grow the suggestion to also delete "quick " and propose "very slow ".
    expect(
      updateSuggestion(doc, ytext, id, { from: 4, to: 10, proposed: 'very slow ' }),
    ).toBe(true);
    const s = getSuggestion(doc, id)!;
    expect(s.from).toBe(4);
    expect(s.to).toBe(10);
    expect(s.original).toBe('quick ');
    expect(s.proposed).toBe('very slow ');
    expect(acceptSuggestion(doc, ytext, id)).toBe(true);
    expect(ytext.toString()).toBe('the very slow brown fox');
  });

  it('updateSuggestion refuses non-open suggestions', () => {
    const { doc, ytext } = makeDoc('hello');
    const id = addSuggestion(doc, ytext, {
      from: 0,
      to: 5,
      author: 'a',
      original: 'hello',
      proposed: 'bye',
    });
    rejectSuggestion(doc, id);
    expect(updateSuggestion(doc, ytext, id, { from: 0, to: 5, proposed: 'x' })).toBe(
      false,
    );
    expect(getSuggestion(doc, id)!.proposed).toBe('bye');
  });

  it('removeSuggestion deletes it entirely', () => {
    const { doc, ytext } = makeDoc('hello');
    const id = addSuggestion(doc, ytext, {
      from: 1,
      to: 1,
      author: 'a',
      original: '',
      proposed: 'x',
    });
    removeSuggestion(doc, id);
    expect(getSuggestion(doc, id)).toBeNull();
    expect(snapshotSuggestions(doc)).toHaveLength(0);
  });

  it('updated anchors still follow concurrent edits', () => {
    const { doc, ytext } = makeDoc('one two three');
    const id = addSuggestion(doc, ytext, {
      from: 4,
      to: 4,
      author: 'a',
      original: '',
      proposed: '',
    });
    updateSuggestion(doc, ytext, id, { from: 4, to: 7, proposed: 'TWO' });
    ytext.insert(0, 'zero '); // concurrent edit before the range
    const s = getSuggestion(doc, id)!;
    expect(s.from).toBe(9);
    expect(s.to).toBe(12);
    expect(acceptSuggestion(doc, ytext, id)).toBe(true);
    expect(ytext.toString()).toBe('zero one TWO three');
  });
});
