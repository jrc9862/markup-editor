'use client';

import { useEffect, useRef } from 'react';
import * as Y from 'yjs';
import type { Transaction as YTransaction } from 'yjs';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import { Markdown } from 'tiptap-markdown';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { applyStringToYText, mapOffsetThroughDiff } from '@markup/sync-core';
import type { EditorHandle } from './format';

/**
 * Origin tag for Yjs transactions produced by this binding, so its own
 * observer can ignore them and not echo edits back into the editor.
 */
const BINDING_ORIGIN = 'markdown-text-binding';

function getMarkdown(editor: Editor): string {
  return editor.storage.markdown.getMarkdown();
}

/**
 * ProseMirror position for a plain-text offset (textBetween '\n' semantics).
 * textBetween length is monotonic in position, so binary search is exact.
 */
function pmPosFromPlainOffset(doc: PMNode, target: number): number {
  let lo = 0;
  let hi = doc.content.size;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (doc.textBetween(0, mid, '\n').length < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Map a markdown-offset range into a ProseMirror position range: the
 * inverse of the selection mapping (md -> plain text -> PM position).
 */
function pmRangeFromMdRange(
  doc: PMNode,
  md: string,
  plain: string,
  r: { from: number; to: number },
): { from: number; to: number } | null {
  const pf = mapOffsetThroughDiff(md, plain, r.from, 'right');
  const pt = mapOffsetThroughDiff(md, plain, r.to, 'left');
  if (pt <= pf) return null;
  const from = pmPosFromPlainOffset(doc, pf);
  const to = pmPosFromPlainOffset(doc, pt);
  return to > from ? { from, to } : null;
}

/**
 * Annotation highlights: comment/suggestion ranges as inline decorations.
 * Fresh decoration sets are pushed in via setMeta (ranges come from Yjs
 * anchors, recomputed by the parent on every doc update); between pushes,
 * decorations map through local edits so they don't flicker while typing.
 */
const annotationsKey = new PluginKey<DecorationSet>('mdAnnotations');

const annotationsPlugin = new Plugin<DecorationSet>({
  key: annotationsKey,
  state: {
    init: () => DecorationSet.empty,
    apply(tr, deco) {
      const next = tr.getMeta(annotationsKey) as DecorationSet | undefined;
      if (next) return next;
      return tr.docChanged ? deco.map(tr.mapping, tr.doc) : deco;
    },
  },
  props: {
    decorations(state) {
      return annotationsKey.getState(state);
    },
  },
});

/**
 * Remote cursors: rendered mode publishes/consumes the same awareness
 * `cursor` field as y-codemirror.next (relative positions on the canonical
 * Y.Text), so presence works across modes — a peer in source mode sees a
 * rendered-mode peer's caret and vice versa.
 */
const remoteCursorsKey = new PluginKey<DecorationSet>('remoteCursors');

const remoteCursorsPlugin = new Plugin<DecorationSet>({
  key: remoteCursorsKey,
  state: {
    init: () => DecorationSet.empty,
    apply(tr, deco) {
      const next = tr.getMeta(remoteCursorsKey) as DecorationSet | undefined;
      if (next) return next;
      return tr.docChanged ? deco.map(tr.mapping, tr.doc) : deco;
    },
  },
  props: {
    decorations(state) {
      return remoteCursorsKey.getState(state);
    },
  },
});

function remoteCaretDom(name: string, color: string): HTMLElement {
  const caret = document.createElement('span');
  caret.className = 'pm-remote-caret';
  caret.style.backgroundColor = color;
  const label = document.createElement('span');
  label.className = 'pm-remote-caret-label';
  label.style.backgroundColor = color;
  label.textContent = name;
  caret.appendChild(label);
  return caret;
}

/**
 * Rendered (WYSIWYG) mode. The canonical document is still the markdown
 * string in Y.Text; this editor is a projected view:
 *
 *  - Y.Text change (remote peer / source mode / CLI) -> re-parse markdown
 *    into the ProseMirror doc, restoring the cursor best-effort by position.
 *  - Local ProseMirror edit -> serialize to markdown -> minimal-diff into
 *    Y.Text via applyStringToYText (so concurrent edits still merge).
 */
export default function RenderedEditor({
  ytext,
  provider,
  commentRanges = [],
  suggestionRanges = [],
  focusRange = null,
  readOnly = false,
  onSelectionChange,
  onReady,
}: {
  ytext: Y.Text;
  /** Used for presence (remote cursors via the shared awareness protocol). */
  provider: HocuspocusProvider;
  /** Markdown-offset ranges to highlight as comments / open suggestions. */
  commentRanges?: { from: number; to: number }[];
  suggestionRanges?: { from: number; to: number }[];
  /** Markdown-offset range to select + scroll to (key forces re-trigger). */
  focusRange?: { from: number; to: number; key: number } | null;
  /** Below editor role: WYSIWYG editing is disabled. */
  readOnly?: boolean;
  onSelectionChange?: (sel: { from: number; to: number } | null) => void;
  onReady?: (handle: EditorHandle | null) => void;
}) {
  // True while we are applying a remote change into the editor, so the
  // onUpdate handler doesn't push it straight back into Y.Text.
  const applyingRemote = useRef(false);
  const onSelRef = useRef(onSelectionChange);
  onSelRef.current = onSelectionChange;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  /**
   * Translate the ProseMirror selection into offsets in the canonical
   * markdown string: take plain-text offsets in the rendered doc, then map
   * them through a diff against the markdown source (syntax like `**` or
   * `#` shows up as source-only runs the mapping skips).
   */
  const reportSelection = (editor: Editor) => {
    if (!onSelRef.current) return;
    const { from, to } = editor.state.selection;
    if (from === to) {
      onSelRef.current(null);
      return;
    }
    const doc = editor.state.doc;
    const plain = doc.textBetween(0, doc.content.size, '\n');
    const plainFrom = doc.textBetween(0, from, '\n').length;
    const plainTo = plainFrom + doc.textBetween(from, to, '\n').length;
    const md = ytext.toString();
    const mdFrom = mapOffsetThroughDiff(plain, md, plainFrom, 'right');
    const mdTo = mapOffsetThroughDiff(plain, md, plainTo, 'left');
    onSelRef.current(mdTo > mdFrom ? { from: mdFrom, to: mdTo } : null);
  };

  /**
   * Publish the local cursor in the same awareness format y-codemirror.next
   * uses (relative positions on the canonical Y.Text), so peers in source
   * mode render this user's caret and vice versa.
   */
  const publishCursor = (editor: Editor) => {
    const aw = provider.awareness;
    if (!aw) return;
    const { anchor, head } = editor.state.selection;
    const doc = editor.state.doc;
    const md = ytext.toString();
    const plain = doc.textBetween(0, doc.content.size, '\n');
    const plainAnchor = doc.textBetween(0, anchor, '\n').length;
    const plainHead = doc.textBetween(0, head, '\n').length;
    aw.setLocalStateField('cursor', {
      anchor: Y.createRelativePositionFromTypeIndex(
        ytext,
        mapOffsetThroughDiff(plain, md, plainAnchor, 'right'),
      ),
      head: Y.createRelativePositionFromTypeIndex(
        ytext,
        mapOffsetThroughDiff(plain, md, plainHead, 'right'),
      ),
    });
  };

  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      Markdown.configure({
        // Inline HTML passthrough is needed for underline (<u>), which has
        // no markdown syntax.
        html: true,
        // Keep serialization stable: these affect how the doc is written
        // back out as markdown, so they must not "reflow" untouched text.
        tightLists: true,
        bulletListMarker: '-',
      }),
    ],
    content: ytext.toString(),
    editable: !readOnly,
    immediatelyRender: false,
    editorProps: {
      attributes: { class: 'tiptap' },
    },
    onUpdate: ({ editor }) => {
      if (applyingRemote.current) return;
      applyStringToYText(ytext, getMarkdown(editor), BINDING_ORIGIN);
      reportSelection(editor);
      publishCursor(editor);
    },
    onSelectionUpdate: ({ editor }) => {
      if (applyingRemote.current) return;
      reportSelection(editor);
      publishCursor(editor);
    },
  });

  // Clear any reported selection when this editor unmounts (mode switch).
  useEffect(() => () => onSelRef.current?.(null), []);

  // --- annotation highlights -------------------------------------------------

  const rangesRef = useRef({ comments: commentRanges, suggestions: suggestionRanges });
  rangesRef.current = { comments: commentRanges, suggestions: suggestionRanges };

  useEffect(() => {
    if (!editor) return;
    editor.registerPlugin(annotationsPlugin);
    return () => {
      editor.unregisterPlugin(annotationsKey);
    };
  }, [editor]);

  // Recompute decorations whenever the ranges change or the doc re-parses
  // (the md->plain mapping depends on the current rendered text).
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const push = () => {
      const doc = editor.state.doc;
      const md = ytext.toString();
      const plain = doc.textBetween(0, doc.content.size, '\n');
      const decos: Decoration[] = [];
      for (const r of rangesRef.current.comments) {
        const m = pmRangeFromMdRange(doc, md, plain, r);
        if (m)
          decos.push(
            Decoration.inline(m.from, m.to, { class: 'pm-annotation comment' }),
          );
      }
      for (const r of rangesRef.current.suggestions) {
        const m = pmRangeFromMdRange(doc, md, plain, r);
        if (m)
          decos.push(
            Decoration.inline(m.from, m.to, { class: 'pm-annotation suggestion' }),
          );
      }
      // setMeta-only transaction: no doc change, so no onUpdate feedback.
      editor.view.dispatch(
        editor.state.tr.setMeta(annotationsKey, DecorationSet.create(doc, decos)),
      );
    };
    push();
    editor.on('update', push);
    return () => {
      editor.off('update', push);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, ytext, JSON.stringify(commentRanges), JSON.stringify(suggestionRanges)]);

  // --- remote cursors ---------------------------------------------------------

  useEffect(() => {
    const aw = provider.awareness;
    if (!editor || !aw) return;
    editor.registerPlugin(remoteCursorsPlugin);

    const render = () => {
      if (editor.isDestroyed) return;
      const doc = editor.state.doc;
      const md = ytext.toString();
      const plain = doc.textBetween(0, doc.content.size, '\n');
      const ydoc = ytext.doc!;
      const decos: Decoration[] = [];
      aw.getStates().forEach((state, clientId) => {
        if (clientId === aw.clientID) return;
        const cur = state.cursor as
          | { anchor: unknown; head: unknown }
          | null
          | undefined;
        const u = state.user as { name?: string; color?: string } | undefined;
        if (!cur?.anchor || !cur?.head) return;
        const a = Y.createAbsolutePositionFromRelativePosition(
          Y.createRelativePositionFromJSON(cur.anchor),
          ydoc,
        );
        const h = Y.createAbsolutePositionFromRelativePosition(
          Y.createRelativePositionFromJSON(cur.head),
          ydoc,
        );
        if (!a || !h) return;
        const pa = pmPosFromPlainOffset(
          doc,
          mapOffsetThroughDiff(md, plain, a.index, 'right'),
        );
        const ph = pmPosFromPlainOffset(
          doc,
          mapOffsetThroughDiff(md, plain, h.index, 'right'),
        );
        const name = u?.name ?? 'peer';
        const color = u?.color ?? '#888888';
        if (pa !== ph) {
          decos.push(
            Decoration.inline(Math.min(pa, ph), Math.max(pa, ph), {
              class: 'pm-remote-selection',
              style: `background-color: ${color}33`,
            }),
          );
        }
        decos.push(
          Decoration.widget(ph, () => remoteCaretDom(name, color), {
            key: `${clientId}-${color}-${name}`,
            side: 0,
          }),
        );
      });
      editor.view.dispatch(
        editor.state.tr.setMeta(remoteCursorsKey, DecorationSet.create(doc, decos)),
      );
    };

    render();
    aw.on('change', render);
    editor.on('update', render);
    return () => {
      aw.off('change', render);
      editor.off('update', render);
      if (!editor.isDestroyed) editor.unregisterPlugin(remoteCursorsKey);
      // Stop broadcasting a stale caret once this view goes away.
      aw.setLocalStateField('cursor', null);
    };
  }, [editor, provider, ytext]);

  // Jump to a markdown range (from a floating card) without leaving rendered mode.
  useEffect(() => {
    if (!editor || !focusRange) return;
    const doc = editor.state.doc;
    const md = ytext.toString();
    const plain = doc.textBetween(0, doc.content.size, '\n');
    const m = pmRangeFromMdRange(doc, md, plain, focusRange);
    if (!m) return;
    editor.chain().focus().setTextSelection(m).scrollIntoView().run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRange?.key]);

  // Register the toolbar/measurement handle once the editor exists.
  useEffect(() => {
    if (!editor || !onReadyRef.current) return;
    const chain = () => editor.chain().focus();
    onReadyRef.current({
      format: {
        heading: (level) =>
          level === 0
            ? chain().setParagraph().run()
            : chain().setHeading({ level: level as 1 | 2 | 3 | 4 | 5 | 6 }).run(),
        bold: () => chain().toggleBold().run(),
        italic: () => chain().toggleItalic().run(),
        underline: () => chain().toggleUnderline().run(),
        inlineCode: () => chain().toggleCode().run(),
        codeBlock: () => chain().toggleCodeBlock().run(),
        quote: () => chain().toggleBlockquote().run(),
        bulletList: () => chain().toggleBulletList().run(),
        insertTable: (rows, cols) =>
          chain().insertTable({ rows: rows + 1, cols, withHeaderRow: true }).run(),
        horizontalRule: () => chain().setHorizontalRule().run(),
      },
      measurer: {
        topOfOffset(mdOffset) {
          try {
            const doc = editor.state.doc;
            const md = ytext.toString();
            const plain = doc.textBetween(0, doc.content.size, '\n');
            const plainOffset = mapOffsetThroughDiff(md, plain, mdOffset, 'right');
            const pos = pmPosFromPlainOffset(doc, plainOffset);
            return editor.view.coordsAtPos(
              Math.max(1, Math.min(pos, doc.content.size - 1)),
            ).top;
          } catch {
            return null;
          }
        },
      },
    });
    return () => onReadyRef.current?.(null);
  }, [editor, ytext]);

  useEffect(() => {
    if (!editor) return;

    const observer = (_events: unknown, tr: YTransaction) => {
      // Ignore the echo of our own writes.
      if (tr.origin === BINDING_ORIGIN) return;

      const incoming = ytext.toString();
      // If serializing the current editor state already yields the incoming
      // markdown, the views agree; re-parsing would only disturb the cursor.
      if (getMarkdown(editor) === incoming) return;

      const { from } = editor.state.selection;
      applyingRemote.current = true;
      try {
        editor.commands.setContent(incoming, false);
        // Best-effort cursor restore: clamp the previous text position into
        // the new doc. Fine for MVP; precise remapping is on the roadmap.
        const max = editor.state.doc.content.size;
        const pos = Math.min(from, Math.max(0, max - 1));
        editor.view.dispatch(
          editor.state.tr.setSelection(
            TextSelection.near(editor.state.doc.resolve(pos)),
          ),
        );
      } finally {
        applyingRemote.current = false;
      }
    };

    ytext.observe(observer);
    return () => ytext.unobserve(observer);
  }, [editor, ytext]);

  return <EditorContent editor={editor} />;
}
