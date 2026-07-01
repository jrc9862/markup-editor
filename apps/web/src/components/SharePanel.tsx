'use client';

import { useEffect, useRef, useState } from 'react';
import type {
  AclEntry,
  AuthUser,
  DocRole,
  WorkspaceWithRole,
} from '@markup/sync-core';
import { SERVER_HTTP, authHeaders } from '@/lib/config';
import { listWorkspaces } from '@/lib/workspaces';

const GRANTABLE: DocRole[] = ['editor', 'suggester', 'commenter', 'viewer'];

interface Permissions {
  owner?: AuthUser;
  linkRole: string;
  entries: AclEntry[];
}

/**
 * Share button + popover: copy link for everyone; for the doc owner, the
 * link role ('none' = private) and the per-user ACL.
 */
export default function SharePanel({
  docId,
  isOwner,
  onCopyLink,
}: {
  docId: string;
  isOwner: boolean;
  onCopyLink: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [perms, setPerms] = useState<Permissions | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<DocRole>('editor');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceWithRole[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string>('');
  const ref = useRef<HTMLDivElement>(null);

  const api = (path: string, init?: RequestInit) =>
    fetch(`${SERVER_HTTP}/api/docs/${docId}${path}`, {
      ...init,
      headers: {
        ...authHeaders(),
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
      credentials: 'include',
    });

  const refresh = () => {
    api('/permissions')
      .then((r) => (r.ok ? r.json() : null))
      .then(setPerms)
      .catch(() => {});
  };

  useEffect(() => {
    if (!open || !isOwner) return;
    refresh();
    // The doc's current workspace + the ones the owner could move it into.
    listWorkspaces().then(setWorkspaces).catch(() => {});
    api('')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setWorkspaceId((d as { workspaceId?: string })?.workspaceId ?? ''))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isOwner, docId]);

  const moveToWorkspace = async (next: string) => {
    setError(null);
    const r = await api('', {
      method: 'PATCH',
      body: JSON.stringify({ workspaceId: next === '' ? null : next }),
    });
    if (!r.ok) {
      const body = (await r.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? `failed (${r.status})`);
      return;
    }
    setWorkspaceId(next);
  };

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const grant = async () => {
    setError(null);
    const r = await api('/permissions', {
      method: 'POST',
      body: JSON.stringify({ email: email.trim(), role }),
    });
    if (!r.ok) {
      const body = (await r.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? `failed (${r.status})`);
      return;
    }
    setEmail('');
    refresh();
  };

  const copy = () => {
    onCopyLink();
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="share" ref={ref}>
      <button className="primary-btn" onClick={() => setOpen((v) => !v)}>
        Share
      </button>
      {open && (
        <div className="share-panel">
          <button className="ghost-btn" onClick={copy}>
            {copied ? 'Copied' : 'Copy link'}
          </button>

          {isOwner && perms && (
            <>
              <label className="share-row">
                <span>Anyone with the link</span>
                <select
                  className="tb-select"
                  value={perms.linkRole}
                  onChange={async (e) => {
                    await api('/permissions/link', {
                      method: 'PUT',
                      body: JSON.stringify({ role: e.target.value }),
                    });
                    refresh();
                  }}
                >
                  {GRANTABLE.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                  <option value="none">no access</option>
                </select>
              </label>

              <label className="share-row">
                <span>Workspace</span>
                <select
                  className="tb-select"
                  value={workspaceId}
                  onChange={(e) => void moveToWorkspace(e.target.value)}
                >
                  <option value="">none (personal)</option>
                  {workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </label>

              {perms.entries.map((e) => (
                <div className="share-row" key={e.userId}>
                  <span title={e.email}>{e.name ?? e.email ?? e.userId}</span>
                  <span className="share-role">
                    {e.role}
                    <button
                      className="ghost-btn"
                      title="Remove access"
                      onClick={async () => {
                        await api(`/permissions/${e.userId}`, {
                          method: 'DELETE',
                        });
                        refresh();
                      }}
                    >
                      ✕
                    </button>
                  </span>
                </div>
              ))}

              <div className="share-row">
                <input
                  placeholder="user@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && email.trim()) void grant();
                  }}
                />
                <select
                  className="tb-select"
                  value={role}
                  onChange={(e) => setRole(e.target.value as DocRole)}
                >
                  {GRANTABLE.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
                <button
                  className="ghost-btn"
                  disabled={!email.trim()}
                  onClick={() => void grant()}
                >
                  Add
                </button>
              </div>
              {error && <div className="share-error">{error}</div>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
