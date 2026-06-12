'use client';

import { useCallback, useEffect, useState } from 'react';
import type { MeResponse } from '@markup/sync-core';
import { SERVER_HTTP, authHeaders } from './config';

/**
 * Session auth rides on a httpOnly cookie (credentials: 'include'); the
 * legacy shared token in the Authorization header is the fallback, so /api/me
 * answers either way — `kind: 'user'` means actually signed in.
 */
export async function fetchMe(): Promise<MeResponse | null> {
  try {
    const r = await fetch(`${SERVER_HTTP}/api/me`, {
      headers: authHeaders(),
      credentials: 'include',
    });
    return r.ok ? ((await r.json()) as MeResponse) : null;
  } catch {
    return null;
  }
}

export function useMe(): { me: MeResponse | null; refresh: () => void } {
  const [me, setMe] = useState<MeResponse | null>(null);
  const refresh = useCallback(() => {
    void fetchMe().then(setMe);
  }, []);
  useEffect(refresh, [refresh]);
  return { me, refresh };
}

export async function fetchProviders(): Promise<{ oidc: boolean; dev: boolean }> {
  const r = await fetch(`${SERVER_HTTP}/auth/providers`);
  return (await r.json()) as { oidc: boolean; dev: boolean };
}

export async function devSignIn(email: string, name: string): Promise<boolean> {
  const r = await fetch(`${SERVER_HTTP}/auth/dev`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email, name }),
  });
  return r.ok;
}

export async function signOut(): Promise<void> {
  await fetch(`${SERVER_HTTP}/auth/logout`, {
    method: 'POST',
    credentials: 'include',
  });
}
