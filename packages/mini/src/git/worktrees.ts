import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { SAFE_GIT_ARGS, workerWorktree } from '@tacet/core/node';
import type { Workspace, Workspaces } from '../daemon/ports.js';

const exec = promisify(execFile);

export interface GitWorktreesOptions {
  /** The repo's main checkout. */
  repoRoot: string;
  /** Where the checkouts go, outside the repo: `<repoStateDir>/worktrees` in standalone mode. */
  root: string;
  /** PATH and HOME are taken from here; nothing else. */
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

/**
 * Interim git-worktree `Workspaces` for standalone mode (#21), until the worktree manager (#16,
 * PR #103) implements the port and replaces this file. Each Worker session gets a detached
 * worktree at `base` (or the repo's HEAD) with its own object store, as the Codex adapter
 * expects. A checkout's path is derived from its id, so a restarted Mini-conductor finds it
 * again. No GC: removal is the manager's job; the daemon never removes a checkout itself.
 */
export class GitWorktrees implements Workspaces {
  readonly #o: GitWorktreesOptions;
  readonly #root: string;
  /** `git worktree add` takes a lock on the repo: one at a time. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(o: GitWorktreesOptions) {
    this.#o = o;
    this.#root = resolve(o.root);
  }

  create(workerId: string, base?: string): Promise<Workspace> {
    const next = this.#queue.then(() => this.#create(workerId, base));
    this.#queue = next.catch(() => {});
    return next;
  }

  async get(id: string): Promise<Workspace | undefined> {
    const path = this.#path(id);
    return path !== undefined && existsSync(path) ? { id, path } : undefined;
  }

  async remove(id: string): Promise<void> {
    const path = this.#path(id);
    if (path === undefined || !existsSync(path)) return;
    const next = this.#queue.then(() => this.#git(['worktree', 'remove', '--force', path]));
    this.#queue = next.catch(() => {});
    await next;
  }

  async #create(workerId: string, base?: string): Promise<Workspace> {
    const id = `ws-${workerId.replace(/[^\w.-]/g, '_')}`;
    const path = this.#path(id) as string;
    if (existsSync(path)) throw new Error(`checkout ${id} already exists`);
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
    const at = base ?? (await this.#git(['rev-parse', '--verify', 'HEAD^{commit}']));
    await this.#git(['worktree', 'add', '-q', '--detach', path, at]);
    const wt = workerWorktree(path, this.#o.repoRoot);
    if (!wt) throw new Error(`checkout ${id} is not a worktree of the repo`);
    mkdirSync(join(wt.gitDir, 'objects'), { recursive: true });
    return { id, path };
  }

  /** The checkout's path, or undefined for an id that is not one of ours. */
  #path(id: string): string | undefined {
    return /^ws-[\w.-]+$/.test(id) && !id.includes('..') ? join(this.#root, id) : undefined;
  }

  async #git(args: string[]): Promise<string> {
    const env = this.#o.env ?? process.env;
    try {
      const { stdout } = await exec('git', [...SAFE_GIT_ARGS, ...args], {
        cwd: this.#o.repoRoot,
        env: {
          ...(env.PATH !== undefined ? { PATH: env.PATH } : {}),
          ...(env.HOME !== undefined ? { HOME: env.HOME } : {}),
          GIT_DIR: join(this.#o.repoRoot, '.git'),
        },
        timeout: this.#o.timeoutMs ?? 60_000,
        encoding: 'utf8',
      });
      return stdout.trim();
    } catch (err) {
      const e = err as { stderr?: string; killed?: boolean };
      const why = e.killed ? 'timed out' : (e.stderr ?? String(err)).trim().slice(0, 500);
      throw new Error(`git ${args.slice(0, 2).join(' ')}: ${why}`);
    }
  }
}
