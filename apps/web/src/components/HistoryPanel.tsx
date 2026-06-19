'use client';

import { useEffect, useState } from 'react';
import type { VersionMeta } from '@markup/sync-core';
import { SERVER_HTTP, authHeaders } from '@/lib/config';

/**
 * Togglable edit-history side panel. Selecting a version previews it
 * read-only to just this user (no diff, no effect on other collaborators —
 * roadmap #9); restore is an explicit follow-up action.
 */
export default function HistoryPanel({
  docId,
  previewingId,
  onPreview,
  onExitPreview,
  onClose,
}: {
  docId: string;
  previewingId: number | null;
  onPreview: (v: VersionMeta, content: string) => void;
  onExitPreview: () => void;
  onClose: () => void;
}) {
  const [versions, setVersions] = useState<VersionMeta[]>([]);
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

  const selectVersion = async (v: VersionMeta) => {
    if (previewingId === v.id) {
      onExitPreview();
      return;
    }
    const r = await fetch(`${SERVER_HTTP}/api/docs/${docId}/versions/${v.id}`, {
      headers: authHeaders(),
      credentials: 'include',
    });
    onPreview(v, await r.text());
  };

  const restore = async (id: number) => {
    await fetch(`${SERVER_HTTP}/api/docs/${docId}/restore`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ versionId: id }),
    });
    onExitPreview();
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
        <p className="empty">click a version to preview it read-only</p>
        {error && <p className="empty">{error}</p>}
        {versions.length === 0 && <p className="empty">No versions yet.</p>}
        {versions.map((v) => (
          <div
            className={`card version ${previewingId === v.id ? 'previewing' : ''}`}
            key={v.id}
          >
            <div className="card-head clickable" onClick={() => selectVersion(v)}>
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
            {previewingId === v.id && (
              <div className="card-actions">
                <button className="primary-btn" onClick={() => restore(v.id)}>
                  Restore this version
                </button>
                <button className="ghost-btn" onClick={() => nameVersion(v)}>
                  {v.name ? 'Rename' : 'Name…'}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </aside>
  );
}
