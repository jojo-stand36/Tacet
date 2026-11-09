import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SAFE_GIT_ARGS, type WorkerWorktree, workerWorktree } from '@tacet/core/node';
import type { Integrator, Workspace } from '../daemon/ports.js';

/** A Worker's commit, now in the repo's shared object store under its task branch. */
export interface Integration {
  commit: string;
  ref: string;
}

/** The worktree failed its integrity checks: nothing was run in it. */
export class WorktreeRefusedError extends Error {
  override name = 'WorktreeRefusedError';
}

const COMMIT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const MAX_PACK_BYTES = 1024 * 1024 * 1024;

export interface IntegrateOptions {
  /** The Worker's checkout. */
  cwd: string;
  /** The repo's main worktree: the trusted anchor. */
  repoRoot: string;
  /** Branch to point at the Worker's commit, e.g. `refs/heads/tacet/<task>`. */
  ref: string;
  /** Environment to take PATH and HOME from. Nothing else is passed to git. */
  env?: Record<string, string | undefined>;
}

/**
 * Bring a Worker's commits into the repo (owner decision on #119): from the main repo, outside
 * the sandbox, copy the objects reachable from the Worker's HEAD into the shared store, check
 * them, then point `ref` at the commit. Workers never write the shared `.git` themselves.
 *
 * Everything in the Worker's worktree is untrusted. The worktree is checked against the repo root
 * first (`workerWorktree`; a forged pointer throws `WorktreeRefusedError` and no git runs there);
 * the Worker's HEAD is read as data; git runs in the main repo with an explicit `GIT_DIR`, only
 * PATH and HOME, and `SAFE_GIT_ARGS` (no hooks, fsmonitor, reflogs or commit-graph); the Worker's
 * object store is only ever an alternate to read from; and `index-pack --strict` rejects broken or
 * forged objects before anything lands in the shared store.
 *
 * Objects are selected with `--not --branches --tags`, never `--all`: `--all` includes every
 * worktree's HEAD, and another Worker's unintegrated HEAD would make it fail (#124).
 *
 * Returns undefined when `cwd` is not a linked worktree of the repo.
 */
export function integrateWorktree(opts: IntegrateOptions): Integration | undefined {
  let wt: WorkerWorktree | undefined;
  try {
    wt = workerWorktree(opts.cwd, opts.repoRoot);
  } catch (err) {
    throw new WorktreeRefusedError((err as Error).message);
  }
  if (!wt) return undefined;
  const env = opts.env ?? process.env;
  const base: Record<string, string> = {
    ...(env.PATH !== undefined ? { PATH: env.PATH } : {}),
    ...(env.HOME !== undefined ? { HOME: env.HOME } : {}),
    GIT_DIR: wt.commonDir,
  };
  const workerObjects = { ...base, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(wt.gitDir, 'objects') };
  const git = (args: string[], gitEnv: Record<string, string>, input?: Buffer) =>
    execFileSync('git', [...SAFE_GIT_ARGS, ...args], {
      cwd: opts.repoRoot,
      env: gitEnv,
      ...(input ? { input } : {}),
      maxBuffer: MAX_PACK_BYTES,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  const text = (args: string[], gitEnv: Record<string, string>) =>
    git(args, gitEnv).toString('utf8').trim();

  git(['check-ref-format', opts.ref], base);
  const commit = workerHead(wt, (ref) =>
    text(['rev-parse', '--verify', '-q', `${ref}^{commit}`], base),
  );
  if (!commit) return undefined;

  const present = (gitEnv: Record<string, string>) => {
    try {
      git(['rev-list', '--objects', commit, '--not', '--branches', '--tags'], gitEnv);
      return true;
    } catch {
      return false;
    }
  };
  if (!present(base)) {
    // The objects the repo is missing, read through the Worker's store, packed, and indexed into
    // the shared store with every object checked.
    const list = git(
      ['rev-list', '--objects', commit, '--not', '--branches', '--tags'],
      workerObjects,
    );
    const pack = git(['pack-objects', '--stdout', '-q'], workerObjects, list);
    try {
      git(['index-pack', '--stdin', '--strict'], base, pack);
    } catch (err) {
      throw new Error(`the Worker's objects failed the integrity check: ${stderrOf(err)}`);
    }
    if (!present(base)) throw new Error('the Worker commit is still incomplete after copying');
  }
  git(['update-ref', opts.ref, commit], base);
  return { commit, ref: opts.ref };
}

/**
 * The commit the Worker's HEAD names, read as data: a detached HEAD must be a full commit id; a
 * branch HEAD (a Worker without a sandbox, e.g. Claude) is resolved in the main repo, where its
 * branch lives. Undefined for an unborn branch.
 */
function workerHead(wt: WorkerWorktree, resolveRef: (ref: string) => string): string | undefined {
  const file = join(wt.gitDir, 'HEAD');
  if (!lstatSync(file).isFile()) throw new WorktreeRefusedError('the Worker HEAD is not a file');
  const head = readFileSync(file, 'utf8').trim();
  if (COMMIT_ID.test(head)) return head;
  const ref = /^ref: (refs\/heads\/[^\s]+)$/.exec(head)?.[1];
  if (!ref) throw new WorktreeRefusedError('the Worker HEAD is neither a commit nor a branch');
  try {
    const sha = resolveRef(ref);
    return COMMIT_ID.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

function stderrOf(err: unknown): string {
  const stderr = (err as { stderr?: Buffer }).stderr?.toString('utf8').trim();
  return (stderr || (err as Error).message).slice(0, 500);
}

/** `refs/heads/tacet/<task>`, with the task id made safe for a ref name. */
export function taskBranch(taskId: string): string {
  return `refs/heads/tacet/${taskId.replace(/[^A-Za-z0-9/_-]/g, '_').replace(/\/+/g, '/')}`;
}

/** The Mini-conductor's `Integrator` for git worktrees of `repoRoot`. */
export class GitIntegrator implements Integrator {
  readonly #repoRoot: string;
  readonly #env: Record<string, string | undefined>;

  constructor(repoRoot: string, env: Record<string, string | undefined> = process.env) {
    this.#repoRoot = repoRoot;
    this.#env = env;
  }

  async integrate(subtaskId: string, workspace: Workspace): Promise<Integration | undefined> {
    return integrateWorktree({
      cwd: workspace.path,
      repoRoot: this.#repoRoot,
      ref: taskBranch(subtaskId),
      env: this.#env,
    });
  }
}
