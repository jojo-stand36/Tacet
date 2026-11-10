import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync, rmdirSync, rmSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import {
  type RepoStatePaths,
  repoStatePaths,
  resolveStateDir,
  SAFE_GIT_ARGS,
} from '@tacet/core/node';
import type { Io } from '../io.js';
import { statePaths } from '../state.js';

/** One Worker or planner checkout under the repo's state dir. */
export interface StateCheckout {
  id: string;
  path: string;
  /** Deleted by hand: only its git registration is left. */
  missing: boolean;
  /** Why `remove` would keep it (unintegrated work, local files); undefined when removable. */
  kept?: string;
  /** `kept` is the worktree manager's own refusal (`--force` overrides it), not a failure. */
  forceable?: boolean;
}

export interface StatePlan {
  dir: string;
  exists: boolean;
  /** The event log is there. */
  events: boolean;
  /** Everything directly in the state dir, all of which goes (Worker homes, logs, the lock). */
  entries: string[];
  checkouts: StateCheckout[];
  /** Set when the config could not be read and the default state dir was assumed. */
  note?: string;
}

export interface StateResult {
  removed: string[];
  refused: StateCheckout[];
  /** Git still lists these worktrees under the state dir, so the dir was left in place. */
  leftovers: string[];
  /** The state dir itself was removed. */
  dirRemoved: boolean;
  /** Problems ending Worker processes a crashed run left behind. */
  warnings: string[];
}

export class StatePurgeError extends Error {
  override name = 'StatePurgeError';
}

/** Where `tacet run` keeps this repo's state, as it resolves it. */
function pathsFor(io: Io, root: string, userDir: string): { paths: RepoStatePaths; note?: string } {
  try {
    return { paths: statePaths(root, userDir, io.home) };
  } catch {
    return {
      paths: repoStatePaths(root, resolveStateDir(undefined, root, io.home)),
      note: 'the config could not be read, so the default state dir is assumed',
    };
  }
}

async function liveRun(lock: string): Promise<number | undefined> {
  const { miniLockHolder } = await import('@tacet/mini');
  return miniLockHolder(lock);
}

const liveRunError = (pid: number) =>
  new StatePurgeError(
    `a tacet run is live for this repo (process ${pid}): stop it before purging its state`,
  );

async function manager(io: Io, root: string, paths: RepoStatePaths) {
  const { WorktreeManager } = await import('@tacet/mini');
  return new WorktreeManager(root, paths.worktrees, { env: io.env ?? process.env });
}

/**
 * What `tacet uninstall --purge` would do to the repo's run state (#211): the state dir, its event
 * log, and each checkout with the reason the worktree manager would keep it. Changes nothing.
 * Throws `StatePurgeError` while a run holds the repo's lock.
 */
export async function planState(io: Io, root: string, userDir: string): Promise<StatePlan> {
  const { paths, note } = pathsFor(io, root, userDir);
  const plan: StatePlan = {
    dir: paths.dir,
    exists: existsSync(paths.dir),
    events: existsSync(paths.events),
    entries: [],
    checkouts: [],
    ...(note ? { note } : {}),
  };
  if (!plan.exists) return plan;
  const pid = await liveRun(paths.lock);
  if (pid !== undefined) throw liveRunError(pid);
  plan.entries = readdirSync(paths.dir).sort();
  // Only looked at when it exists: the manager would create it.
  if (!existsSync(paths.worktrees)) return plan;
  const worktrees = await manager(io, root, paths);
  for (const w of await worktrees.registered()) {
    const kept = await worktrees.check(w.id);
    plan.checkouts.push({
      id: w.id,
      path: w.path,
      missing: w.missing,
      ...(kept ? { kept: kept.message, forceable: true } : {}),
    });
  }
  return plan;
}

/**
 * Remove the repo's run state (#211) while holding the run lock as `tacet run` takes it, after
 * ending the Worker processes a crashed run left behind: each checkout through
 * `WorktreeManager.remove` (refused with unintegrated work unless `force`; its `tacet/<id>`
 * branch kept), then the rest of the state dir, the lock file last. Never `git worktree prune`,
 * which would also prune the user's own worktrees; the dir is kept if git still lists a worktree
 * in it. Refuses when the config cannot be read: the state may be elsewhere.
 */
export async function applyState(
  io: Io,
  root: string,
  userDir: string,
  force: boolean,
): Promise<StateResult> {
  const { paths, note } = pathsFor(io, root, userDir);
  const result: StateResult = {
    removed: [],
    refused: [],
    leftovers: [],
    dirRemoved: false,
    warnings: [],
  };
  if (!existsSync(paths.dir)) return result;
  if (note) {
    throw new StatePurgeError(
      'the config could not be read, so where the run state lives is unknown: fix .tacet/tacet.yaml first',
    );
  }
  const { withStoppedMini, WorktreeKeptError } = await import('@tacet/mini');
  let locked: { result: void; errors: unknown[] };
  try {
    locked = await withStoppedMini(paths.lock, async () => {
      if (existsSync(paths.worktrees)) {
        const worktrees = await manager(io, root, paths);
        for (const w of await worktrees.registered()) {
          try {
            await worktrees.remove(w.id, { force, keepBranch: true });
            result.removed.push(w.path);
          } catch (err) {
            result.refused.push({
              id: w.id,
              path: w.path,
              missing: w.missing,
              kept: err instanceof Error ? err.message : String(err),
              forceable: err instanceof WorktreeKeptError && !force,
            });
          }
        }
      }
      if (result.refused.length > 0) return;
      result.leftovers = registeredUnder(io, root, paths.dir);
      if (result.leftovers.length > 0) return;
      // Everything but the lock, which goes last, as the lock is released.
      const lockName = basename(paths.lock);
      for (const name of readdirSync(paths.dir)) {
        if (name !== lockName) rmSync(join(paths.dir, name), { recursive: true, force: true });
      }
      result.dirRemoved = true;
    });
  } catch (err) {
    if (err instanceof Error && /running for this repo/.test(err.message)) {
      const pid = await liveRun(paths.lock);
      throw pid !== undefined ? liveRunError(pid) : new StatePurgeError(err.message);
    }
    throw err;
  }
  result.warnings = locked.errors.map((e) => (e instanceof Error ? e.message : String(e)));
  if (result.dirRemoved) {
    try {
      // A run that started since the lock was released keeps its dir: nothing of it is touched.
      rmdirSync(paths.dir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw err;
    }
  }
  return result;
}

/** Worktrees git still has registered at or under `dir`. On any doubt, `dir` itself. */
function registeredUnder(io: Io, root: string, dir: string): string[] {
  const env = io.env ?? process.env;
  let out: string;
  try {
    out = execFileSync('git', [...SAFE_GIT_ARGS, '-C', root, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: {
        ...(env.PATH !== undefined ? { PATH: env.PATH } : {}),
        ...(env.HOME !== undefined ? { HOME: env.HOME } : {}),
      },
    });
  } catch {
    return [dir];
  }
  const base = real(dir);
  return out
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
    .filter((path) => {
      const p = real(path);
      return p === base || p.startsWith(`${base}${sep}`);
    });
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
