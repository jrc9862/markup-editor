'use client';

import { useCallback, useEffect, useState } from 'react';
import { SERVER_HTTP, authHeaders } from '@/lib/config';

interface GitStatus {
  branch: string;
  files: { status: string; path: string }[];
}

/**
 * Git-native flows from the UI (roadmap #3): show branch + working-tree
 * status, commit the real .md files, and create/switch branches. Backed by
 * the server git bridge, which is only enabled when MARKUP_REPO_DIR is set —
 * otherwise the panel shows that git flows are unavailable.
 */
export default function GitPanel({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [disabled, setDisabled] = useState(false);
  const [message, setMessage] = useState('');
  const [newBranch, setNewBranch] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(() => {
    fetch(`${SERVER_HTTP}/api/git/status`, {
      headers: authHeaders(),
      credentials: 'include',
    }).then(async (r) => {
      if (r.status === 404) {
        setDisabled(true);
        return;
      }
      if (r.ok) setStatus(await r.json());
    });
    fetch(`${SERVER_HTTP}/api/git/branches`, {
      headers: authHeaders(),
      credentials: 'include',
    }).then(async (r) => {
      if (r.ok) setBranches((await r.json()).branches ?? []);
    });
  }, []);

  useEffect(refresh, [refresh]);

  const post = async (path: string, body: unknown): Promise<boolean> => {
    setBusy(true);
    setNote(null);
    try {
      const r = await fetch(`${SERVER_HTTP}/api/git/${path}`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) {
        setNote(json.error ?? `error ${r.status}`);
        return false;
      }
      return true;
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!message.trim()) return;
    if (await post('commit', { message })) {
      setNote('Committed');
      setMessage('');
      refresh();
    }
  };

  const createBranch = async () => {
    if (!newBranch.trim()) return;
    if (await post('branch', { name: newBranch.trim(), checkout: true })) {
      setNewBranch('');
      refresh();
    }
  };

  const checkout = async (name: string) => {
    if (await post('checkout', { name })) refresh();
  };

  return (
    <aside className="history-panel">
      <div className="history-title">
        <strong>Git</strong>
        <button className="ghost-btn" onClick={refresh} title="Refresh">↻</button>
        <button className="ghost-btn" onClick={onClose} title="Close">✕</button>
      </div>
      <div className="history-body">
        {disabled && (
          <p className="empty">
            Git flows aren’t enabled on this server (set MARKUP_REPO_DIR).
          </p>
        )}
        {!disabled && status && (
          <>
            <div className="git-branch">
              on <strong className="mono">{status.branch}</strong>
            </div>

            <div className="git-files">
              {status.files.length === 0 ? (
                <p className="empty">working tree clean</p>
              ) : (
                status.files.map((f) => (
                  <div className="git-file" key={f.path}>
                    <span className="git-stat mono">{f.status || '•'}</span>
                    <span className="git-path">{f.path}</span>
                  </div>
                ))
              )}
            </div>

            <textarea
              className="find-input"
              placeholder="Commit message"
              rows={2}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
            <button
              className="primary-btn"
              disabled={busy || !message.trim() || status.files.length === 0}
              onClick={commit}
            >
              Commit all changes
            </button>

            <div className="git-branches">
              <div className="git-branch-row">
                <input
                  className="find-input"
                  placeholder="new-branch-name"
                  value={newBranch}
                  onChange={(e) => setNewBranch(e.target.value)}
                />
                <button
                  className="ghost-btn"
                  disabled={busy || !newBranch.trim()}
                  onClick={createBranch}
                >
                  Branch
                </button>
              </div>
              {branches.map((b) => (
                <button
                  key={b}
                  className={`git-branch-item ${b === status.branch ? 'on' : ''}`}
                  disabled={busy || b === status.branch}
                  onClick={() => checkout(b)}
                >
                  {b}
                </button>
              ))}
            </div>
          </>
        )}
        {note && <div className="find-status">{note}</div>}
      </div>
    </aside>
  );
}
