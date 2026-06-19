import type { RangeEdit } from '@markup/sync-core';

/**
 * Self-protection (Phase 2): a multi-megabyte document run through
 * diff-match-patch on every keystroke is a DoS on ourselves. `maxBytes <= 0`
 * disables the guard.
 */
export function exceedsByteLimit(content: string, maxBytes: number): boolean {
  return maxBytes > 0 && Buffer.byteLength(content, 'utf8') > maxBytes;
}

/**
 * Apply RangeEdits to a plain string — used to size-check the result of the
 * multi-edits route before committing it to the Y.Doc. Applies in descending
 * `from` order so earlier offsets stay valid as later splices resize the text.
 */
export function applyRangeEditsToString(
  content: string,
  edits: RangeEdit[],
): string {
  let out = content;
  for (const e of [...edits].sort((a, b) => b.from - a.from)) {
    out = out.slice(0, e.from) + e.insert + out.slice(e.to);
  }
  return out;
}
