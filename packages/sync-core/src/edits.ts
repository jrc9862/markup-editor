import type * as Y from 'yjs';

/** A single range replacement: replace [from, to) with `insert`. */
export interface RangeEdit {
  from: number;
  to: number;
  insert: string;
}

/**
 * Apply multiple non-overlapping range replacements to a Y.Text in ONE
 * transaction, so the whole batch lands (and undoes) as a single step and
 * still merges cleanly with concurrent peers. Edits address offsets in the
 * *current* string; they are applied back-to-front so earlier offsets stay
 * valid as later ones mutate the text.
 *
 * Throws on an out-of-range or overlapping edit (touching ranges — to === the
 * next from — are allowed).
 *
 * @returns the number of edits applied.
 */
export function applyEdits(
  ytext: Y.Text,
  edits: RangeEdit[],
  origin?: unknown,
): number {
  if (edits.length === 0) return 0;
  const len = ytext.length;
  const sorted = [...edits].sort((a, b) => a.from - b.from);
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i];
    if (e.from < 0 || e.to > len || e.from > e.to) {
      throw new Error(`edit out of range: [${e.from}, ${e.to}) in ${len}`);
    }
    if (i > 0 && e.from < sorted[i - 1].to) {
      throw new Error('overlapping edits');
    }
  }
  const run = () => {
    for (let i = sorted.length - 1; i >= 0; i--) {
      const e = sorted[i];
      if (e.to > e.from) ytext.delete(e.from, e.to - e.from);
      if (e.insert) ytext.insert(e.from, e.insert);
    }
  };
  const doc = ytext.doc;
  if (doc) doc.transact(run, origin);
  else run();
  return sorted.length;
}

export interface FindReplaceOptions {
  /** Treat `find` as a JS regular expression. */
  regex?: boolean;
  /** Case-sensitive matching (default false). */
  caseSensitive?: boolean;
}

// Work bounds for find/replace, since `find` may be caller-supplied (the REST
// surface): a pattern length cap and a match-count cap keep a hostile input
// from burning unbounded CPU. A catastrophic-backtracking regex is the
// residual risk — a hard guarantee would need re2 or a worker timeout.
export const MAX_FIND_LENGTH = 1000;
export const MAX_FIND_MATCHES = 100_000;

/** Expand `$&`, `$1`..`$9`, and `$$` in a regex replacement template. */
function expandTemplate(template: string, match: RegExpMatchArray): string {
  return template.replace(/\$(\$|&|\d{1,2})/g, (_full, token: string) => {
    if (token === '$') return '$';
    if (token === '&') return match[0];
    const n = Number(token);
    return match[n] ?? '';
  });
}

/**
 * Compute the (non-overlapping, left-to-right) range edits for a find/replace
 * over `content`. Plain substring matching by default; `regex` opts into a JS
 * RegExp (with `$n` backrefs in `replace`). Feed the result to `applyEdits`
 * to land the whole batch as one undoable transaction.
 */
export function findReplaceEdits(
  content: string,
  find: string,
  replace: string,
  opts: FindReplaceOptions = {},
): RangeEdit[] {
  if (!find) return [];
  if (find.length > MAX_FIND_LENGTH) {
    throw new Error(`find pattern too long (max ${MAX_FIND_LENGTH} chars)`);
  }
  const edits: RangeEdit[] = [];
  const push = (edit: RangeEdit) => {
    if (edits.length >= MAX_FIND_MATCHES) {
      throw new Error(`too many matches (max ${MAX_FIND_MATCHES})`);
    }
    edits.push(edit);
  };

  if (opts.regex) {
    let flags = 'g';
    if (!opts.caseSensitive) flags += 'i';
    const re = new RegExp(find, flags);
    for (const m of content.matchAll(re)) {
      const from = m.index ?? 0;
      push({
        from,
        to: from + m[0].length,
        insert: expandTemplate(replace, m),
      });
    }
    return edits;
  }

  const hay = opts.caseSensitive ? content : content.toLowerCase();
  const needle = opts.caseSensitive ? find : find.toLowerCase();
  let idx = 0;
  while ((idx = hay.indexOf(needle, idx)) !== -1) {
    push({ from: idx, to: idx + find.length, insert: replace });
    idx += find.length || 1;
  }
  return edits;
}
