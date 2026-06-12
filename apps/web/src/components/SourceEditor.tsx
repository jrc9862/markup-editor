'use client';

import { useEffect, useRef } from 'react';
import type * as Y from 'yjs';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import {
  EditorView,
  keymap,
  lineNumbers,
  Decoration,
  WidgetType,
} from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { EditorState, StateEffect, StateField } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { yCollab } from 'y-codemirror.next';
import type { PresenceUser, SuggestionData } from '@markup/sync-core';
import type { EditorHandle, FormatTarget } from './format';
import { suggestModeFilter, type SuggestSession } from './suggestMode';

export interface CommentRange {
  from: number;
  to: number;
}

// --- comment highlights -------------------------------------------------------

const setCommentRanges = StateEffect.define<CommentRange[]>();
const commentMark = Decoration.mark({ class: 'cm-comment-range' });

const commentField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setCommentRanges)) {
        const max = tr.newDoc.length;
        deco = Decoration.set(
          e.value
            .filter((h) => h.from < h.to && h.from < max)
            .sort((a, b) => a.from - b.from)
            .map((h) => commentMark.range(h.from, Math.min(h.to, max))),
          true,
        );
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// --- inline suggestions ----------------------------------------------------------

interface InlineSuggestion {
  id: string;
  from: number;
  to: number;
  proposed: string;
  author: string;
}

interface SuggestionHandlers {
  accept: (id: string) => void;
  reject: (id: string) => void;
}

const setSuggestions = StateEffect.define<{
  items: InlineSuggestion[];
  handlers: SuggestionHandlers;
}>();

const suggestionDelMark = Decoration.mark({ class: 'cm-suggestion-del' });

/** Inline "→ proposed  ✓ ✕" widget rendered right after the targeted text. */
class SuggestionWidget extends WidgetType {
  constructor(
    readonly s: InlineSuggestion,
    readonly handlers: SuggestionHandlers,
  ) {
    super();
  }

  eq(other: SuggestionWidget): boolean {
    return other.s.id === this.s.id && other.s.proposed === this.s.proposed;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'cm-suggestion-inline';
    wrap.title = `suggested by ${this.s.author}`;

    const proposed = document.createElement('span');
    proposed.className = 'cm-suggestion-proposed';
    proposed.textContent = this.s.proposed || '∅';
    wrap.appendChild(proposed);

    const accept = document.createElement('button');
    accept.className = 'cm-suggestion-btn accept';
    accept.textContent = '✓';
    accept.title = 'Accept suggestion';
    accept.onmousedown = (e) => {
      e.preventDefault();
      this.handlers.accept(this.s.id);
    };
    wrap.appendChild(accept);

    const reject = document.createElement('button');
    reject.className = 'cm-suggestion-btn reject';
    reject.textContent = '✕';
    reject.title = 'Reject suggestion';
    reject.onmousedown = (e) => {
      e.preventDefault();
      this.handlers.reject(this.s.id);
    };
    wrap.appendChild(reject);

    return wrap;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

const suggestionField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setSuggestions)) {
        const max = tr.newDoc.length;
        const ranges = [];
        for (const s of e.value.items) {
          if (s.from > max) continue;
          const to = Math.min(s.to, max);
          if (to > s.from) {
            ranges.push(suggestionDelMark.range(s.from, to));
          }
          ranges.push(
            Decoration.widget({
              widget: new SuggestionWidget(s, e.value.handlers),
              side: 1,
            }).range(to),
          );
        }
        deco = Decoration.set(
          ranges.sort((a, b) => a.from - b.from || a.to - b.to),
          true,
        );
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// --- formatting (markdown text manipulation) -----------------------------------

function makeFormat(view: EditorView): FormatTarget {
  const wrapInline = (left: string, right = left) => {
    const { from, to } = view.state.selection.main;
    const sel = view.state.sliceDoc(from, to);
    view.dispatch({
      changes: { from, to, insert: `${left}${sel}${right}` },
      selection: {
        anchor: from + left.length,
        head: from + left.length + sel.length,
      },
    });
    view.focus();
  };

  const eachSelectedLine = (
    fn: (text: string) => string | null,
  ) => {
    const { from, to } = view.state.selection.main;
    const first = view.state.doc.lineAt(from).number;
    const last = view.state.doc.lineAt(to).number;
    const changes = [];
    for (let n = first; n <= last; n++) {
      const line = view.state.doc.line(n);
      const next = fn(line.text);
      if (next !== null && next !== line.text) {
        changes.push({ from: line.from, to: line.to, insert: next });
      }
    }
    if (changes.length) view.dispatch({ changes });
    view.focus();
  };

  const insertBlock = (block: string) => {
    const line = view.state.doc.lineAt(view.state.selection.main.to);
    view.dispatch({
      changes: { from: line.to, to: line.to, insert: `\n\n${block}\n` },
    });
    view.focus();
  };

  return {
    heading: (level) =>
      eachSelectedLine((text) => {
        const body = text.replace(/^#{1,6}\s+/, '');
        return level === 0 ? body : `${'#'.repeat(level)} ${body}`;
      }),
    bold: () => wrapInline('**'),
    italic: () => wrapInline('*'),
    underline: () => wrapInline('<u>', '</u>'),
    inlineCode: () => wrapInline('`'),
    codeBlock: () => {
      const { from, to } = view.state.selection.main;
      const first = view.state.doc.lineAt(from);
      const last = view.state.doc.lineAt(to);
      view.dispatch({
        changes: [
          { from: first.from, to: first.from, insert: '```\n' },
          { from: last.to, to: last.to, insert: '\n```' },
        ],
      });
      view.focus();
    },
    quote: () => eachSelectedLine((text) => `> ${text}`),
    bulletList: () => eachSelectedLine((text) => `- ${text}`),
    insertTable: (rows, cols) => {
      const header = `| ${Array.from({ length: cols }, (_, i) => `Col ${i + 1}`).join(' | ')} |`;
      const sep = `| ${Array.from({ length: cols }, () => '---').join(' | ')} |`;
      const body = Array.from(
        { length: rows },
        () => `| ${Array.from({ length: cols }, () => '   ').join(' | ')} |`,
      );
      insertBlock([header, sep, ...body].join('\n'));
    },
    horizontalRule: () => insertBlock('---'),
  };
}

/**
 * Source mode: CodeMirror 6 bound directly to the canonical Y.Text.
 * This is the byte-perfect, true-CRDT editing path.
 */
export default function SourceEditor({
  ytext,
  provider,
  user,
  commentRanges,
  suggestions,
  suggesting,
  onAccept,
  onReject,
  focusRange,
  onSelectionChange,
  onReady,
}: {
  ytext: Y.Text;
  provider: HocuspocusProvider;
  user: PresenceUser;
  commentRanges: CommentRange[];
  suggestions: SuggestionData[];
  /** Realtime suggestion mode: keystrokes become suggestions, not edits. */
  suggesting: boolean;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  focusRange: { from: number; to: number; key: number } | null;
  onSelectionChange: (sel: { from: number; to: number } | null) => void;
  onReady: (handle: EditorHandle | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onSelRef = useRef(onSelectionChange);
  onSelRef.current = onSelectionChange;
  const handlersRef = useRef({ accept: onAccept, reject: onReject });
  handlersRef.current = { accept: onAccept, reject: onReject };
  const suggestingRef = useRef(suggesting);
  suggestingRef.current = suggesting;
  const sessionRef = useRef<SuggestSession | null>(null);

  // Leaving suggest mode ends the current coalescing run; the next keystroke
  // after re-enabling starts a fresh suggestion.
  useEffect(() => {
    if (!suggesting) sessionRef.current = null;
  }, [suggesting]);

  useEffect(() => {
    if (!host.current || !provider.awareness) return;

    // y-codemirror.next reads cursor identity from the awareness 'user' field.
    provider.awareness.setLocalStateField('user', {
      name: user.name,
      color: user.color,
      colorLight: `${user.color}33`,
    });

    const state = EditorState.create({
      doc: ytext.toString(),
      extensions: [
        lineNumbers(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        markdown(),
        EditorView.lineWrapping,
        yCollab(ytext, provider.awareness),
        suggestModeFilter({
          enabled: () => suggestingRef.current,
          author: () => user.name,
          ytext: () => ytext,
          session: sessionRef,
        }),
        commentField,
        suggestionField,
        EditorView.updateListener.of((u) => {
          if (u.selectionSet || u.docChanged) {
            const r = u.state.selection.main;
            onSelRef.current(
              r.empty
                ? null
                : { from: Math.min(r.from, r.to), to: Math.max(r.from, r.to) },
            );
          }
        }),
      ],
    });
    const view = new EditorView({ state, parent: host.current });
    viewRef.current = view;

    onReady({
      format: makeFormat(view),
      measurer: {
        topOfOffset(mdOffset) {
          const pos = Math.max(0, Math.min(mdOffset, view.state.doc.length));
          // lineBlockAt works even for unrendered lines (doc coordinates).
          return view.lineBlockAt(pos).top + view.documentTop;
        },
      },
    });

    return () => {
      onReady(null);
      viewRef.current = null;
      view.destroy();
      onSelRef.current(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ytext, provider, user]);

  // Push comment highlight ranges into the editor whenever they change.
  useEffect(() => {
    viewRef.current?.dispatch({ effects: setCommentRanges.of(commentRanges) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(commentRanges)]);

  // Push open suggestions as inline strikethrough + proposed-text widgets.
  useEffect(() => {
    const items: InlineSuggestion[] = suggestions
      .filter((s) => s.status === 'open' && s.from !== null && s.to !== null)
      .map((s) => ({
        id: s.id,
        from: s.from!,
        to: s.to!,
        proposed: s.proposed,
        author: s.author,
      }));
    viewRef.current?.dispatch({
      effects: setSuggestions.of({
        items,
        handlers: {
          accept: (id) => handlersRef.current.accept(id),
          reject: (id) => handlersRef.current.reject(id),
        },
      }),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(suggestions)]);

  // Scroll to a range when a floating card asks for it.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !focusRange) return;
    const max = view.state.doc.length;
    const from = Math.min(focusRange.from, max);
    view.dispatch({
      selection: { anchor: from, head: Math.min(focusRange.to, max) },
      effects: EditorView.scrollIntoView(from, { y: 'center' }),
    });
    view.focus();
  }, [focusRange]);

  return <div ref={host} />;
}
