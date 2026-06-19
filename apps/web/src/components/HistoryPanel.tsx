'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { VersionMeta } from '@markup/sync-core';
import { SERVER_HTTP, authHeaders } from '@/lib/config';

/** Versions within this gap by the same author collapse into one burst. */
const BURST_GAP_MS = 5 * 60_000;

interface VersionGroup {
  author?: string;
  versions: VersionMeta[];
}

/**
 * Group a newest-first version list into meaningful sessions: consecutive
 * snapshots by the same author within a short editing burst become one group,
 * rather than surfacing every raw >=60s debounce snapshot on its own.
 */
function groupVersions(versions: VersionMeta[]): VersionGroup[] {
  const groups: VersionGroup[] = [];
  for (const v of versions) {
    const head = groups[groups.length - 1];
    const prev = head?.versions[head.versions.length - 1];
    const contiguous =
      head &&
      head.author === v.author &&
      prev &&
      Date.parse(prev.createdAt) - Date.parse(v.createdAt) <= BURST_GAP_MS;
    if (contiguous) head!.versions.push(v);
    else groups.push({ author: v.author, versions: [v] });
  }
  return groups;
}

/**
 * Togglable edit-history side panel. Hot-reloads as edits land (roadmap #8)
 * and groups snapshots into author/burst sessions. Selecting a version
 * previews it read-only to just this user (no diff, no effect on other
 * collaborators — roadmap #9); restore is an explicit follow-up action.
 */
export default function HistoryPanel({
  docId,
  liveTick,
  previewingId,
  onPreview,
  onExitPreview,
  onClose,
}: {
  docId: string;
  /** Bumped by the editor on doc updates; drives live hot-reload. */
  liveTick: number;
  previewingId: number | null;
  onPreview: (v: VersionMeta, content: string) => void;
  onExitPreview: () => void;
  onClose: () => void;
}) {
  const [versions, setVersions] = useState<VersionMeta[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch(`${SERVER_HTTP}/api/docs/${docId}/versions`, {
      headers: authHeaders(),
      credentials: 'include',
    })
      .then((r) => r.json())
      .then(setVersions)
      .catch((e) => setError(String(e)));
  }, [docId]);

  useEffect(load, [load]);

  // Hot-reload: debounce a reload after edits land (versions are created
  // server-side on store), and poll periodically so a snapshot taken after
  // the typing burst settles still appears without manual refresh.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(load, 1500);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [liveTick, load]);

  useEffect(() => {
    const id = setInterval(load, 12_000);
    return () => clearInterval(id);
  }, [load]);

  const groups = useMemo(() => groupVersions(versions), [versions]);

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
        {groups.map((g) => (
          <div className="version-group" key={g.versions[0].id}>
            <div className="version-group-head">
              <span className="version-author">{g.author ?? 'unknown'}</span>
              <span className="when">
                {new Date(g.versions[0].createdAt).toLocaleString()}
              </span>
              {g.versions.length > 1 && (
                <span className="when">{g.versions.length} edits</span>
              )}
            </div>
            {g.versions.map((v) => (
              <div
                className={`card version ${previewingId === v.id ? 'previewing' : ''}`}
                key={v.id}
              >
                <div
                  className="card-head clickable"
                  onClick={() => selectVersion(v)}
                >
                  <strong className="mono">{v.name ?? `v${v.id}`}</strong>
                  <span className="when">
                    {new Date(v.createdAt).toLocaleTimeString()}
                  </span>
                  <span className="when">{v.size} B</span>
                </div>
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
        ))}
      </div>
    </aside>
  );
}
