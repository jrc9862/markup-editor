import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import express from 'express';
import type { Logger } from 'pino';
import type {
  AuditAction,
  AuditTargetType,
  AuthUser,
  DocRole,
  Workspace,
  WorkspaceMember,
} from '@markup/sync-core';
import type { MetaStore } from './db.js';

/**
 * SCIM 2.0 provisioning surface (RFC 7643/7644). An identity provider (Okta,
 * Azure AD, OneLogin) authenticates with a single static bearer token
 * (`MARKUP_SCIM_TOKEN`) and creates/updates/deprovisions **Users** and
 * **Groups**. Users map onto the `users` table; Groups map onto workspaces +
 * `workspace_members` — so provisioning rides the Phase 3 membership model
 * unchanged: a provisioned group member gets the workspace's baseline doc role.
 *
 * Deprovisioning is `active:false` (or DELETE, which we soft-delete): the user
 * row is kept for attribution, but `resolvePrincipal` rejects an inactive user,
 * locking them out of both REST and WebSocket. We also drop their sessions so
 * live tabs fall off on the next request.
 *
 * SCIM has no role concept, so provisioned group members are plain `member`s;
 * in-app admin promotion is unchanged. The router mounts only when the env is
 * set (unset ⇒ the paths 404), mirroring the `MARKUP_REPO_DIR` git routes.
 */

const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';

// New SCIM Groups become workspaces with this baseline doc role for members.
const GROUP_DEFAULT_ROLE: DocRole = 'editor';

export interface ScimOptions {
  token: string;
  serverOrigin: string;
  logger: Logger;
}

// --- Resource shaping --------------------------------------------------------

function userResource(u: AuthUser, base: string): Record<string, unknown> {
  return {
    schemas: [USER_SCHEMA],
    id: u.id,
    userName: u.email,
    name: { formatted: u.name },
    displayName: u.name,
    emails: [{ value: u.email, primary: true }],
    active: u.active !== false,
    meta: {
      resourceType: 'User',
      location: `${base}/Users/${u.id}`,
    },
  };
}

function groupResource(
  ws: Workspace,
  members: WorkspaceMember[],
  base: string,
): Record<string, unknown> {
  return {
    schemas: [GROUP_SCHEMA],
    id: ws.id,
    displayName: ws.name,
    members: members.map((m) => ({
      value: m.userId,
      display: m.name ?? m.email ?? m.userId,
    })),
    meta: {
      resourceType: 'Group',
      location: `${base}/Groups/${ws.id}`,
    },
  };
}

