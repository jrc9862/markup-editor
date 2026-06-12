import fs from 'node:fs';
import chokidar from 'chokidar';
import { applyStringToYText } from '@markup/sync-core';
import type { DocConnection } from './client.js';

/** Origin tag for Yjs transactions made by this daemon (disk -> Y). */
const DISK_ORIGIN = 'markup-cli-disk';

const DEBOUNCE_MS = 200;

/**
 * Two-way sync between a local file and a connected document.
 *
 *  - Y -> disk: any remote change to the Y.Text is debounce-written to file.
 *  - disk -> Y: file changes are minimal-diffed into the Y.Text, so they
 *    merge with concurrent browser edits instead of clobbering them.
 *
 * Loop guard: we remember the exact content we last wrote to disk and ignore
 * watcher events that report that same content, so our own writes don't echo
 * back into the document.
 */
export function startDaemon(conn: DocConnection, filePath: string): () => void {
  const { ytext } = conn;

  // Content of our most recent own write (or read) of the file.
  let lastSynced = ytext.toString();
  let writeTimer: NodeJS.Timeout | null = null;

  const writeToDisk = () => {
    const content = ytext.toString();
    if (content === lastSynced && fs.existsSync(filePath)) return;
    lastSynced = content;
    fs.writeFileSync(filePath, content);
    log(`wrote ${byteLabel(content)} to ${filePath}`);
  };

  // --- Y -> disk -----------------------------------------------------------
  const observer = (_e: unknown, tr: { origin: unknown }) => {
    if (tr.origin === DISK_ORIGIN) return; // our own disk import; skip
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(writeToDisk, DEBOUNCE_MS);
  };
  ytext.observe(observer);

  // --- disk -> Y -----------------------------------------------------------
  // vim (and many editors) save by writing a temp file and renaming it over
  // the original — a new inode, surfaced as unlink+add rather than change.
  // `atomic` absorbs the rename dance, `awaitWriteFinish` waits out partial
  // writes, and listening to 'add' catches the recreated file.
  const watcher = chokidar.watch(filePath, {
    ignoreInitial: true,
    atomic: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 },
  });
  const importFromDisk = () => {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      return; // transient (e.g. editor atomic-rename mid-write); next event wins
    }
    if (content === lastSynced) return; // loop guard: that was our own write
    lastSynced = content;
    applyStringToYText(ytext, content, DISK_ORIGIN);
    log(`pushed local edit of ${filePath}`);
  };
  watcher.on('change', importFromDisk);
  watcher.on('add', importFromDisk);

  log(`watching ${filePath} (Ctrl+C to stop)`);

  return () => {
    ytext.unobserve(observer);
    if (writeTimer) clearTimeout(writeTimer);
    void watcher.close();
  };
}

function byteLabel(s: string): string {
  return `${Buffer.byteLength(s)} bytes`;
}

function log(msg: string): void {
  console.log(`[markup] ${msg}`);
}

export { DISK_ORIGIN };
