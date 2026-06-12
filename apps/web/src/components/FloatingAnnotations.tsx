'use client';

import {
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { colorForSeed } from '@markup/sync-core';
import type { CommentThreadData, SuggestionData } from '@markup/sync-core';

interface Range {
  from: number;
  to: number;
}

interface Props {
  comments: CommentThreadData[];
  /** Suggestions are shown as floating cards only when not inline (rendered mode). */
  suggestions: SuggestionData[];
  showSuggestions: boolean;
  composer: 'comment' | 'suggest' | null;
  composerSnippet: string;
  selection: Range | null;
  onCloseComposer: () => void;
  onSubmitComment: (text: string) => void;
  onSubmitSuggestion: (proposed: string) => void;
  onReply: (threadId: string, text: string) => void;
  onResolve: (threadId: string, resolved: boolean) => void;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onJump: (r: Range) => void;
  /** Capability gates from the resolved doc role. */
  canComment: boolean;
  canModerate: boolean;
  currentContent: () => string;
  /** Viewport Y of a markdown offset in the active editor. */
  measureTop: (mdOffset: number) => number | null;
  /** Bumped when the layout may have shifted (edits, resize, mode switch). */
  layoutTick: number;
}

function Avatar({ name }: { name: string }) {
  return (
    <span className="avatar small" style={{ background: colorForSeed(name) }}>
      {name.slice(0, 2).toUpperCase()}
    </span>
  );
}

function timeAgo(iso: string): string {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * Google-Docs-style floating margin: cards sit in a gutter to the right of
 * the page, vertically aligned with the text they annotate (then pushed
 * down to avoid overlaps). Clicking a collapsed card expands it and jumps
 * the editor to its range.
 */
export default function FloatingAnnotations(props: Props) {
  const gutterRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const [tops, setTops] = useState<Record<string, number>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);

  interface Item {
    key: string;
    from: number | null;
    node: ReactNode;
  }

  const items: Item[] = [];

  if (props.composer) {
    items.push({
      key: '__composer',
      from: props.selection?.from ?? null,
      node:
        props.composer === 'comment' ? (
          <CommentComposer {...props} />
        ) : (
          <SuggestComposer {...props} />
        ),
    });
  }

  for (const t of props.comments) {
    if (t.resolved && !showResolved) continue;
    items.push({
      key: `c-${t.id}`,
      from: t.from,
      node: (
        <CommentFloat
          thread={t}
          expanded={expanded === `c-${t.id}`}
          onToggle={() => {
            setExpanded((e) => (e === `c-${t.id}` ? null : `c-${t.id}`));
            if (t.from !== null && t.to !== null) {
              props.onJump({ from: t.from, to: t.to });
            }
          }}
          {...props}
        />
      ),
    });
  }

  if (props.showSuggestions) {
    for (const s of props.suggestions) {
      if (s.status !== 'open') continue;
      items.push({
        key: `s-${s.id}`,
        from: s.from,
        node: (
          <SuggestionFloat
            s={s}
            expanded={expanded === `s-${s.id}`}
            onToggle={() =>
              setExpanded((e) => (e === `s-${s.id}` ? null : `s-${s.id}`))
            }
            {...props}
          />
        ),
      });
    }
  }

  items.sort((a, b) => (a.from ?? Infinity) - (b.from ?? Infinity));

  const layoutKey =
    items.map((i) => i.key).join(',') +
    `|${props.layoutTick}|${expanded}|${showResolved}`;

  // Two-pass layout: render, measure card heights, assign non-overlapping
  // tops aligned to each card's anchor.
  useLayoutEffect(() => {
    const gutter = gutterRef.current;
    if (!gutter) return;
    const gTop = gutter.getBoundingClientRect().top;
    const next: Record<string, number> = {};
    let cursor = 4;
    for (const item of items) {
      const el = itemRefs.current.get(item.key);
      if (!el) continue;
      const measured =
        item.from !== null ? props.measureTop(item.from) : null;
      let top = measured !== null ? measured - gTop : cursor;
      if (top < cursor) top = cursor;
      next[item.key] = top;
      cursor = top + el.offsetHeight + 8;
    }
    setTops((prev) =>
      JSON.stringify(prev) === JSON.stringify(next) ? prev : next,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey]);

  const anyResolved = props.comments.some((c) => c.resolved);

  return (
    <div className="gutter" ref={gutterRef}>
      {anyResolved && (
        <label className="toggle-row gutter-toggle">
          <input
            type="checkbox"
            checked={showResolved}
            onChange={(e) => setShowResolved(e.target.checked)}
          />
          resolved
        </label>
      )}
      {items.map((item) => (
        <div
          key={item.key}
          className="float-item"
          ref={(el) => {
            if (el) itemRefs.current.set(item.key, el);
            else itemRefs.current.delete(item.key);
          }}
          style={{
            top: tops[item.key] ?? 0,
            visibility: tops[item.key] === undefined ? 'hidden' : 'visible',
          }}
        >
          {item.node}
        </div>
      ))}
    </div>
  );
}

// --- composers -----------------------------------------------------------------

function CommentComposer(props: Props) {
  const [text, setText] = useState('');
  return (
    <div className="card composer float-card">
      <div className="card-head">
        <strong>New comment</strong>
        <button className="ghost-btn" onClick={props.onCloseComposer}>✕</button>
      </div>
      <pre className="snippet">{props.composerSnippet}</pre>
      <textarea
        autoFocus
        placeholder="Say something useful…"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="card-actions">
        <button
          className="primary-btn"
          disabled={!text.trim()}
          onClick={() => props.onSubmitComment(text.trim())}
        >
          Comment
        </button>
      </div>
    </div>
  );
}

function SuggestComposer(props: Props) {
  const [proposed, setProposed] = useState(props.composerSnippet);
  return (
    <div className="card composer float-card">
      <div className="card-head">
        <strong>Suggest change</strong>
        <button className="ghost-btn" onClick={props.onCloseComposer}>✕</button>
      </div>
      <div className="diff-label del">- current</div>
      <pre className="snippet del">{props.composerSnippet}</pre>
      <div className="diff-label add">+ proposed</div>
      <textarea
        autoFocus
        className="mono"
        value={proposed}
        onChange={(e) => setProposed(e.target.value)}
      />
      <div className="card-actions">
        <button
          className="primary-btn"
          disabled={proposed === props.composerSnippet}
          onClick={() => props.onSubmitSuggestion(proposed)}
        >
          Suggest
        </button>
      </div>
    </div>
  );
}

// --- floating cards --------------------------------------------------------------

function CommentFloat({
  thread,
  expanded,
  onToggle,
  ...props
}: Props & {
  thread: CommentThreadData;
  expanded: boolean;
  onToggle: () => void;
}) {
  const [reply, setReply] = useState('');
  const first = thread.replies[0];

  if (!expanded) {
    return (
      <div
        className={`card float-card collapsed ${thread.resolved ? 'resolved' : ''}`}
        onClick={onToggle}
      >
        <div className="card-head">
          <Avatar name={first?.author ?? '?'} />
          <span className="author">{first?.author}</span>
          <span className="when">{timeAgo(thread.createdAt)}</span>
          {thread.replies.length > 1 && (
            <span className="badge">{thread.replies.length}</span>
          )}
        </div>
        <div className="collapsed-text">{first?.text}</div>
      </div>
    );
  }

  return (
    <div className={`card float-card ${thread.resolved ? 'resolved' : ''}`}>
      <div className="card-head">
        <Avatar name={first?.author ?? '?'} />
        <span className="author">{first?.author}</span>
        <span className="when">{timeAgo(thread.createdAt)}</span>
        {props.canComment && (
          <button
            className="ghost-btn"
            title={thread.resolved ? 'Re-open' : 'Resolve'}
            onClick={(e) => {
              e.stopPropagation();
              props.onResolve(thread.id, !thread.resolved);
            }}
          >
            {thread.resolved ? '↺' : '✓'}
          </button>
        )}
        <button className="ghost-btn" onClick={onToggle}>−</button>
      </div>
      {thread.from !== null && thread.to !== null ? (
        <pre
          className="snippet clickable"
          onClick={() => props.onJump({ from: thread.from!, to: thread.to! })}
        >
          {props.currentContent().slice(thread.from, thread.to) || '(empty)'}
        </pre>
      ) : (
        <pre className="snippet gone">(referenced text was deleted)</pre>
      )}
      {thread.replies.map((r) => (
        <div className="reply" key={r.id}>
          <Avatar name={r.author} />
          <div>
            <div className="reply-meta">
              <span className="author">{r.author}</span>{' '}
              <span className="when">{timeAgo(r.createdAt)}</span>
            </div>
            <div className="reply-text">{r.text}</div>
          </div>
        </div>
      ))}
      {!thread.resolved && props.canComment && (
        <div className="reply-row">
          <input
            placeholder="Reply…"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && reply.trim()) {
                props.onReply(thread.id, reply.trim());
                setReply('');
              }
            }}
          />
        </div>
      )}
    </div>
  );
}

