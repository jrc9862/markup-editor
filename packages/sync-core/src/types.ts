/** A document's server-side metadata. */
export interface DocMeta {
  /** Server-assigned stable identifier; also the Yjs room name. */
  docId: string;
  /** Human-friendly name, usually the basename of the source file. */
  name: string;
  /**
   * Relative file path on the machine that registered the doc (e.g.
   * "docs/guides/setup.md"). Drives the directory-tree browser.
   */
  path?: string;
  /** ISO timestamp of creation. */
  createdAt: string;
  /** ISO timestamp of last persisted change. */
  updatedAt: string;
  /** User id of the creator; absent on docs from before identity existed. */
  ownerId?: string;
  /**
   * Role granted to signed-in users with no explicit ACL entry ('none' =
   * private). Defaults to 'editor' to preserve open collaboration.
   */
  linkRole?: DocRole | 'none';
  /** The requesting principal's resolved role (GET /api/docs/:id only). */
  myRole?: DocRole | 'none';
  /**
   * Workspace the doc belongs to (Phase 3). Absent = a personal/legacy doc,
   * governed solely by owner/ACL/link-role. When set, workspace admins act as
   * owner and members get the workspace's baseline role (see `roleFor`).
   */
  workspaceId?: string;
}

/** Request body for creating a document. */
export interface CreateDocRequest {
  name: string;
  /** Relative path of the source file (mirrors local directory structure). */
  path?: string;
  /** Initial markdown contents (e.g. the current file on disk). */
  content?: string;
}

/** Identity advertised over Yjs awareness for presence/cursors. */
export interface PresenceUser {
  name: string;
  color: string;
  /** 'agent' renders an agent badge in presence; defaults to a human. */
  kind?: 'human' | 'agent';
}

/** Metadata for a stored document version (edit history). */
export interface VersionMeta {
  id: number;
  docId: string;
  createdAt: string;
  /** Size of the version's content in bytes. */
  size: number;
  /** Optional human-given label for the version (e.g. "v1.0 draft"). */
  name?: string;
  /** Best-effort attribution: display name of the last editor before snapshot. */
  author?: string;
  /** Stable user id of the last editor, when known. */
  authorId?: string;
}

// --- Identity (Phase 1) -------------------------------------------------------

/**
 * Ordered API-token scopes: each implies the ones before it.
 * `suggest` is the agent-native default — propose, never write directly.
 */
export type TokenScope = 'read' | 'comment' | 'suggest' | 'write';

/** A signed-in user (OIDC or dev sign-in). */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

/** Metadata for a per-user/per-agent API token (plaintext shown only once). */
export interface ApiTokenMeta {
  id: string;
  name: string;
  scope: TokenScope;
  createdAt: string;
  lastUsedAt?: string;
}

/**
 * Per-doc roles, strongest first. Each maps to a maximum capability:
 * owner/editor → write, suggester → suggest, commenter → comment,
 * viewer → read. The effective capability of a request is the weaker of
 * the principal's token scope and its doc role.
 */
export type DocRole = 'owner' | 'editor' | 'suggester' | 'commenter' | 'viewer';

/** One explicit per-user grant on a doc. */
export interface AclEntry {
  userId: string;
  role: DocRole;
  /** Joined for display. */
  email?: string;
  name?: string;
}

// --- Workspaces (Phase 3) -----------------------------------------------------

/**
 * Membership level within a workspace. `admin` manages members and acts as
 * owner over every doc in the workspace; `member` gets the workspace's
 * `defaultRole` on those docs (an owner's explicit ACL grant can promote a
 * member above that baseline).
 */
export type WorkspaceRole = 'admin' | 'member';

/** A workspace: an org/membership container that owns a set of docs. */
export interface Workspace {
  id: string;
  name: string;
  /** URL-safe unique handle. */
  slug: string;
  /** Baseline doc role a plain member gets on the workspace's docs. */
  defaultRole: DocRole;
  createdAt: string;
}

/** One workspace membership (joined with the user for display). */
export interface WorkspaceMember {
  userId: string;
  role: WorkspaceRole;
  /** Joined for display. */
  email?: string;
  name?: string;
}

/** A workspace paired with the requesting user's membership role. */
export interface WorkspaceWithRole extends Workspace {
  role: WorkspaceRole;
}

/** Response of GET /api/me: who the current credentials belong to. */
export interface MeResponse {
  /** user = session cookie; agent = API token; legacy = shared MARKUP_TOKEN. */
  kind: 'user' | 'agent' | 'legacy';
  scope: TokenScope;
  user?: AuthUser;
  /** Label of the API token, for agent principals. */
  tokenName?: string;
}

/** Local repo manifest mapping file paths to server docIds. */
export interface Manifest {
  /** Base URL of the server this repo is wired to. */
  server: string;
  /** Map of relative file path -> docId. */
  docs: Record<string, string>;
}
