import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * Thin git bridge for "git-native flows" (roadmap #3). Enabled only when
 * MARKUP_REPO_DIR points at a git working tree the server can reach (the
 * self-hosted / local-dev shape, where the server sits alongside the repo).
 * All git invocations use array args (never a shell), so doc paths and commit
 * messages can't inject. When the env var is unset, every route 404s.
 */
export class GitBridge {
  constructor(private readonly dir: string) {}

  static fromEnv(): GitBridge | null {
    const dir = process.env.MARKUP_REPO_DIR;
    return dir ? new GitBridge(dir) : null;
  }

  private async git(...args: string[]): Promise<string> {
    const { stdout } = await exec('git', args, {
      cwd: this.dir,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.trim();
  }

  async currentBranch(): Promise<string> {
    // `--show-current` works even on an unborn branch (no commits yet).
    return this.git('branch', '--show-current');
  }

  async listBranches(): Promise<string[]> {
    const out = await this.git('for-each-ref', '--format=%(refname:short)', 'refs/heads');
    return out ? out.split('\n').filter(Boolean) : [];
  }

  /** Porcelain status as [{ status, path }], parsed from `git status -z`. */
  async status(): Promise<{ branch: string; files: { status: string; path: string }[] }> {
    const branch = await this.currentBranch();
    const raw = await this.git('status', '--porcelain');
    const files = raw
      ? raw.split('\n').map((line) => ({
          status: line.slice(0, 2).trim(),
          path: line.slice(3),
        }))
      : [];
    return { branch, files };
  }

  /** Stage `paths` (or everything when omitted) and commit. Returns the sha. */
  async commit(message: string, paths?: string[]): Promise<{ sha: string }> {
    if (paths && paths.length) await this.git('add', '--', ...paths);
    else await this.git('add', '-A');
    await this.git('commit', '-m', message);
    const sha = await this.git('rev-parse', 'HEAD');
    return { sha };
  }

  /** Create a branch (optionally checking it out). */
  async createBranch(name: string, checkout = true): Promise<void> {
    if (checkout) await this.git('checkout', '-b', name);
    else await this.git('branch', name);
  }

  async checkout(name: string): Promise<void> {
    await this.git('checkout', name);
  }
}

/** A git ref/branch name we'll pass to git: conservative, no flags/paths. */
export function isValidRef(name: string): boolean {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 255 &&
    !name.startsWith('-') &&
    !/[\s~^:?*[\\\x00-\x1f]/.test(name) &&
    !name.includes('..') &&
    !name.endsWith('/') &&
    !name.endsWith('.lock')
  );
}
