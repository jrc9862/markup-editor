'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import {
  CONTENT_FIELD,
  makePresence,
  addComment,
  addReply,
  setResolved,
  snapshotComments,
  addSuggestion,
  acceptSuggestion,
  rejectSuggestion,
  snapshotSuggestions,
} from '@markup/sync-core';
import type {
  DocMeta,
  PresenceUser,
  CommentThreadData,
  SuggestionData,
} from '@markup/sync-core';
import { SERVER_HTTP, SERVER_WS, TOKEN, authHeaders } from '@/lib/config';
import { useMe } from '@/lib/auth';
import UserMenu from './UserMenu';
import SharePanel from './SharePanel';
import SourceEditor from './SourceEditor';
import RenderedEditor from './RenderedEditor';
import Toolbar from './Toolbar';
import FloatingAnnotations from './FloatingAnnotations';
import HistoryPanel from './HistoryPanel';
import type { EditorHandle } from './format';

type Mode = 'source' | 'rendered';

export interface Range {
  from: number;
  to: number;
}

interface Conn {
  ydoc: Y.Doc;
  provider: HocuspocusProvider;
  ytext: Y.Text;
  user: PresenceUser;
}

function defaultMode(): Mode {
  if (typeof window === 'undefined') return 'source';
  return (localStorage.getItem('markup:default-mode') as Mode) ?? 'source';
}

function userName(): string {
  if (typeof window === 'undefined') return 'anonymous';
  let name = localStorage.getItem('markup:user-name');
  if (!name) {
    name = `guest-${Math.random().toString(36).slice(2, 6)}`;
    localStorage.setItem('markup:user-name', name);
  }
  return name;
}

