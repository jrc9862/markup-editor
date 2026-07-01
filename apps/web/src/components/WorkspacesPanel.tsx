'use client';

import { useEffect, useState } from 'react';
import type {
  DocRole,
  WorkspaceMember,
  WorkspaceRole,
  WorkspaceWithRole,
} from '@markup/sync-core';
import {
  addMember,
  createWorkspace,
  deleteWorkspace,
  listMembers,
  listWorkspaces,
  removeMember,
  setMemberRole,
  updateWorkspace,
} from '@/lib/workspaces';

const BASELINE_ROLES: DocRole[] = ['editor', 'suggester', 'commenter', 'viewer'];

/** Member management for one workspace; only mounted when the panel expands. */
function MemberList({ ws }: { ws: WorkspaceWithRole }) {
  const [members, setMembers] = useState<WorkspaceMember[] | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<WorkspaceRole>('member');
  const [error, setError] = useState<string | null>(null);
  const isAdmin = ws.role === 'admin';

  const refresh = () => {
    listMembers(ws.id).then(setMembers).catch(() => {});
  };
  useEffect(refresh, [ws.id]);

  const add = async () => {
    setError(null);
    try {
      await addMember(ws.id, email.trim(), role);
      setEmail('');
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="ws-members">
      {members?.map((m) => (
        <div className="share-row" key={m.userId}>
          <span title={m.email}>{m.name ?? m.email ?? m.userId}</span>
          <span className="share-role">
            {isAdmin ? (
              <select
                className="tb-select"
                value={m.role}
                onChange={(e) =>
                  act(() => setMemberRole(ws.id, m.userId, e.target.value as WorkspaceRole))
                }
              >
                <option value="admin">admin</option>
                <option value="member">member</option>
              </select>
            ) : (
              m.role
            )}
            {isAdmin && (
              <button
                className="ghost-btn"
                title="Remove member"
                onClick={() => act(() => removeMember(ws.id, m.userId))}
              >
                ✕
              </button>
            )}
          </span>
        </div>
      ))}

      {isAdmin && (
        <div className="share-row">
          <input
            placeholder="user@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && email.trim()) void add();
            }}
          />
          <select
            className="tb-select"
            value={role}
            onChange={(e) => setRole(e.target.value as WorkspaceRole)}
          >
            <option value="member">member</option>
            <option value="admin">admin</option>
          </select>
          <button className="ghost-btn" disabled={!email.trim()} onClick={() => void add()}>
            Add
          </button>
        </div>
      )}
      {error && <div className="share-error">{error}</div>}
    </div>
  );
}

/** One workspace card: header + admin controls + expandable member list. */
function WorkspaceCard({
  ws,
  onChange,
  onDelete,
}: {
  ws: WorkspaceWithRole;
  onChange: (next: WorkspaceWithRole) => void;
  onDelete: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const isAdmin = ws.role === 'admin';

  const rename = async (name: string) => {
    setRenaming(false);
    if (!name.trim() || name === ws.name) return;
    const updated = await updateWorkspace(ws.id, { name: name.trim() });
    onChange({ ...ws, name: updated.name });
  };

  const changeRole = async (defaultRole: DocRole) => {
    const updated = await updateWorkspace(ws.id, { defaultRole });
    onChange({ ...ws, defaultRole: updated.defaultRole });
  };

  const remove = async () => {
    if (!window.confirm(`Delete workspace "${ws.name}"? Its docs are detached, not deleted.`))
      return;
    await deleteWorkspace(ws.id);
    onDelete(ws.id);
  };

  return (
    <div className="ws-card">
      <div className="ws-card-head">
        <button className="ws-toggle" onClick={() => setExpanded((v) => !v)}>
          <span className="tree-icon">{expanded ? '▾' : '▸'}</span>
          {renaming && isAdmin ? (
            <input
              autoFocus
              className="ws-rename-input"
              defaultValue={ws.name}
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => void rename(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void rename((e.target as HTMLInputElement).value);
                if (e.key === 'Escape') setRenaming(false);
              }}
            />
          ) : (
            <span className="ws-name">{ws.name}</span>
          )}
        </button>
        <span className="role-badge">{ws.role}</span>
      </div>

      {expanded && (
        <div className="ws-card-body">
          <label className="share-row">
            <span>Members get</span>
            {isAdmin ? (
              <select
                className="tb-select"
                value={ws.defaultRole}
                onChange={(e) => void changeRole(e.target.value as DocRole)}
              >
                {BASELINE_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            ) : (
              <span className="share-role">{ws.defaultRole}</span>
            )}
          </label>

          <MemberList ws={ws} />

          {isAdmin && (
            <div className="ws-card-actions">
              <button className="ghost-btn" onClick={() => setRenaming(true)}>
                Rename
              </button>
              <button className="ghost-btn ws-danger" onClick={() => void remove()}>
                Delete
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Home-page workspaces section: list the ones you belong to, create new ones
 * (you become admin), and — as an admin — manage members and the baseline
 * role. Mounted only for signed-in users.
 */
export default function WorkspacesPanel() {
  const [workspaces, setWorkspaces] = useState<WorkspaceWithRole[] | null>(null);
  const [name, setName] = useState('');
  const [defaultRole, setDefaultRole] = useState<DocRole>('editor');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listWorkspaces().then(setWorkspaces).catch((e) => setError(String(e)));
  }, []);

  const create = async () => {
    setError(null);
    try {
      const created = await createWorkspace(name.trim(), defaultRole);
      setWorkspaces((prev) => [...(prev ?? []), created]);
      setName('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="ws-section">
      <h2 className="ws-heading">Workspaces</h2>
      <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 0 }}>
        A workspace owns a set of docs: members get a baseline role on all of
        them, admins act as owner. Move a doc into a workspace from its Share
        menu.
      </p>

      {workspaces && workspaces.length > 0 && (
        <div className="ws-list">
          {workspaces.map((w) => (
            <WorkspaceCard
              key={w.id}
              ws={w}
              onChange={(next) =>
                setWorkspaces(
                  (prev) => prev?.map((x) => (x.id === next.id ? next : x)) ?? prev,
                )
              }
              onDelete={(id) =>
                setWorkspaces((prev) => prev?.filter((x) => x.id !== id) ?? prev)
              }
            />
          ))}
        </div>
      )}
      {workspaces && workspaces.length === 0 && (
        <p className="empty">You don&apos;t belong to any workspaces yet.</p>
      )}

      <div className="share-row ws-create">
        <input
          placeholder="New workspace name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && name.trim()) void create();
          }}
        />
        <select
          className="tb-select"
          value={defaultRole}
          onChange={(e) => setDefaultRole(e.target.value as DocRole)}
          title="Baseline role members get"
        >
          {BASELINE_ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <button className="primary-btn" disabled={!name.trim()} onClick={() => void create()}>
          Create
        </button>
      </div>
      {error && <div className="share-error">{error}</div>}
    </section>
  );
}
