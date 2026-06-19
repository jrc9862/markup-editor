import fs from 'node:fs';
import path from 'node:path';
import * as Y from 'yjs';

const DIR = '.markup';
const STATE_DIR = 'state';

/**
 * Where the CLI persists a doc's full Yjs state, so offline edits survive a
 * restart and three-way-merge on reconnect (CRDT) instead of being clobbered
 * by server-wins. One file per docId under .markup/state/.
 */
export function statePath(docId: string, cwd = process.cwd()): string {
  return path.join(cwd, DIR, STATE_DIR, `${docId}.bin`);
}

export function hasState(docId: string, cwd = process.cwd()): boolean {
  return fs.existsSync(statePath(docId, cwd));
}

/** Replay persisted Yjs updates into `ydoc`. Returns false if none/unreadable. */
export function loadState(
  ydoc: Y.Doc,
  docId: string,
  cwd = process.cwd(),
): boolean {
  const p = statePath(docId, cwd);
  if (!fs.existsSync(p)) return false;
  try {
    Y.applyUpdate(ydoc, new Uint8Array(fs.readFileSync(p)));
    return true;
  } catch {
    return false; // corrupt snapshot: fall back to server-wins bootstrap
  }
}

/** Persist `ydoc`'s full state as a single Yjs update blob. */
export function saveState(
  ydoc: Y.Doc,
  docId: string,
  cwd = process.cwd(),
): void {
  const p = statePath(docId, cwd);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Y.encodeStateAsUpdate(ydoc));
}
