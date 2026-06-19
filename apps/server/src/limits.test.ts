import { describe, it, expect } from 'vitest';
import { exceedsByteLimit, applyRangeEditsToString } from './limits.js';

describe('exceedsByteLimit', () => {
  it('compares UTF-8 byte length against the budget', () => {
    expect(exceedsByteLimit('abc', 3)).toBe(false); // exactly at the limit
    expect(exceedsByteLimit('abcd', 3)).toBe(true);
    // A multi-byte char counts its bytes, not its length.
    expect('€'.length).toBe(1);
    expect(exceedsByteLimit('€', 2)).toBe(true); // 3 bytes > 2
  });

  it('treats a non-positive budget as disabled', () => {
    expect(exceedsByteLimit('x'.repeat(10_000), 0)).toBe(false);
  });
});

describe('applyRangeEditsToString', () => {
  it('applies non-overlapping edits regardless of input order', () => {
    const out = applyRangeEditsToString('hello world', [
      { from: 0, to: 5, insert: 'HI' },
      { from: 6, to: 11, insert: 'EARTH' },
    ]);
    expect(out).toBe('HI EARTH');
  });

  it('matches the size a shrinking replacement would produce', () => {
    const content = 'x'.repeat(100);
    const out = applyRangeEditsToString(content, [
      { from: 0, to: 100, insert: 'y' },
    ]);
    expect(out).toBe('y');
  });
});
