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

/** Local repo manifest mapping file paths to server docIds. */
export interface Manifest {
  /** Base URL of the server this repo is wired to. */
  server: string;
  /** Map of relative file path -> docId. */
  docs: Record<string, string>;
}