function listResponse(resources: unknown[]): Record<string, unknown> {
  return {
    schemas: [LIST_SCHEMA],
    totalResults: resources.length,
    startIndex: 1,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

function scimError(
  res: express.Response,
  status: number,
  detail: string,
  scimType?: string,
): void {
  res.status(status).json({
    schemas: [ERROR_SCHEMA],
    status: String(status),
    ...(scimType ? { scimType } : {}),
    detail,
  });
}

// --- Filter parsing ----------------------------------------------------------

/**
 * Parse the tiny slice of SCIM filter syntax IdPs actually send before a
 * create: `attr eq "value"`. Returns null for anything else (we then list all).
 */
export function parseScimFilter(
  filter: string | undefined,
): { attr: string; value: string } | null {
  if (!filter) return null;
  const m = /^\s*(\w+)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/.exec(filter);
  if (!m) return null;
  return { attr: m[1], value: m[2].replace(/\\"/g, '"') };
}

/** Normalize a SCIM boolean (Azure AD sometimes sends the string "False"). */
function scimBool(v: unknown): boolean {
  return v === true || v === 'true' || v === 'True';
}

/** Extract a display name from a SCIM User body's various name shapes. */
function nameFromUser(body: Record<string, unknown>): string | undefined {
  if (typeof body.displayName === 'string' && body.displayName.trim()) {
    return body.displayName.trim();
  }
  const name = body.name as
    | { formatted?: string; givenName?: string; familyName?: string }
    | undefined;
  if (name) {
    if (typeof name.formatted === 'string' && name.formatted.trim()) {
      return name.formatted.trim();
    }
    const joined = [name.givenName, name.familyName]
      .filter((s): s is string => typeof s === 'string' && s.length > 0)
      .join(' ');
    if (joined) return joined;
  }
  return undefined;
}

/** userName, or the first email value, as the account's email. */
function emailFromUser(body: Record<string, unknown>): string | undefined {
  if (typeof body.userName === 'string' && body.userName.trim()) {
    return body.userName.trim();
  }
  const emails = body.emails as Array<{ value?: string }> | undefined;
  const first = emails?.find((e) => typeof e.value === 'string');
  return first?.value;
}

/** User ids referenced by a SCIM Group `members` array. */
function memberIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((m) => (m && typeof m === 'object' ? (m as { value?: string }).value : undefined))
    .filter((v): v is string => typeof v === 'string');
}

// --- Router ------------------------------------------------------------------

export function registerScimRoutes(
  app: express.Express,
  meta: MetaStore,
  opts: ScimOptions,
): void {
  const { logger } = opts;
  const router = express.Router();
  const tokenHash = createHash('sha256').update(opts.token).digest();
  const base = `${opts.serverOrigin}/scim/v2`;

  // Best-effort audit of workspace-affecting SCIM actions, so IdP-driven
  // changes show up in the same per-workspace audit viewer as in-app ones.
  const auditScim = (
    workspaceId: string,
    action: AuditAction,
    targetType: AuditTargetType,
    targetId?: string,
    detail?: Record<string, unknown>,
  ): void => {
    void meta
      .appendAudit({
        workspaceId,
        ts: new Date().toISOString(),
        actorName: 'SCIM',
        action,
        targetType,
        targetId,
        detail,
      })
      .catch((err) => logger.error({ err, action }, 'scim audit append failed'));
  };

  // IdPs POST `application/scim+json`, which express.json() ignores by default.
  router.use(express.json({ type: ['application/json', 'application/scim+json'] }));

  // Static bearer auth (constant-time). The IdP has no session/user, so this
  // router sits outside the /api principal guard.
  router.use((req, res, next) => {
    const header = req.headers.authorization ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
    const presentedHash = createHash('sha256').update(presented).digest();
    if (!presented || !timingSafeEqual(presentedHash, tokenHash)) {
      scimError(res, 401, 'invalid or missing bearer token');
      return;
    }
    next();
  });

  // --- Discovery (Azure AD/Okta probe these before syncing) ------------------

  router.get('/ServiceProviderConfig', (_req, res) => {
    res.json({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        {
          type: 'oauthbearertoken',
          name: 'OAuth Bearer Token',
          description: 'Authentication via a static bearer token.',
        },
      ],
    });
  });

  router.get('/ResourceTypes', (_req, res) => {
    res.json(
      listResponse([
        {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
          id: 'User',
          name: 'User',
          endpoint: '/Users',
          schema: USER_SCHEMA,
        },
        {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
          id: 'Group',
          name: 'Group',
          endpoint: '/Groups',
          schema: GROUP_SCHEMA,
        },
      ]),
    );
  });

  router.get('/Schemas', (_req, res) => {
    res.json(listResponse([{ id: USER_SCHEMA }, { id: GROUP_SCHEMA }]));
  });

  // --- Users -----------------------------------------------------------------

  router.get('/Users', async (req, res) => {
    const parsed = parseScimFilter(req.query.filter as string | undefined);
    let users: AuthUser[];
    if (parsed?.attr === 'userName') {
      users = await meta.listUsers({ filter: { userName: parsed.value } });
    } else if (parsed?.attr === 'externalId') {
      const u = await meta.getUserByExternalId(parsed.value);
      users = u ? [u] : [];
    } else {
      users = await meta.listUsers();
    }
    res.json(listResponse(users.map((u) => userResource(u, base))));
  });

  router.get('/Users/:id', async (req, res) => {
    const u = await meta.getUser(req.params.id);
    if (!u) {
      scimError(res, 404, 'user not found');
      return;
    }
    res.json(userResource(u, base));
  });

  router.post('/Users', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const email = emailFromUser(body);
    if (!email) {
      scimError(res, 400, 'userName (or an email) is required', 'invalidValue');
      return;
    }
    if (await meta.getUserByEmail(email)) {
      scimError(res, 409, 'a user with this userName already exists', 'uniqueness');
      return;
    }
    const name = nameFromUser(body) ?? email.split('@')[0];
    const user = await meta.upsertUser(randomUUID(), email, name);
    const externalId =
      typeof body.externalId === 'string' ? body.externalId : undefined;
    // active defaults true; an explicit active:false on create is honored.
    const active = body.active === undefined ? true : scimBool(body.active);
    if (externalId !== undefined || active === false) {
      await meta.updateUser(user.id, { externalId, active });
    }
    const fresh = (await meta.getUser(user.id)) ?? user;
    logger.info({ userId: fresh.id, email }, 'scim user provisioned');
    res.status(201).json(userResource(fresh, base));
  });

  // Full replace (PUT): set name/active from the presented resource.
  router.put('/Users/:id', async (req, res) => {
    const existing = await meta.getUser(req.params.id);
    if (!existing) {
      scimError(res, 404, 'user not found');
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const active = body.active === undefined ? true : scimBool(body.active);
    const updated = await meta.updateUser(req.params.id, {
      name: nameFromUser(body) ?? existing.name,
      active,
    });
    if (existing.active !== false && active === false) {
      await meta.deleteUserSessions(req.params.id);
    }
    res.json(userResource(updated ?? existing, base));
  });

  // Partial update (PATCH): the `active` op is the deprovision/reactivate path.
  router.patch('/Users/:id', async (req, res) => {
    const existing = await meta.getUser(req.params.id);
    if (!existing) {
      scimError(res, 404, 'user not found');
      return;
    }
    const fields: { name?: string; active?: boolean } = {};
    const ops = (req.body?.Operations ?? []) as Array<{
      op?: string;
      path?: string;
      value?: unknown;
    }>;
    for (const op of ops) {
      if ((op.op ?? '').toLowerCase() === 'remove') continue;
      const path = op.path;
      if (path === 'active') {
        fields.active = scimBool(op.value);
      } else if (path === 'displayName' || path === 'name.formatted') {
        if (typeof op.value === 'string') fields.name = op.value;
      } else if (!path && op.value && typeof op.value === 'object') {
        // No-path replace: a partial resource object.
        const v = op.value as Record<string, unknown>;
        if (v.active !== undefined) fields.active = scimBool(v.active);
        const n = nameFromUser(v);
        if (n) fields.name = n;
      }
    }
    const updated = await meta.updateUser(req.params.id, fields);
    if (existing.active !== false && fields.active === false) {
      await meta.deleteUserSessions(req.params.id);
      logger.info({ userId: req.params.id }, 'scim user deprovisioned');
    }
    res.json(userResource(updated ?? existing, base));
  });

  // Soft delete: deactivate + drop sessions (keep the row for attribution).
  router.delete('/Users/:id', async (req, res) => {
    const existing = await meta.getUser(req.params.id);
    if (!existing) {
      scimError(res, 404, 'user not found');
      return;
    }
    await meta.updateUser(req.params.id, { active: false });
    await meta.deleteUserSessions(req.params.id);
    logger.info({ userId: req.params.id }, 'scim user deleted (soft)');
    res.status(204).end();
  });

  // --- Groups (mapped to workspaces) -----------------------------------------

  const emitGroup = async (
    res: express.Response,
    ws: Workspace,
    status = 200,
  ) => {
    const members = await meta.listMembers(ws.id);
    res.status(status).json(groupResource(ws, members, base));
  };

  router.get('/Groups', async (req, res) => {
    const parsed = parseScimFilter(req.query.filter as string | undefined);
    // Resolve by the IdP's external id, or by the exact displayName (IdPs probe
    // these before create). There's no group-name index, but at provisioning
    // volumes a slug lookup is enough; unfiltered listing returns nothing (we
    // don't expose the full workspace set over SCIM).
    let groups: Workspace[] = [];
    if (parsed?.attr === 'externalId') {
      const ws = await meta.getWorkspaceByExternalId(parsed.value);
      groups = ws ? [ws] : [];
    } else if (parsed?.attr === 'displayName') {
      const ws = await meta.getWorkspaceBySlug(slugify(parsed.value));
      groups = ws && ws.name === parsed.value ? [ws] : [];
    }
    const resources = await Promise.all(
      groups.map(async (ws) =>
        groupResource(ws, await meta.listMembers(ws.id), base),
      ),
    );
    res.json(listResponse(resources));
  });

  router.get('/Groups/:id', async (req, res) => {
    const ws = await meta.getWorkspace(req.params.id);
    if (!ws) {
      scimError(res, 404, 'group not found');
      return;
    }
    await emitGroup(res, ws);
  });

  router.post('/Groups', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const displayName =
      typeof body.displayName === 'string' ? body.displayName.trim() : '';
    if (!displayName) {
      scimError(res, 400, 'displayName is required', 'invalidValue');
      return;
    }
    const externalId =
      typeof body.externalId === 'string' ? body.externalId : undefined;
    let slug = slugify(displayName) || 'group';
    // Slugs are globally unique; disambiguate a collision.
    if (await meta.getWorkspaceBySlug(slug)) slug = `${slug}-${randomUUID().slice(0, 8)}`;
    const ws = await meta.createWorkspace(
      randomUUID(),
      displayName,
      slug,
      GROUP_DEFAULT_ROLE,
      externalId,
    );
    auditScim(ws.id, 'workspace.create', 'workspace', ws.id, {
      name: ws.name,
      defaultRole: ws.defaultRole,
    });
    for (const userId of memberIds(body.members)) {
      if (await meta.getUser(userId)) {
        await meta.addMember(ws.id, userId, 'member');
        auditScim(ws.id, 'member.add', 'member', userId, { role: 'member' });
      }
    }
    logger.info({ workspaceId: ws.id, displayName }, 'scim group provisioned');
    await emitGroup(res, ws, 201);
  });

  router.put('/Groups/:id', async (req, res) => {
    const ws = await meta.getWorkspace(req.params.id);
    if (!ws) {
      scimError(res, 404, 'group not found');
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const displayName =
      typeof body.displayName === 'string' ? body.displayName.trim() : ws.name;
    let updated = ws;
    if (displayName !== ws.name) {
      updated = (await meta.updateWorkspace(ws.id, { name: displayName })) ?? ws;
      auditScim(ws.id, 'workspace.update', 'workspace', ws.id, { name: displayName });
    }
    // PUT replaces membership wholesale.
    const desired = new Set(memberIds(body.members));
    await reconcileMembers(meta, ws.id, desired, auditScim);
    await emitGroup(res, updated);
  });

  router.patch('/Groups/:id', async (req, res) => {
    const ws = await meta.getWorkspace(req.params.id);
    if (!ws) {
      scimError(res, 404, 'group not found');
      return;
    }
    const ops = (req.body?.Operations ?? []) as Array<{
      op?: string;
      path?: string;
      value?: unknown;
    }>;
    let renamed: Workspace = ws;
    for (const op of ops) {
      const kind = (op.op ?? '').toLowerCase();
      const path = op.path ?? '';
      if (path === 'displayName' && typeof op.value === 'string') {
        renamed = (await meta.updateWorkspace(ws.id, { name: op.value })) ?? ws;
        auditScim(ws.id, 'workspace.update', 'workspace', ws.id, { name: op.value });
      } else if (path.startsWith('members')) {
        if (kind === 'add') {
          for (const id of memberIds(op.value)) await addGroupMember(meta, ws.id, id, auditScim);
        } else if (kind === 'remove') {
          // Either `members[value eq "id"]` in the path, or ids in the value.
          const inPath = /value eq "([^"]+)"/.exec(path)?.[1];
          const ids = inPath ? [inPath] : memberIds(op.value);
          for (const id of ids) {
            if (await meta.removeMember(ws.id, id)) {
              auditScim(ws.id, 'member.remove', 'member', id);
            }
          }
        } else if (kind === 'replace') {
          await reconcileMembers(meta, ws.id, new Set(memberIds(op.value)), auditScim);
        }
      }
    }
    await emitGroup(res, renamed);
  });

  router.delete('/Groups/:id', async (req, res) => {
    const ws = await meta.getWorkspace(req.params.id);
    if (!ws) {
      scimError(res, 404, 'group not found');
      return;
    }
    await meta.deleteWorkspace(req.params.id);
    logger.info({ workspaceId: req.params.id }, 'scim group deleted');
    res.status(204).end();
  });

  app.use('/scim/v2', router);
}

