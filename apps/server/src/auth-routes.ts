import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  clearSessionCookie,
  isScope,
  newApiTokenSecret,
  parseCookies,
  sessionCookie,
  sha256,
  startSession,
  toMeResponse,
  SESSION_COOKIE,
  type Principal,
} from './auth.js';
import {
  buildAuthUrl,
  exchangeCode,
  newLoginState,
  type OidcConfig,
  type OidcLoginState,
} from './oidc.js';
import {
  createSaml,
  identityFromProfile,
  type SamlConfig,
} from './saml.js';
import type { SAML } from '@node-saml/node-saml';
import type { MetaStore } from './db.js';

const OIDC_STATE_COOKIE = 'markup_oidc';

export interface AuthRouteOpts {
  oidc: OidcConfig | null;
  saml: SamlConfig | null;
  /** Where to send the browser after sign-in (the web app origin). */
  webOrigin: string;
  secureCookies: boolean;
}

/** Sign-in/out + session issuance. Mounted outside the /api auth guard. */
export function registerAuthRoutes(
  app: express.Express,
  meta: MetaStore,
  opts: AuthRouteOpts,
): void {
  // Built once on first use; a signed IdP config is static for the process.
  let saml: SAML | null = null;
  const getSaml = (): SAML => {
    if (!saml) saml = createSaml(opts.saml!);
    return saml;
  };

  app.get('/auth/providers', (_req, res) => {
    res.json({
      oidc: Boolean(opts.oidc),
      saml: Boolean(opts.saml),
      // Dev sign-in is the fallback only when no real IdP is configured.
      dev: !opts.oidc && !opts.saml,
    });
  });

  // Dev sign-in: zero-setup local identity. Configuring a real IdP disables it.
  app.post('/auth/dev', async (req, res) => {
    if (opts.oidc || opts.saml) {
      res.status(404).json({ error: 'dev sign-in is disabled (SSO configured)' });
      return;
    }
    const { email, name } = req.body as { email?: string; name?: string };
    if (!email || !name) {
      res.status(400).json({ error: 'email and name are required' });
      return;
    }
    const user = await meta.upsertUser(uuidv4(), email, name);
    const { secret } = await startSession(meta, user.id);
    res.setHeader('Set-Cookie', sessionCookie(secret, { secure: opts.secureCookies }));
    res.json({ user });
  });

  app.get('/auth/oidc/login', async (_req, res) => {
    if (!opts.oidc) {
      res.status(404).json({ error: 'OIDC is not configured' });
      return;
    }
    const login = newLoginState();
    const url = await buildAuthUrl(opts.oidc, login);
    const value = Buffer.from(JSON.stringify(login)).toString('base64url');
    res.setHeader(
      'Set-Cookie',
      `${OIDC_STATE_COOKIE}=${value}; HttpOnly; Path=/; Max-Age=600; SameSite=Lax` +
        (opts.secureCookies ? '; Secure' : ''),
    );
    res.redirect(url);
  });

  app.get('/auth/oidc/callback', async (req, res) => {
    if (!opts.oidc) {
      res.status(404).json({ error: 'OIDC is not configured' });
      return;
    }
    try {
      const raw = parseCookies(req.headers.cookie)[OIDC_STATE_COOKIE];
      if (!raw) throw new Error('missing login state cookie');
      const login = JSON.parse(
        Buffer.from(raw, 'base64url').toString(),
      ) as OidcLoginState;
      const { code, state } = req.query as { code?: string; state?: string };
      if (!code || state !== login.state) throw new Error('state mismatch');

      const identity = await exchangeCode(opts.oidc, code, login);
      const user = await meta.upsertUser(uuidv4(), identity.email, identity.name);
      const { secret } = await startSession(meta, user.id);
      res.setHeader('Set-Cookie', [
        sessionCookie(secret, { secure: opts.secureCookies }),
        `${OIDC_STATE_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`,
      ]);
      res.redirect(opts.webOrigin);
    } catch (err) {
      console.error('OIDC callback failed:', err);
      res.status(401).json({ error: 'sign-in failed' });
    }
  });

  // --- SAML 2.0 (SP-initiated, HTTP-POST binding) --------------------------

  // SP metadata for configuring the IdP (entity ID, ACS URL, NameID format).
  app.get('/auth/saml/metadata', (_req, res) => {
    if (!opts.saml) {
      res.status(404).json({ error: 'SAML is not configured' });
      return;
    }
    res.type('application/xml');
    res.send(getSaml().generateServiceProviderMetadata(null, null));
  });

  // Kick off login: redirect the browser to the IdP with a signed AuthnRequest.
  app.get('/auth/saml/login', async (_req, res) => {
    if (!opts.saml) {
      res.status(404).json({ error: 'SAML is not configured' });
      return;
    }
    try {
      const url = await getSaml().getAuthorizeUrlAsync('', undefined, {});
      res.redirect(url);
    } catch (err) {
      console.error('SAML login failed:', err);
      res.status(500).json({ error: 'could not start SAML sign-in' });
    }
  });

  // Assertion Consumer Service: the IdP POSTs the signed response here
  // (application/x-www-form-urlencoded). Validate it, then issue a session.
  app.post(
    '/auth/saml/callback',
    express.urlencoded({ extended: false, limit: '256kb' }),
    async (req, res) => {
      if (!opts.saml) {
        res.status(404).json({ error: 'SAML is not configured' });
        return;
      }
      try {
        const { profile } = await getSaml().validatePostResponseAsync(
          req.body as Record<string, string>,
        );
        if (!profile) throw new Error('no assertion in SAML response');
        const identity = identityFromProfile(profile);
        const user = await meta.upsertUser(
          uuidv4(),
          identity.email,
          identity.name,
        );
        const { secret } = await startSession(meta, user.id);
        res.setHeader(
          'Set-Cookie',
          sessionCookie(secret, { secure: opts.secureCookies }),
        );
        res.redirect(opts.webOrigin);
      } catch (err) {
        console.error('SAML callback failed:', err);
        res.status(401).json({ error: 'sign-in failed' });
      }
    },
  );

  app.post('/auth/logout', async (req, res) => {
    const secret = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (secret) await meta.deleteSession(sha256(secret));
    res.setHeader('Set-Cookie', clearSessionCookie());
    res.json({ ok: true });
  });
}

