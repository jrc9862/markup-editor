'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import {
  CONTENT_FIELD,
  makePresence,
  addComment,
  addReply,
  addSuggestionReply,
  getSuggestion,
  updateSuggestion,
  removeSuggestion,
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
import FindReplacePanel from './FindReplacePanel';
import GitPanel from './GitPanel';
import ReviewPanel from './ReviewPanel';
import type { EditorHandle } from './format';
import type { SuggestionStore } from './suggestMode';

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
  const [denied, setDenied] = useState(false);
  const [cursorOffset, setCursorOffset] = useState<number | null>(null);
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
  // The suggester role is a full editing experience locked into suggesting
  // mode: typing and toolbar actions all become suggestions.
  const lockedSuggest = !canEdit && canSuggest;

  // Below write capability the WS connection is read-only, so local Y.Doc
  // writes would silently not sync — annotation actions go through REST
  // instead (the server applies them via a direct connection and they come
  // back over the wire like any remote edit).
  const restCall = useCallback(
    (method: string, path: string, body?: unknown) =>
      fetch(`${SERVER_HTTP}/api/docs/${docId}${path}`, {
        method,
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        credentials: 'include',
        body: body === undefined ? undefined : JSON.stringify(body),
      }).catch(() => undefined),
    [docId],
  );
  const restPost = useCallback(
    (path: string, body: unknown) => restCall('POST', path, body),
    [restCall],
  );

  const [comments, setComments] = useState<CommentThreadData[]>([]);
  const [suggestions, setSuggestions] = useState<SuggestionData[]>([]);
  const [selection, setSelection] = useState<Range | null>(null);
  const [composer, setComposer] = useState<'comment' | 'suggest' | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showFind, setShowFind] = useState(false);
  const [showGit, setShowGit] = useState(false);
  const [showReview, setShowReview] = useState(false);
  // Local-only read-only preview of a past version (roadmap #9): visible to
  // just this user, no diff, no effect on other collaborators.
  const [preview, setPreview] = useState<{
    id: number;
    label: string;
    content: string;
  } | null>(null);
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
    if (!conn || !me?.user) return;
    if (conn.user.name === me.user.name) return;
    const user = makePresence(
      me.user.name,
      me.kind === 'agent' ? 'agent' : 'human',
    );
    conn.provider.setAwarenessField('user', user);
    setConn({ ...conn, user });
  }, [me, conn]);

  const refetchMeta = useCallback(() => {
    fetch(`${SERVER_HTTP}/api/docs/${docId}`, {
      headers: authHeaders(),
      credentials: 'include',
    })
      .then(async (r) => {
        if (r.status === 403 || r.status === 401) {
          setDenied(true);
          return;
        }
        if (r.ok) {
          setDenied(false);
          setMeta((await r.json()) as DocMeta);
        }
      })
      .catch(() => {});
  }, [docId]);

  useEffect(refetchMeta, [refetchMeta]);

  // Hot permission reload: the server closes the doc's connections when
  // sharing changes; the provider reconnects, onAuthenticate re-resolves the
  // role, and re-fetching myRole here flips the UI live. A revoked user's
  // reconnect fails authentication → lock screen.
  useEffect(() => {
    if (!conn) return;
    const onSynced = () => refetchMeta();
    const onAuthFail = () => setDenied(true);
    conn.provider.on('synced', onSynced);
    conn.provider.on('authenticationFailed', onAuthFail);
    return () => {
      conn.provider.off('synced', onSynced);
      conn.provider.off('authenticationFailed', onAuthFail);
    };
  }, [conn, refetchMeta]);

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

  // Rename the doc from the topbar. The path's final segment is kept in sync
  // with the name so the directory-tree browser stays consistent.
  const renameDocFromUI = () => {
    if (!meta) return;
    const current = (meta.path ?? meta.name).split('/').pop() ?? meta.name;
    const next = window.prompt('Rename document', current);
    if (!next || !next.trim() || next === current) return;
    const name = next.trim();
    const segs = (meta.path ?? meta.name).split('/');
    segs[segs.length - 1] = name;
    const path = segs.join('/');
    fetch(`${SERVER_HTTP}/api/docs/${docId}`, {
      method: 'PATCH',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name, path }),
    })
      .then(async (r) => {
        if (r.ok) setMeta((await r.json()) as DocMeta);
      })
      .catch(() => {});
  };

  // --- annotation actions ----------------------------------------------------

  const snippet = useCallback(
    (r: Range | null) =>
      conn && r ? conn.ytext.toString().slice(r.from, r.to) : '',
    [conn],
  );

  // --- suggest-mode stores ----------------------------------------------------
  //
  // Editors write suggestion objects straight into the shared Y.Doc. The
  // suggester role's WS connection is read-only, so its realtime suggesting
  // uses an optimistic local overlay synced through REST; the server echo
  // arrives over the wire and replaces the overlay entry.

  const [overlayTick, setOverlayTick] = useState(0);
  const overlayRef = useRef(new Map<string, SuggestionData>());
  const putTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const suggestionsRef = useRef(suggestions);
  suggestionsRef.current = suggestions;

  const localStore: SuggestionStore = useMemo(
    () => ({
      add: (o) => {
        if (!conn) return '';
        return addSuggestion(conn.ydoc, conn.ytext, {
          ...o,
          author: conn.user.name,
          authorId: me?.kind === 'user' ? me.user!.id : undefined,
        });
      },
      get: (id) => (conn ? getSuggestion(conn.ydoc, id) : null),
      update: (id, o) => {
        if (conn) updateSuggestion(conn.ydoc, conn.ytext, id, o);
      },
      remove: (id) => {
        if (conn) removeSuggestion(conn.ydoc, id);
      },
    }),
    [conn, me],
  );

  const restStore: SuggestionStore = useMemo(
    () => ({
      add: (o) => {
        const id =
          Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
        overlayRef.current.set(id, {
          id,
          from: o.from,
          to: o.to,
          author: me?.user?.name ?? 'me',
          authorId: me?.user?.id,
          original: o.original,
          proposed: o.proposed,
          status: 'open',
          createdAt: new Date().toISOString(),
          replies: [],
        });
        setOverlayTick((t) => t + 1);
        void restPost('/suggestions', {
          id,
          from: o.from,
          to: o.to,
          proposed: o.proposed,
        });
        return id;
      },
      get: (id) =>
        overlayRef.current.get(id) ??
        suggestionsRef.current.find((x) => x.id === id) ??
        null,
      update: (id, o) => {
        const cur =
          overlayRef.current.get(id) ??
          suggestionsRef.current.find((x) => x.id === id);
        if (!cur) return;
        overlayRef.current.set(id, {
          ...cur,
          from: o.from,
          to: o.to,
          proposed: o.proposed,
          original: conn ? conn.ytext.toString().slice(o.from, o.to) : cur.original,
        });
        setOverlayTick((t) => t + 1);
        const old = putTimers.current.get(id);
        if (old) clearTimeout(old);
        putTimers.current.set(
          id,
          setTimeout(() => {
            putTimers.current.delete(id);
            void restCall('PUT', `/suggestions/${id}`, o);
          }, 250),
        );
      },
      remove: (id) => {
        overlayRef.current.delete(id);
        const old = putTimers.current.get(id);
        if (old) clearTimeout(old);
        putTimers.current.delete(id);
        setOverlayTick((t) => t + 1);
        void restCall('DELETE', `/suggestions/${id}`);
      },
    }),
    [conn, me, restPost, restCall],
  );

  // Drop overlay entries once the server echo has caught up.
  useEffect(() => {
    let changed = false;
    for (const [id, o] of overlayRef.current) {
      const server = suggestions.find((x) => x.id === id);
      if (server && server.proposed === o.proposed && !putTimers.current.has(id)) {
        overlayRef.current.delete(id);
        changed = true;
      }
    }
    if (changed) setOverlayTick((t) => t + 1);
  }, [suggestions]);

  const mergedSuggestions = useMemo(() => {
    const overlay = overlayRef.current;
    if (overlay.size === 0) return suggestions;
    const out = suggestions.map((x) => overlay.get(x.id) ?? x);
    for (const [id, o] of overlay) {
      if (!suggestions.some((x) => x.id === id)) out.push(o);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestions, overlayTick]);

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

  const activeIds = useMemo(() => {
    if (cursorOffset === null) return [] as string[];
    const ids: string[] = [];
    for (const c of comments) {
      if (
        !c.resolved &&
        c.from !== null &&
        c.to !== null &&
        c.from <= cursorOffset &&
        cursorOffset <= c.to
      ) {
        ids.push(c.id);
      }
    }
    for (const sg of mergedSuggestions) {
      if (
        sg.status === 'open' &&
        sg.from !== null &&
        sg.to !== null &&
        sg.from <= cursorOffset &&
        cursorOffset <= sg.to
      ) {
        ids.push(sg.id);
      }
    }
    return ids;
  }, [cursorOffset, comments, mergedSuggestions]);

  if (denied) {
    return (
      <div className="app">
        <header className="topbar">
          <a className="logo" href="/" title="All documents">
            ⌘
          </a>
          <div className="doc-title">
            <span className="doc-name">{meta?.path ?? meta?.name ?? docId}</span>
          </div>
          <UserMenu />
        </header>
        <div className="denied">
          <p>You no longer have access to this document.</p>
          <p className="denied-sub">
            Ask the owner to share it with you, then reload.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <a className="logo" href="/" title="All documents">
          ⌘
        </a>
        <div className="doc-title">
          <span
            className="doc-name"
            role={canEdit ? 'button' : undefined}
            title={canEdit ? 'Click to rename' : undefined}
            style={canEdit ? { cursor: 'pointer' } : undefined}
            onClick={canEdit ? renameDocFromUI : undefined}
          >
            {meta?.path ?? meta?.name ?? docId}
          </span>
          <span className={`conn-dot ${connected ? 'on' : ''}`} />
          <span className="conn-label">{connected ? 'live' : 'connecting…'}</span>
        </div>

        <div className="presence">
          {peers.map((p, i) => (
            <span
              key={i}
              className={`avatar ${p.kind === 'agent' ? 'agent' : ''}`}
              style={{ background: p.color }}
              title={p.kind === 'agent' ? `${p.name} (agent)` : p.name}
            >
              {p.kind === 'agent' ? '🤖' : p.name.slice(0, 2).toUpperCase()}
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

        {canEdit && (
          <button
            className={`ghost-btn history-toggle ${showFind ? 'on' : ''}`}
            title="Find & replace"
            onClick={() => setShowFind((v) => !v)}
          >
            ⇄ Replace
          </button>
        )}

        {canEdit && (
          <button
            className={`ghost-btn history-toggle ${showReview ? 'on' : ''}`}
            title="Review suggestions"
            onClick={() => setShowReview((v) => !v)}
          >
            ✓ Review
          </button>
        )}

        {canEdit && (
          <button
            className={`ghost-btn history-toggle ${showGit ? 'on' : ''}`}
            title="Git"
            onClick={() => setShowGit((v) => !v)}
          >
            ⎇ Git
          </button>
        )}

        {!canEdit && <span className="role-badge">{myRole}</span>}
        <SharePanel docId={docId} isOwner={myRole === 'owner'} onCopyLink={copyLink} />
      </header>

      <Toolbar
        // Re-read the handle when an editor (re)registers it.
        key={handleVersion}
        format={
          canEdit || lockedSuggest
            ? (handleRef.current?.format ?? null)
            : null
        }
        canAnnotate={canAnnotate && canComment}
        canSuggestAction={canSuggest}
        suggesting={suggesting || lockedSuggest}
        suggestingAvailable={canEdit}
        onSuggestingChange={setSuggesting}
        onComment={() => setComposer('comment')}
        onSuggest={() => setComposer('suggest')}
      />

      {showFind && conn && canEdit && (
        <FindReplacePanel ytext={conn.ytext} onClose={() => setShowFind(false)} />
      )}

      <div className="workspace">
        <main className="page-area">
          <div className="doc-row">
            <div className="page">
              {preview ? (
                <div className="version-preview">
                  <div className="version-preview-bar">
                    <span>
                      Previewing <strong>{preview.label}</strong> — read-only,
                      visible only to you
                    </span>
                    <button
                      className="ghost-btn"
                      onClick={() => setPreview(null)}
                    >
                      Exit preview
                    </button>
                  </div>
                  <pre className="version-preview-body">{preview.content}</pre>
                </div>
              ) : !synced || !conn ? (
                <p className="loading">Loading document…</p>
              ) : mode === 'source' ? (
                <SourceEditor
                  ytext={conn.ytext}
                  provider={conn.provider}
                  user={conn.user}
                  commentRanges={commentRanges}
                  suggestions={mergedSuggestions}
                  suggesting={(suggesting && canEdit) || lockedSuggest}
                  suggestStore={lockedSuggest ? restStore : localStore}
                  readOnly={!canEdit && !lockedSuggest}
                  focusRange={focusRange}
                  onSelectionChange={setSelection}
                  onCursorChange={setCursorOffset}
                  onReady={onEditorReady}
                />
              ) : (
                <RenderedEditor
                  ytext={conn.ytext}
                  provider={conn.provider}
                  commentRanges={commentRanges}
                  suggestionItems={mergedSuggestions
                    .filter(
                      (s) =>
                        s.status === 'open' && s.from !== null && s.to !== null,
                    )
                    .map((s) => ({
                      from: s.from!,
                      to: s.to!,
                      proposed: s.proposed,
                    }))}
                  suggesting={(suggesting && canEdit) || lockedSuggest}
                  suggestStore={lockedSuggest ? restStore : localStore}
                  focusRange={focusRange}
                  readOnly={!canEdit && !lockedSuggest}
                  onSelectionChange={setSelection}
                  onCursorChange={setCursorOffset}
                  onReady={onEditorReady}
                />
              )}
            </div>

            {conn && synced && (
              <FloatingAnnotations
                comments={comments}
                suggestions={mergedSuggestions}
                showSuggestions={true}
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
                onSuggestionReply={(sid, text) =>
                  canEdit
                    ? addSuggestionReply(conn.ydoc, sid, {
                        author: conn.user.name,
                        authorId: me?.kind === 'user' ? me.user!.id : undefined,
                        text,
                      })
                    : void restPost(`/suggestions/${sid}/replies`, { text })
                }
                activeIds={activeIds}
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
            liveTick={layoutTick}
            previewingId={preview?.id ?? null}
            onPreview={(v, content) =>
              setPreview({ id: v.id, label: v.name ?? `v${v.id}`, content })
            }
            onExitPreview={() => setPreview(null)}
            onClose={() => {
              setShowHistory(false);
              setPreview(null);
            }}
          />
        )}

        {showReview && conn && (
          <ReviewPanel
            docId={docId}
            open={mergedSuggestions.filter((s) => s.status === 'open')}
            onClose={() => setShowReview(false)}
            onApplied={() => {}}
          />
        )}

        {showGit && conn && <GitPanel onClose={() => setShowGit(false)} />}
      </div>
    </div>
  );
}