// --- Membership helpers ------------------------------------------------------

type AuditFn = (
  workspaceId: string,
  action: AuditAction,
  targetType: AuditTargetType,
  targetId?: string,
  detail?: Record<string, unknown>,
) => void;

async function addGroupMember(
  meta: MetaStore,
  wsId: string,
  userId: string,
  audit: AuditFn,
): Promise<void> {
  if (!(await meta.getUser(userId))) return;
  if (await meta.getMembership(wsId, userId)) return;
  await meta.addMember(wsId, userId, 'member');
  audit(wsId, 'member.add', 'member', userId, { role: 'member' });
}

/** Make the workspace's members exactly `desired` (SCIM PUT/replace semantics). */
async function reconcileMembers(
  meta: MetaStore,
  wsId: string,
  desired: Set<string>,
  audit: AuditFn,
): Promise<void> {
  const current = await meta.listMembers(wsId);
  for (const m of current) {
    if (!desired.has(m.userId)) {
      // Never let SCIM strip the last admin; it only manages plain members.
      if (m.role === 'admin') continue;
      if (await meta.removeMember(wsId, m.userId)) {
        audit(wsId, 'member.remove', 'member', m.userId);
      }
    }
  }
  const have = new Set(current.map((m) => m.userId));
  for (const userId of desired) {
    if (!have.has(userId)) await addGroupMember(meta, wsId, userId, audit);
  }
}

/** Local copy of index.ts slugify (URL-safe handle from a display name). */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}
