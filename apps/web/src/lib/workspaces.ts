'use client';

import type {
  AuditEntry,
  DocRole,
  Workspace,
  WorkspaceMember,
  WorkspaceRole,
  WorkspaceWithRole,
} from '@markup/sync-core';
import { SERVER_HTTP, authHeaders } from './config';

/**
 * Thin typed wrapper over the /api/workspaces REST surface. Every call rides
 * the session cookie (credentials: 'include') with the legacy token as
 * fallback, matching the rest of the web client.
 */
async function ws<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${SERVER_HTTP}/api/workspaces${path}`, {
    ...init,
    headers: {
      ...authHeaders(),
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    credentials: 'include',
  });
  if (!r.ok) {
    const body = (await r.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `request failed (${r.status})`);
  }
  return (await r.json()) as T;
}

export const listWorkspaces = (): Promise<WorkspaceWithRole[]> => ws('');

export const createWorkspace = (
  name: string,
  defaultRole: DocRole,
): Promise<WorkspaceWithRole> =>
  ws('', { method: 'POST', body: JSON.stringify({ name, defaultRole }) });

export const updateWorkspace = (
  wsId: string,
  fields: { name?: string; defaultRole?: DocRole },
): Promise<Workspace> =>
  ws(`/${wsId}`, { method: 'PATCH', body: JSON.stringify(fields) });

export const deleteWorkspace = (wsId: string): Promise<{ ok: true }> =>
  ws(`/${wsId}`, { method: 'DELETE' });

export const listMembers = (wsId: string): Promise<WorkspaceMember[]> =>
  ws(`/${wsId}/members`);

export const addMember = (
  wsId: string,
  email: string,
  role: WorkspaceRole,
): Promise<{ userId: string; role: WorkspaceRole }> =>
  ws(`/${wsId}/members`, { method: 'POST', body: JSON.stringify({ email, role }) });

export const setMemberRole = (
  wsId: string,
  userId: string,
  role: WorkspaceRole,
): Promise<{ userId: string; role: WorkspaceRole }> =>
  ws(`/${wsId}/members/${userId}`, {
    method: 'PATCH',
    body: JSON.stringify({ role }),
  });

export const removeMember = (wsId: string, userId: string): Promise<{ ok: true }> =>
  ws(`/${wsId}/members/${userId}`, { method: 'DELETE' });

/**
 * Admin-only audit log for a workspace, newest-first. `before` is the id of the
 * oldest entry already loaded — pass it to page backwards (keyset pagination).
 */
export const listAudit = (
  wsId: string,
  opts?: { limit?: number; before?: number },
): Promise<AuditEntry[]> => {
  const q = new URLSearchParams();
  if (opts?.limit) q.set('limit', String(opts.limit));
  if (opts?.before) q.set('before', String(opts.before));
  const qs = q.toString();
  return ws(`/${wsId}/audit${qs ? `?${qs}` : ''}`);
};

/** Fetch the full audit log as a CSV blob (server streams RFC-4180 output). */
export const fetchAuditCsv = async (wsId: string): Promise<Blob> => {
  const r = await fetch(`${SERVER_HTTP}/api/workspaces/${wsId}/audit?format=csv`, {
    headers: { ...authHeaders() },
    credentials: 'include',
  });
  if (!r.ok) throw new Error(`export failed (${r.status})`);
  return r.blob();
};