/**
 * Identity routes behind the /api auth guard (res.locals.principal is set).
 * Token management is session-only: tokens belong to a signed-in human.
 */
export function registerTokenRoutes(app: express.Express, meta: MetaStore): void {
  app.get('/api/me', (_req, res) => {
    res.json(toMeResponse(res.locals.principal as Principal));
  });

  const requireUser: express.RequestHandler = (_req, res, next) => {
    const p = res.locals.principal as Principal;
    if (p.kind !== 'user') {
      res.status(403).json({ error: 'sign in to manage API tokens' });
      return;
    }
    next();
  };

  app.get('/api/tokens', requireUser, async (_req, res) => {
    const p = res.locals.principal as Principal & { kind: 'user' };
    res.json(await meta.listApiTokens(p.user.id));
  });

  app.post('/api/tokens', requireUser, async (req, res) => {
    const p = res.locals.principal as Principal & { kind: 'user' };
    const { name, scope } = req.body as { name?: string; scope?: string };
    if (!name || !isScope(scope)) {
      res.status(400).json({
        error: 'name and scope (read|comment|suggest|write) are required',
      });
      return;
    }
    const secret = newApiTokenSecret();
    const id = uuidv4();
    await meta.createApiToken({
      id,
      userId: p.user.id,
      name,
      scope,
      tokenHash: sha256(secret),
    });
    // The plaintext is returned exactly once; only the hash is stored.
    res.status(201).json({ id, name, scope, token: secret });
  });

  app.delete('/api/tokens/:id', requireUser, async (req, res) => {
    const p = res.locals.principal as Principal & { kind: 'user' };
    const ok = await meta.deleteApiToken(p.user.id, req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json({ ok: true });
  });
}
