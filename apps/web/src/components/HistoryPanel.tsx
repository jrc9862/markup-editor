'use client';

import { useEffect, useState } from 'react';
import { lineDiff } from '@markup/sync-core';
import type { VersionMeta } from '@markup/sync-core';
import { SERVER_HTTP, authHeaders } from '@/lib/config';

/** Togglable edit-history side panel: version list, diff view, restore. */
export default function HistoryPanel({
  docId,
  currentContent,
  onClose,
}: {
  docId: string;
  currentContent: () => string;
  onClose: () => void;
}) {
  const [versions, setVersions] = useState<VersionMeta[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);
  const [diff, setDiff] = useState<ReturnType<typeof lineDiff> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    fetch(`${SERVER_HTTP}/api/docs/${docId}/versions`, {
      headers: authHeaders(),
      credentials: 'include',
    })
      .then((r) => r.json())
      .then(setVersions)
      .catch((e) => setError(String(e)));
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [docId]);

  const openVersion = async (id: number) => {
    if (openId === id) {
      setOpenId(null);
      setDiff(null);
      return;
    }
    const r = await fetch(
      `${SERVER_HTTP}/api/docs/${docId}/versions/${id}`,
      { headers: authHeaders(), credentials: 'include' },
    );
    const content = await r.text();
    setOpenId(id);
    // Diff oriented as version -> current: 'add' = present now, 'del' = only in version.
    setDiff(lineDiff(content, currentContent()));
  };

  const restore = async (id: number) => {
    await fetch(`${SERVER_HTTP}/api/docs/${docId}/restore`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ versionId: id }),
    });
    setOpenId(null);
    setDiff(null);
    load();
  };

  const nameVersion = async (v: VersionMeta) => {
    const name = window.prompt('Name this version', v.name ?? '');
    if (name === null || !name.trim()) return;
    await fetch(`${SERVER_HTTP}/api/docs/${docId}/versions/${v.id}`, {
      method: 'PUT',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name: name.trim() }),
    });
    load();
  };

  return (
    <aside className="history-panel">
      <div className="history-title">
        <strong>History</strong>
        <button className="ghost-btn" onClick={load} title="Refresh">↻</button>
        <button className="ghost-btn" onClick={onClose} title="Close">✕</button>
      </div>
      <div className="history-body">
        <p className="empty">snapshots are taken as people edit</p>
        {error && <p className="empty">{error}</p>}
        {versions.length === 0 && <p className="empty">No versions yet.</p>}
        {versions.map((v) => (
          <div className="card version" key={v.id}>
            <div className="card-head clickable" onClick={() => openVersion(v.id)}>
              <strong className="mono">{v.name ?? `v${v.id}`}</strong>
              <span className="when">{new Date(v.createdAt).toLocaleString()}</span>
              <span className="when">{v.size} B</span>
            </div>
            {(v.author || v.name) && (
              <div className="version-meta">
                {v.author && <span className="version-author">{v.author}</span>}
                {v.name && <span className="when">v{v.id}</span>}
              </div>
            )}
            {openId === v.id && diff && (
              <>
                <div className="diff-view">
                  {diff.map((chunk, i) =>
                    chunk.op === 'equal'
                      ? null
                      : chunk.lines.map((line, j) => (
                          <div key={`${i}-${j}`} className={`diff-line ${chunk.op}`}>
                            {chunk.op === 'add' ? '+ ' : '- '}
                            {line}
                          </div>
                        )),
                  )}
                  {diff.every((c) => c.op === 'equal') && (
                    <div className="diff-line">identical to current</div>
                  )}
                </div>
                <div className="card-actions">
                  <button className="primary-btn" onClick={() => restore(v.id)}>
                    Restore this version
                  </button>
                  <button className="ghost-btn" onClick={() => nameVersion(v)}>
                    {v.name ? 'Rename' : 'Name…'}
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </aside>
  );
}
