import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GitBridge, isValidRef } from './git.js';

const exec = promisify(execFile);

describe('isValidRef', () => {
  it('accepts ordinary branch names and rejects dangerous ones', () => {
    expect(isValidRef('feature/foo-bar')).toBe(true);
    expect(isValidRef('main')).toBe(true);
    expect(isValidRef('')).toBe(false);
    expect(isValidRef('-rf')).toBe(false); // looks like a flag
    expect(isValidRef('has space')).toBe(false);
    expect(isValidRef('a..b')).toBe(false);
    expect(isValidRef('weird~ref')).toBe(false);
  });
});

describe('GitBridge', () => {
  let dir: string;
  let git: GitBridge;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'markup-git-'));
    const run = (...args: string[]) => exec('git', args, { cwd: dir });
    await run('init', '-q', '-b', 'main');
    await run('config', 'user.email', 'test@example.com');
    await run('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(dir, 'README.md'), '# hi\n');
    git = new GitBridge(dir);
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports status, commits, and branches', async () => {
    const before = await git.status();
    expect(before.branch).toBe('main');
    expect(before.files.some((f) => f.path === 'README.md')).toBe(true);

    const { sha } = await git.commit('initial commit');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    const after = await git.status();
    expect(after.files).toHaveLength(0);

    await git.createBranch('feature/x');
    expect(await git.currentBranch()).toBe('feature/x');
    const list = await git.listBranches();
    expect(list).toEqual(expect.arrayContaining(['main', 'feature/x']));

    await git.checkout('main');
    expect(await git.currentBranch()).toBe('main');
  });
});