export default function Editor({ docId }: { docId: string }) {
  const [mode, setMode] = useState<Mode>(defaultMode);
  const [connected, setConnected] = useState(false);
  const [synced, setSynced] = useState(false);
  const [peers, setPeers] = useState<PresenceUser[]>([]);
  const [meta, setMeta] = useState<DocMeta | null>(null);
  const [conn, setConn] = useState<Conn | null>(null);
  const { me } = useMe();
  const signedIn = me?.kind === 'user';

  // Capability from the doc role (myRole on GET /api/docs/:id). Until meta
  // loads we assume editor — the server-side read-only WS connection is the
  // real guard; this only drives the UI affordances.
  const myRole = meta?.myRole ?? 'editor';
  const cap =
    { none: -1, viewer: 0, commenter: 1, suggester: 2, editor: 3, owner: 3 }[
      myRole
    ] ?? 3;
  const canEdit = cap >= 3;
  const canSuggest = cap >= 2;
  const canComment = cap >= 1;

  // Below write capability the WS connection is read-only, so local Y.Doc
  // writes would silently not sync — annotation actions go through REST
  // instead (the server applies them via a direct connection and they come
  // back over the wire like any remote edit).
  const restPost = useCallback(
    (path: string, body: unknown) =>
      fetch(`${SERVER_HTTP}/api/docs/${docId}${path}`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      }).catch(() => {}),
    [docId],
  );

  const [comments, setComments] = useState<CommentThreadData[]>([]);
  const [suggestions, setSuggestions] = useState<SuggestionData[]>([]);
  const [selection, setSelection] = useState<Range | null>(null);
  const [composer, setComposer] = useState<'comment' | 'suggest' | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  // Realtime suggestion mode (source mode): keystrokes become suggestions.
  const [suggesting, setSuggesting] = useState(false);
  // Bumped whenever floating-card positions may have shifted.
  const [layoutTick, setLayoutTick] = useState(0);
  // Range to scroll the source editor to (key forces re-trigger).
  const [focusRange, setFocusRange] = useState<(Range & { key: number }) | null>(
    null,
  );

  const handleRef = useRef<EditorHandle | null>(null);
  const [handleVersion, setHandleVersion] = useState(0);
  const onEditorReady = useCallback((h: EditorHandle | null) => {
    handleRef.current = h;
    setHandleVersion((v) => v + 1);
    setLayoutTick((t) => t + 1);
  }, []);

  // Create the Y.Doc + provider inside the effect (not useMemo) so React 18
  // StrictMode's mount/unmount/remount in dev gets a fresh, working provider
  // each time instead of re-attaching to a destroyed one.
  useEffect(() => {
    const ydoc = new Y.Doc();
    const user = makePresence(userName());
    const provider = new HocuspocusProvider({
      url: SERVER_WS,
      name: docId,
      document: ydoc,
      token: TOKEN,
    });
    provider.setAwarenessField('user', user);

    const onStatus = ({ status }: { status: string }) =>
      setConnected(status === 'connected');
    const onSynced = () => setSynced(true);
    const onAwareness = () => {
      const states = provider.awareness
        ? Array.from(provider.awareness.getStates().values())
        : [];
      setPeers(
        states
          .map((s) => (s as { user?: PresenceUser }).user)
          .filter((u): u is PresenceUser => Boolean(u)),
      );
    };
    provider.on('status', onStatus);
    provider.on('synced', onSynced);
    provider.awareness?.on('change', onAwareness);

    // Comments, suggestions, and their anchors all live in the Y.Doc, so a
    // single doc-level listener keeps the React snapshots fresh. Debounce
    // the layout tick so floating cards reposition after bursts of typing.
    let layoutTimer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      setComments(snapshotComments(ydoc));
      setSuggestions(snapshotSuggestions(ydoc));
      if (layoutTimer) clearTimeout(layoutTimer);
      layoutTimer = setTimeout(() => setLayoutTick((t) => t + 1), 150);
    };
    ydoc.on('update', refresh);
    refresh();

    const onResize = () => setLayoutTick((t) => t + 1);
    window.addEventListener('resize', onResize);

    setConn({ ydoc, provider, ytext: ydoc.getText(CONTENT_FIELD), user });

    return () => {
      window.removeEventListener('resize', onResize);
      if (layoutTimer) clearTimeout(layoutTimer);
      ydoc.off('update', refresh);
      provider.off('status', onStatus);
      provider.off('synced', onSynced);
      provider.awareness?.off('change', onAwareness);
      provider.destroy();
      ydoc.destroy();
      setConn(null);
      setSynced(false);
      setConnected(false);
      setPeers([]);
    };
  }, [docId]);

  // Once the signed-in identity is known, presence uses the real name
  // (the provider starts with the guest name before /api/me resolves).
  useEffect(() => {
    if (!conn || me?.kind !== 'user') return;
    if (conn.user.name === me.user!.name) return;
    const user = makePresence(me.user!.name);
    conn.provider.setAwarenessField('user', user);
    setConn({ ...conn, user });
  }, [me, conn]);

  useEffect(() => {
    fetch(`${SERVER_HTTP}/api/docs/${docId}`, {
      headers: authHeaders(),
      credentials: 'include',
    })
      .then((r) => (r.ok ? r.json() : null))
      .then(setMeta)
      .catch(() => {});
  }, [docId]);

  const switchMode = (m: Mode) => {
    setMode(m);
    setSelection(null);
    localStorage.setItem('markup:default-mode', m);
  };

  const renameUser = () => {
    const name = window.prompt('Display name', userName());
    if (!name || !conn) return;
    localStorage.setItem('markup:user-name', name);
    const user = makePresence(name);
    conn.provider.setAwarenessField('user', user);
    setConn({ ...conn, user });
  };

  const copyLink = () => {
    navigator.clipboard.writeText(window.location.href).catch(() => {});
  };

  // --- annotation actions ----------------------------------------------------

  const snippet = useCallback(
    (r: Range | null) =>
      conn && r ? conn.ytext.toString().slice(r.from, r.to) : '',
    [conn],
  );

  const submitComment = (text: string) => {
    if (!conn || !selection) return;
    if (!canEdit) {
      void restPost('/comments', { ...selection, text });
    } else {
      addComment(conn.ydoc, conn.ytext, {
        ...selection,
        author: conn.user.name,
        authorId: me?.kind === 'user' ? me.user!.id : undefined,
        text,
      });
    }
    setComposer(null);
  };

  const submitSuggestion = (proposed: string) => {
    if (!conn || !selection) return;
    if (!canEdit) {
      void restPost('/suggestions', { ...selection, proposed });
    } else {
      addSuggestion(conn.ydoc, conn.ytext, {
        ...selection,
        author: conn.user.name,
        authorId: me?.kind === 'user' ? me.user!.id : undefined,
        original: snippet(selection),
        proposed,
      });
    }
    setComposer(null);
  };

  const jumpTo = (r: Range) => {
    // Both editors can scroll to a markdown range now (rendered mode maps it
    // through the diff), so stay in whichever mode the user is in.
    setFocusRange({ ...r, key: Date.now() });
  };

  const canAnnotate = selection !== null && selection.to > selection.from;

  const commentRanges = comments
    .filter((c) => !c.resolved && c.from !== null && c.to !== null)
    .map((c) => ({ from: c.from!, to: c.to! }));

  return (
    <div className="app">
      <header className="topbar">
        <a className="logo" href="/" title="All documents">
          ⌘
        </a>
        <div className="doc-title">
          <span className="doc-name">{meta?.path ?? meta?.name ?? docId}</span>
          <span className={`conn-dot ${connected ? 'on' : ''}`} />
          <span className="conn-label">{connected ? 'live' : 'connecting…'}</span>
        </div>

        <div className="presence">
          {peers.map((p, i) => (
            <span
              key={i}
              className="avatar"
              style={{ background: p.color }}
              title={p.name}
            >
              {p.name.slice(0, 2).toUpperCase()}
            </span>
          ))}
          {conn && !signedIn && (
            <button
              className="ghost-btn"
              onClick={renameUser}
              title="Change your display name"
            >
              {conn.user.name}
            </button>
          )}
          <UserMenu />
        </div>

        <div className="mode-toggle">
          <button
            className={mode === 'source' ? 'active' : ''}
            onClick={() => switchMode('source')}
          >
            {'</>'} Source
          </button>
          <button
            className={mode === 'rendered' ? 'active' : ''}
            onClick={() => switchMode('rendered')}
          >
            ¶ Rendered
          </button>
        </div>

        <button
          className={`ghost-btn history-toggle ${showHistory ? 'on' : ''}`}
          title="Edit history"
          onClick={() => setShowHistory((v) => !v)}
        >
          ⏱ History
        </button>

        {!canEdit && <span className="role-badge">{myRole}</span>}
        <SharePanel docId={docId} isOwner={myRole === 'owner'} onCopyLink={copyLink} />
      </header>

      <Toolbar
        // Re-read the handle when an editor (re)registers it.
        key={handleVersion}
        format={canEdit ? (handleRef.current?.format ?? null) : null}
        canAnnotate={canAnnotate && canComment}
        canSuggestAction={canSuggest}
        suggesting={mode === 'source' && suggesting && canEdit}
        suggestingAvailable={mode === 'source' && canEdit}
        onSuggestingChange={setSuggesting}
        onComment={() => setComposer('comment')}
        onSuggest={() => setComposer('suggest')}
      />

      <div className="workspace">
        <main className="page-area">
          <div className="doc-row">
            <div className="page">
              {!synced || !conn ? (
                <p className="loading">Loading document…</p>
              ) : mode === 'source' ? (
                <SourceEditor
                  ytext={conn.ytext}
                  provider={conn.provider}
                  user={conn.user}
                  commentRanges={commentRanges}
                  suggestions={suggestions}
                  suggesting={suggesting && canEdit}
                  readOnly={!canEdit}
                  canModerate={canEdit}
                  onAccept={(id) =>
                    acceptSuggestion(conn.ydoc, conn.ytext, id)
                  }
                  onReject={(id) => rejectSuggestion(conn.ydoc, id)}
                  focusRange={focusRange}
                  onSelectionChange={setSelection}
                  onReady={onEditorReady}
                />
              ) : (
                <RenderedEditor
                  ytext={conn.ytext}
                  provider={conn.provider}
                  commentRanges={commentRanges}
                  suggestionRanges={suggestions
                    .filter(
                      (s) =>
                        s.status === 'open' && s.from !== null && s.to !== null,
                    )
                    .map((s) => ({ from: s.from!, to: s.to! }))}
                  focusRange={focusRange}
                  readOnly={!canEdit}
                  onSelectionChange={setSelection}
                  onReady={onEditorReady}
                />
              )}
            </div>

            {conn && synced && (
              <FloatingAnnotations
                comments={comments}
                suggestions={suggestions}
                showSuggestions={mode === 'rendered'}
                composer={composer}
                composerSnippet={snippet(selection)}
                selection={selection}
                onCloseComposer={() => setComposer(null)}
                onSubmitComment={submitComment}
                onSubmitSuggestion={submitSuggestion}
                onReply={(id, text) =>
                  canEdit
                    ? addReply(conn.ydoc, id, {
                        author: conn.user.name,
                        authorId: me?.kind === 'user' ? me.user!.id : undefined,
                        text,
                      })
                    : void restPost(`/comments/${id}/replies`, { text })
                }
                onResolve={(id, resolved) =>
                  canEdit
                    ? setResolved(conn.ydoc, id, resolved)
                    : void restPost(`/comments/${id}/resolve`, { resolved })
                }
                onAccept={(id) => acceptSuggestion(conn.ydoc, conn.ytext, id)}
                onReject={(id) => rejectSuggestion(conn.ydoc, id)}
                onJump={jumpTo}
                canComment={canComment}
                canModerate={canEdit}
                currentContent={() => conn.ytext.toString()}
                measureTop={(off) =>
                  handleRef.current?.measurer.topOfOffset(off) ?? null
                }
                layoutTick={layoutTick}
              />
            )}
          </div>
        </main>

        {showHistory && conn && (
          <HistoryPanel
            docId={docId}
            currentContent={() => conn.ytext.toString()}
            onClose={() => setShowHistory(false)}
          />
        )}
      </div>
    </div>
  );
}
