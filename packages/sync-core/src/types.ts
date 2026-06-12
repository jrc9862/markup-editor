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
}

/** Metadata for a stored document version (edit history). */
export interface VersionMeta {
  id: number;
  docId: string;
  createdAt: string;
  /** Size of the version's content in bytes. */
  size: number;
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
