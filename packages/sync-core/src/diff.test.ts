import { describe, it, expect } from 'vitest';
import { mapOffsetThroughDiff, lineDiff } from './diff.js';

/** Map a [from, to) plain-text range into the markdown source. */
function mapRange(plain: string, md: string, from: number, to: number) {
  return {
    from: mapOffsetThroughDiff(plain, md, from, 'right'),
    to: mapOffsetThroughDiff(plain, md, to, 'left'),
  };
}

describe('mapOffsetThroughDiff', () => {
  it('is identity when the strings are equal', () => {
    expect(mapOffsetThroughDiff('hello world', 'hello world', 6)).toBe(6);
  });

  it('maps a selection of bold text to exactly the inner word', () => {
    const plain = 'Hello world';
    const md = 'Hello **world**';
    const sel = plain.indexOf('world');
    const r = mapRange(plain, md, sel, sel + 'world'.length);
    expect(md.slice(r.from, r.to)).toBe('world');
  });

  it('skips a heading marker for a selection at line start', () => {
    const plain = 'Title\nbody text';
    const md = '# Title\n\nbody text';
    const r = mapRange(plain, md, 0, 5);
    expect(md.slice(r.from, r.to)).toBe('Title');
  });

  it('skips list markers', () => {
    const plain = 'one\ntwo\nthree';
    const md = '- one\n- two\n- three';
    const sel = plain.indexOf('two');
    const r = mapRange(plain, md, sel, sel + 3);
    expect(md.slice(r.from, r.to)).toBe('two');
  });

  it('maps a multi-word selection spanning inline marks', () => {
    const plain = 'a bold word here';
    const md = 'a **bold** word here';
    const sel = plain.indexOf('bold word');
    const r = mapRange(plain, md, sel, sel + 'bold word'.length);
    expect(md.slice(r.from, r.to)).toBe('bold** word');
  });

  it('clamps offsets past the end to the end of `to`', () => {
    expect(mapOffsetThroughDiff('abc', 'abcdef', 99)).toBe(6);
  });
});

describe('lineDiff', () => {
  it('reports added and removed lines', () => {
    const chunks = lineDiff('a\nb\nc\n', 'a\nX\nc\n');
    const dels = chunks.filter((c) => c.op === 'del').flatMap((c) => c.lines);
    const adds = chunks.filter((c) => c.op === 'add').flatMap((c) => c.lines);
    expect(dels).toEqual(['b']);
    expect(adds).toEqual(['X']);
  });
});
