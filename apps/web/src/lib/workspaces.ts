'use client';

import type {
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
