import {
  EditorSelection,
  EditorState,
  type Extension,
  type TransactionSpec,
} from '@codemirror/state';
import type { SuggestionData } from '@markup/sync-core';

/**
 * Realtime "Suggesting" mode (Google Docs style): while enabled, user edits
 * in the source editor never touch the document. Each keystroke is
 * intercepted via a CodeMirror transactionFilter and recorded as a
 * suggestion object instead — the same objects the select-and-propose flow
 * and the REST agent surface create, so accept/reject/sync all just work.
 *
 * Coalescing: a run of edits that keeps touching the same suggestion's range
 * folds into that one suggestion (one reviewable unit), tracked by a local
 * "session" (suggestion id + caret offset inside its proposed text). Moving
 * the cursor elsewhere starts a new suggestion. Multi-range transactions
 * (toolbar formatting, e.g. wrapping a selection in **bold**) become one
 * discrete suggestion covering the whole span.
 */

export interface SuggestSession {
  /** Id of the open suggestion this run of keystrokes is folding into. */
  id: string;
  /** Caret position inside the suggestion's `proposed` string. */
  caret: number;
}

/**
 * Where intercepted edits land. Editors write suggestion objects straight
 * into the shared Y.Doc; the suggester role (whose WS connection is
 * read-only) uses a REST-backed store with a local optimistic overlay.
 */
export interface SuggestionStore {
  add(opts: {
    from: number;
    to: number;
    original: string;
    proposed: string;
  }): string;
  get(id: string): SuggestionData | null;
  update(id: string, opts: { from: number; to: number; proposed: string }): void;
  remove(id: string): void;
}

export interface SuggestModeOptions {
  enabled: () => boolean;
  store: () => SuggestionStore;
  /** Current document text (for `original` slices). */
  text: () => string;
  session: { current: SuggestSession | null };
}

interface Edit {
  fromA: number;
  toA: number;
  insert: string;
  backward: boolean;
}

/**
 * Fold one intercepted edit into the suggestion layer. Returns where the
 * cursor should sit afterwards (document coordinates — the doc is unchanged).
 */
export function recordSuggestionEdit(
  store: SuggestionStore,
  text: string,
  session: { current: SuggestSession | null },
  edit: Edit,
): number {
  const { fromA, toA, insert, backward } = edit;

  const active = session.current ? store.get(session.current.id) : null;
  const open =
    active && active.status === 'open' && active.from !== null && active.to !== null
      ? active
      : null;
  // "Touches" = overlaps or is directly adjacent to the active suggestion.
  const touches = open !== null && fromA <= open.to! && toA >= open.from!;

  if (!open || !touches) {
    const id = store.add({
      from: fromA,
      to: toA,
      original: text.slice(fromA, toA),
      proposed: insert,
    });
    session.current = { id, caret: insert.length };
    return fromA;
  }

  const sess = session.current!;
  const caret = Math.max(0, Math.min(sess.caret, open.proposed.length));
  let from = open.from!;
  let to = open.to!;
  let proposed = open.proposed;

  if (toA === fromA) {
    // Pure insertion at/inside the suggestion: splice into proposed text.
    proposed = proposed.slice(0, caret) + insert + proposed.slice(caret);
    sess.caret = caret + insert.length;
    store.update(open.id, { from, to, proposed });
    return fromA;
  }

  if (insert === '' && toA - fromA === 1) {
    if (backward && caret > 0) {
      // Backspace with pending proposed text: un-type instead of widening.
      proposed = proposed.slice(0, caret - 1) + proposed.slice(caret);
      sess.caret = caret - 1;
      if (proposed === '' && from === to) {
        // The whole suggestion was typed and then un-typed: drop it.
        store.remove(open.id);
        session.current = null;
        return toA;
      }
      store.update(open.id, { from, to, proposed });
      return toA;
    }
    if (!backward && caret < proposed.length) {
      // Delete-forward with proposed text after the caret: un-type it.
      proposed = proposed.slice(0, caret) + proposed.slice(caret + 1);
      store.update(open.id, { from, to, proposed });
      return fromA;
    }
  }

  // Deletion (or replacement) of real document text: widen the suggested
  // range to cover it; any typed text splices into proposed at the caret.
  from = Math.min(from, fromA);
  to = Math.max(to, toA);
  if (insert) {
    proposed = proposed.slice(0, caret) + insert + proposed.slice(caret);
    sess.caret = caret + insert.length;
  }
  store.update(open.id, { from, to, proposed });
  return fromA;
}

/** CodeMirror extension implementing the keystroke interception. */
export function suggestModeFilter(opts: SuggestModeOptions): Extension {
  return EditorState.transactionFilter.of((tr): TransactionSpec | TransactionSpec[] => {
    if (!opts.enabled() || !tr.docChanged) return tr;
    // Only intercept direct user edits; remote Yjs updates (applied by the
    // yCollab binding) and programmatic dispatches must pass through.
    // Toolbar formatting dispatches with userEvent 'input.format'.
    if (!(tr.isUserEvent('input') || tr.isUserEvent('delete'))) return tr;

    // Count the changes; collect the overall span.
    let fromA = -1;
    let toA = -1;
    let insert = '';
    let count = 0;
    tr.changes.iterChanges((fA, tA, _fB, _tB, ins) => {
      if (fromA === -1) fromA = fA;
      toA = tA;
      insert += ins.toString();
      count++;
    });
    if (fromA === -1) return tr;

    const text = opts.text();

    if (count > 1) {
      // Multi-range transaction (formatting): one discrete suggestion whose
      // proposed text is what the span would have become.
      const fromB = tr.changes.mapPos(fromA, -1);
      const toB = tr.changes.mapPos(toA, 1);
      const id = opts.store().add({
        from: fromA,
        to: toA,
        original: text.slice(fromA, toA),
        proposed: tr.newDoc.sliceString(fromB, toB),
      });
      opts.session.current = { id, caret: 0 };
      return { selection: EditorSelection.cursor(fromA), scrollIntoView: true };
    }

    const caret = recordSuggestionEdit(opts.store(), text, opts.session, {
      fromA,
      toA,
      insert,
      backward: tr.isUserEvent('delete.backward'),
    });

    // Drop the doc change; just park the cursor (positions are in the
    // unchanged doc, since the edit never applied).
    return { selection: EditorSelection.cursor(caret), scrollIntoView: true };
  });
}
