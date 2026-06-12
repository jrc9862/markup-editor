'use client';

import { devSignIn, fetchProviders, signOut, useMe } from '@/lib/auth';
import { SERVER_HTTP } from '@/lib/config';

/**
 * Sign-in/out control. Self-contained (own /api/me fetch); reloads the page
 * after a change so every component picks up the new identity.
 */
export default function UserMenu() {
  const { me } = useMe();

  const signIn = async () => {
    const providers = await fetchProviders();
    if (providers.oidc) {
      window.location.href = `${SERVER_HTTP}/auth/oidc/login`;
      return;
    }
    const email = window.prompt('Email');
    if (!email) return;
    const name = window.prompt('Display name', email.split('@')[0]);
    if (!name) return;
    if (await devSignIn(email, name)) window.location.reload();
  };

  if (me?.kind === 'user') {
    return (
      <span className="user-menu">
        <span className="user-name" title={me.user!.email}>
          {me.user!.name}
        </span>
        <button
          className="ghost-btn"
          onClick={async () => {
            await signOut();
            window.location.reload();
          }}
        >
          Sign out
        </button>
      </span>
    );
  }

  return (
    <span className="user-menu">
      <button className="ghost-btn" onClick={signIn}>
        Sign in
      </button>
    </span>
  );
}
