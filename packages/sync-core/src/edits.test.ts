import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { applyEdits, findReplaceEdits, type RangeEdit } from './edits.js';

function ytextOf(s: string): Y.Text {
  const doc = new Y.Doc();
  const t = doc.getText('content');
  t.insert(0, s);
  return t;
}

describe('applyEdits', () => {
  it('applies multiple ranges in one transaction', () => {
    const t = ytextOf('the quick brown fox');
    const edits: RangeEdit[] = [
      { from: 0, to: 3, insert: 'THE' },
      { from: 10, to: 15, insert: 'red' },
    ];
    let transactions = 0;
    t.doc!.on('afterTransaction', () => transactions++);
    const n = applyEdits(t, edits);
    expect(n).toBe(2);
    expect(t.toString()).toBe('THE quick red fox');
    expect(transactions).toBe(1); // one undoable step
  });

  it('handles out-of-order and inserts/deletes', () => {
    const t = ytextOf('abcdef');
    applyEdits(t, [
      { from: 4, to: 6, insert: '' }, // delete "ef"
      { from: 0, to: 0, insert: 'X' }, // insert at start
    ]);
    expect(t.toString()).toBe('Xabcd');
  });

  it('rejects overlapping or out-of-range edits', () => {
    const t = ytextOf('abcdef');
    expect(() =>
      applyEdits(t, [
        { from: 0, to: 3, insert: 'x' },
        { from: 2, to: 4, insert: 'y' },
      ]),
    ).toThrow(/overlapping/);
    expect(() => applyEdits(t, [{ from: 0, to: 99, insert: 'x' }])).toThrow(
      /out of range/,
    );
    // touching ranges (to === next from) are allowed
    expect(() =>
      applyEdits(t, [
        { from: 0, to: 3, insert: 'x' },
        { from: 3, to: 6, insert: 'y' },
      ]),
    ).not.toThrow();
  });
});

describe('findReplaceEdits', () => {
  it('replaces all plain substring matches', () => {
    const edits = findReplaceEdits('a foo b foo c', 'foo', 'bar');
    expect(edits).toHaveLength(2);
    const t = ytextOf('a foo b foo c');
    applyEdits(t, edits);
    expect(t.toString()).toBe('a bar b bar c');
  });

  it('is case-insensitive by default, case-sensitive on request', () => {
    expect(findReplaceEdits('Foo foo', 'foo', 'x')).toHaveLength(2);
    expect(
      findReplaceEdits('Foo foo', 'foo', 'x', { caseSensitive: true }),
    ).toHaveLength(1);
  });

  it('supports regex with backrefs', () => {
    const t = ytextOf('2026-06-19');
    applyEdits(
      t,
      findReplaceEdits('2026-06-19', '(\\d+)-(\\d+)-(\\d+)', '$3/$2/$1', {
        regex: true,
      }),
    );
    expect(t.toString()).toBe('19/06/2026');
  });
});
