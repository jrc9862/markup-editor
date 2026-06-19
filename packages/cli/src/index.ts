#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import open from 'open';
import { applyStringToYText } from '@markup/sync-core';
import { createDoc, getDoc, renameDoc } from './api.js';
import { connectDoc } from './client.js';
import { startDaemon, DISK_ORIGIN } from './daemon.js';
import { loadManifest, saveManifest, manifestKey } from './manifest.js';
import { hasState } from './state.js';
import { WEB_URL } from './config.js';

const program = new Command();

program
  .name('markup')
  .description('Google Docs for Markdown — collaborate on real .md files')
  .version('0.1.0');

/**
 * Resolve (or create) the server doc for a local file and return its docId.
 * New files are seeded with their current on-disk contents.
 */
async function ensureDoc(filePath: string): Promise<string> {
  const abs = path.resolve(filePath);
  const key = manifestKey(filePath);
  const manifest = loadManifest();

  const existing = manifest.docs[key];
  if (existing) {
    const meta = await getDoc(existing);
    if (meta) return existing;
    console.log(`[markup] mapped doc ${existing} no longer exists; recreating`);
  }

  const content = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
  // Send the relative path so the web UI can mirror the local directory tree.
  const meta = await createDoc({
    name: path.basename(abs),
    path: key.split(path.sep).join('/'),
    content,
  });
  manifest.docs[key] = meta.docId;
  saveManifest(manifest);
  console.log(`[markup] registered ${key} -> ${meta.docId}`);
  return meta.docId;
}

program
  .command('open')
  .description('open a markdown file for collaboration and keep it synced')
  .argument('<file>', 'path to a .md file')
  .option('--no-browser', 'do not open the web editor in a browser')
  .action(async (file: string, opts: { browser: boolean }) => {
    const abs = path.resolve(file);
    if (!fs.existsSync(abs)) {
      fs.writeFileSync(abs, '');
      console.log(`[markup] created empty file ${file}`);
    }

    const docId = await ensureDoc(file);
    const diskContent = fs.readFileSync(abs, 'utf8');

    // Offline-capable reconcile: with a persisted base snapshot we fold local
    // (possibly offline) edits in before sync, so the CRDT three-way-merges
    // them with the server instead of server-wins clobbering. With no base
    // yet (first run), bootstrap server-wins and start persisting from here.
    const offline = hasState(docId);
    const conn = await connectDoc(docId, {
      persist: true,
      seedDisk: offline ? diskContent : undefined,
    });

    const merged = conn.ytext.toString();
    if (merged !== diskContent) {
      fs.writeFileSync(abs, merged);
      console.log(
        offline
          ? `[markup] merged local + server edits into ${file}`
          : `[markup] pulled latest server copy into ${file}`,
      );
    }

    const url = `${WEB_URL}/doc/${docId}`;
    console.log(`[markup] editing at ${url}`);
    if (opts.browser) {
      await open(url).catch(() => {
        console.log('[markup] could not open a browser automatically');
      });
    }

    const stop = startDaemon(conn, abs);

    process.on('SIGINT', () => {
      console.log('\n[markup] stopping sync');
      stop();
      conn.close();
      process.exit(0);
    });
  });

program
  .command('sync')
  .description('one-shot sync: merge local file with the server and write back')
  .argument('<file>', 'path to a .md file')
  .action(async (file: string) => {
    const abs = path.resolve(file);
    if (!fs.existsSync(abs)) {
      console.error(`[markup] no such file: ${file}`);
      process.exit(1);
    }

    const docId = await ensureDoc(file);
    const diskContent = fs.readFileSync(abs, 'utf8');

    // With a persisted base, offline edits are folded in before connecting and
    // merged by the CRDT during sync. Without one (first run), push the disk
    // content in explicitly (minimal diff merges with remote), as before.
    const offline = hasState(docId);
    const conn = await connectDoc(docId, {
      persist: true,
      seedDisk: offline ? diskContent : undefined,
    });
    if (!offline) applyStringToYText(conn.ytext, diskContent, DISK_ORIGIN);

    // ... give the provider a beat to flush, then write the merged result.
    await new Promise((r) => setTimeout(r, 500));
    fs.writeFileSync(abs, conn.ytext.toString());

    console.log(`[markup] synced ${file}`);
    conn.close();
    process.exit(0);
  });

program
  .command('mv')
  .description('rename/move a tracked file on disk and on the server')
  .argument('<old>', 'current path to the tracked .md file')
  .argument('<new>', 'new path')
  .action(async (oldFile: string, newFile: string) => {
    const oldKey = manifestKey(oldFile);
    const manifest = loadManifest();
    const docId = manifest.docs[oldKey];
    if (!docId) {
      console.error(`[markup] not tracked: ${oldFile} (run: markup open ...)`);
      process.exit(1);
    }
    const absOld = path.resolve(oldFile);
    const absNew = path.resolve(newFile);
    if (fs.existsSync(absOld)) {
      fs.mkdirSync(path.dirname(absNew), { recursive: true });
      fs.renameSync(absOld, absNew);
    }
    const newKey = manifestKey(newFile);
    delete manifest.docs[oldKey];
    manifest.docs[newKey] = docId;
    saveManifest(manifest);

    const relPath = newKey.split(path.sep).join('/');
    await renameDoc(docId, { name: path.basename(absNew), path: relPath });
    console.log(`[markup] moved ${oldKey} -> ${newKey}`);
  });

program
  .command('status')
  .description('list files in this directory tracked by markup')
  .action(() => {
    const manifest = loadManifest();
    const entries = Object.entries(manifest.docs);
    if (entries.length === 0) {
      console.log('[markup] no tracked files (run: markup open <file.md>)');
      return;
    }
    for (const [file, docId] of entries) {
      console.log(`${file}  ->  ${WEB_URL}/doc/${docId}`);
    }
  });

program.parseAsync().catch((err) => {
  console.error(`[markup] ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
