import { diff_match_patch } from 'diff-match-patch';

export type LineDiffOp = 'equal' | 'add' | 'del';

export interface LineDiffChunk {
  op: LineDiffOp;
  lines: string[];
}

/**
 * Map a character offset in `from` to the corresponding offset in `to`,
 * by aligning the two strings with a diff and walking it.
 *
 * Used to translate rendered-mode (plain text) selection offsets into
 * markdown-source offsets: markdown syntax (`#`, `**`, list markers…)
 * appears as to-only runs in the diff, which the walk skips over.
 *
 * `bias` decides which side of a run boundary an offset lands on:
 *  - 'right' (use for a range START): skips past to-only runs, so the
 *    mapped offset starts after opening syntax like `**`.
 *  - 'left' (use for a range END): stops before to-only runs, so the
 *    mapped offset ends before closing syntax.
 */
export function mapOffsetThroughDiff(
  from: string,
  to: string,
  offset: number,
  bias: 'left' | 'right' = 'left',
): number {
  if (offset <= 0 && bias === 'left') return 0;
  const dmp = new diff_match_patch();
  const diffs = dmp.diff_main(from, to);
  let fi = 0; // cursor in `from`
  let ti = 0; // cursor in `to`
  for (const [op, text] of diffs) {
    if (op === 0) {
      const end = fi + text.length;
      if (offset < end || (offset === end && bias === 'left')) {
        return ti + Math.max(0, offset - fi);
      }
      fi = end;
      ti += text.length;
    } else if (op === -1) {
      // Present only in `from`: a from-side run collapses to one to-offset.
      const end = fi + text.length;
      if (offset < end || (offset === end && bias === 'left')) return ti;
      fi = end;
    } else {
      // Present only in `to` (e.g. markdown syntax): skip over it.
      ti += text.length;
    }
  }
  return ti;
}

/**
 * Line-level diff between two texts (for the history view). Uses
 * diff-match-patch's line-mode trick: map lines to chars, diff, map back.
 */
export function lineDiff(a: string, b: string): LineDiffChunk[] {
  const dmp = new diff_match_patch();
  const { chars1, chars2, lineArray } = dmp.diff_linesToChars_(a, b);
  const diffs = dmp.diff_main(chars1, chars2, false);
  dmp.diff_charsToLines_(diffs, lineArray);

  return diffs.map(([op, text]) => ({
    op: op === 0 ? 'equal' : op === 1 ? 'add' : 'del',
    // Split into lines, dropping the trailing empty string from the final \n.
    lines: text.split('\n').filter((l, i, arr) => i < arr.length - 1 || l !== ''),
  }));
}