function SuggestionFloat({
  s,
  expanded,
  onToggle,
  ...props
}: Props & { s: SuggestionData; expanded: boolean; onToggle: () => void }) {
  return (
    <div className="card float-card suggestion" onClick={!expanded ? onToggle : undefined}>
      <div className="card-head">
        <Avatar name={s.author} />
        <span className="author">{s.author}</span>
        <span className="when">{timeAgo(s.createdAt)}</span>
        {expanded && (
          <button className="ghost-btn" onClick={onToggle}>−</button>
        )}
      </div>
      {expanded ? (
        <>
          <pre className="snippet del">{s.original || '(insertion)'}</pre>
          <pre className="snippet add">{s.proposed || '(deletion)'}</pre>
        </>
      ) : (
        <div className="collapsed-text mono">
          {(s.original || '∅').slice(0, 40)} → {(s.proposed || '∅').slice(0, 40)}
        </div>
      )}
      {props.canModerate && (
        <div className="card-actions">
          <button
            className="primary-btn"
            onClick={(e) => {
              e.stopPropagation();
              props.onAccept(s.id);
            }}
          >
            Accept
          </button>
          <button
            className="ghost-btn"
            onClick={(e) => {
              e.stopPropagation();
              props.onReject(s.id);
            }}
          >
            Reject
          </button>
        </div>
      )}
    </div>
  );
}
