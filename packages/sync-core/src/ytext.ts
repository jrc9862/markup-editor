import { diff_match_patch } from 'diff-match-patch';
import type * as Y from 'yjs';

const dmp = new diff_match_patch();

/**
 * The name of the canonical Y.Text field that holds the full markdown string
 * for a document. The source editor binds to this directly; the rendered
 * editor and the CLI both project into/out of it.
 */
export const CONTENT_FIELD = 'content';

/**
 * Reconcile a Y.Text so its string value becomes `newString`, applying only
 * the minimal character-level inserts/deletes needed to get there.
 *
 * This is the keystone of the whole sync model. Because it produces minimal
 * char-level ops (rather than replacing the whole text), concurrent edits from
 * other peers merge cleanly through Yjs instead of being clobbered.
 *
 * Used by:
 *  - the CLI, to push disk changes into the shared doc (disk -> Y), and
 *  - the web rendered editor, to push WYSIWYG edits in (ProseMirror -> Y).
 *
 * @param ytext      the canonical Y.Text to mutate
 * @param newString  the desired final string value
 * @param origin     optional transaction origin, so observers can tell who
 *                   made the change and avoid feedback loops
 * @returns true if any change was applied, false if it was already equal
 */
export function applyStringToYText(
  ytext: Y.Text,
  newString: string,
  origin?: unknown,
): boolean {
  const current = ytext.toString();
  if (current === newString) return false;

  const diffs = dmp.diff_main(current, newString);
  // No cleanup pass: we want the smallest char-level ops so that merge
  // granularity stays as fine as possible for concurrent editing.

  const doc = ytext.doc;
  const run = () => {
    let index = 0;
    for (const [op, text] of diffs) {
      if (op === 0) {
        // EQUAL: skip over the unchanged region.
        index += text.length;
      } else if (op === -1) {
        // DELETE: remove this region; index stays put.
        ytext.delete(index, text.length);
      } else {
        // INSERT: add text at the cursor and advance past it.
        ytext.insert(index, text);
        index += text.length;
      }
    }
  };

  if (doc) {
    doc.transact(run, origin);
  } else {
    run();
  }
  return true;
}
