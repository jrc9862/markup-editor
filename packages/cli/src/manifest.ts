import fs from 'node:fs';
import path from 'node:path';
import type { Manifest } from '@markup/sync-core';
import { SERVER_HTTP } from './config.js';

const DIR = '.markup';
const FILE = 'manifest.json';

/**
 * Repo-local manifest mapping relative file paths to server docIds.
 * Lives at <cwd>/.markup/manifest.json.
 */
export function manifestPath(cwd = process.cwd()): string {
  return path.join(cwd, DIR, FILE);
}

export function loadManifest(cwd = process.cwd()): Manifest {
  const p = manifestPath(cwd);
  if (!fs.existsSync(p)) {
    return { server: SERVER_HTTP, docs: {} };
  }
  return JSON.parse(fs.readFileSync(p, 'utf8')) as Manifest;
}

export function saveManifest(manifest: Manifest, cwd = process.cwd()): void {
  const p = manifestPath(cwd);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(manifest, null, 2) + '\n');
}

/** Normalize a user-supplied file path to the manifest's relative-path key. */
export function manifestKey(filePath: string, cwd = process.cwd()): string {
  return path.relative(cwd, path.resolve(cwd, filePath));
}
