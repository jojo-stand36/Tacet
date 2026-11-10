import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { sep } from 'node:path';
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
}

export interface StatePlan {
  dir: string;
  exists: boolean;
  /** The event log is there. */
  events: boolean;
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
    checkouts: [],
    ...(note ? { note } : {}),
  };
  if (!plan.exists) return plan;
  const pid = await liveRun(paths.lock);
  if (pid !== undefined) {
    throw new StatePurgeError(
      `a tacet run is live for this repo (process ${pid}): stop it before purging its state`,
    );
  }
  // Only looked at when it exists: the manager would create it.
  if (!existsSync(paths.worktrees)) return plan;
  const worktrees = await manager(io, root, paths);
  for (const w of await worktrees.registered()) {
    const kept = await worktrees.check(w.id);
    plan.checkouts.push({
      id: w.id,
      path: w.path,
      missing: w.missing,
      ...(kept ? { kept: kept.message } : {}),
    });
  }
  return plan;
}

/**
 * Remove the repo's run state (#211), holding the run lock so no `tacet run` starts meanwhile:
 * each checkout through `WorktreeManager.remove` (refused with unintegrated work unless `force`),
 * then the rest of the state dir. Never `git worktree prune`, which would also prune the user's own
 * worktrees; the dir is kept if git still lists a worktree in it. `tacet/*` branches are kept.
 */
export async function applyState(
  io: Io,
  root: string,
  userDir: string,
  force: boolean,
): Promise<StateResult> {
  const { paths } = pathsFor(io, root, userDir);
  const result: StateResult = { removed: [], refused: [], leftovers: [], dirRemoved: false };
  if (!existsSync(paths.dir)) return result;
  takeLock(paths.lock);
  let keepLock = true;
  try {
    if (existsSync(paths.worktrees)) {
      const worktrees = await manager(io, root, paths);
      for (const w of await worktrees.registered()) {
        try {
          await worktrees.remove(w.id, { force });
          result.removed.push(w.path);
        } catch (err) {
          result.refused.push({
            id: w.id,
            path: w.path,
            missing: w.missing,
            kept: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    if (result.refused.length > 0) return result;
    result.leftovers = registeredUnder(root, paths.dir);
    if (result.leftovers.length > 0) return result;
    rmSync(paths.dir, { recursive: true, force: true });
    keepLock = false;
    result.dirRemoved = true;
    return result;
  } finally {
    if (keepLock) rmSync(paths.lock, { force: true });
  }
}

/** Take the Mini-conductor's lock as `tacet run` would, so none starts during the purge. */
function takeLock(lock: string): void {
  try {
    writeFileSync(lock, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  // Left by a run that is gone (checked by planState just before): take it over once.
  rmSync(lock, { force: true });
  try {
    writeFileSync(lock, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
  } catch {
    throw new StatePurgeError('a tacet run started for this repo: stop it before purging');
  }
}

/** Worktrees git still has registered at or under `dir`. On any doubt, `dir` itself. */
function registeredUnder(root: string, dir: string): string[] {
  let out: string;
  try {
    out = execFileSync('git', [...SAFE_GIT_ARGS, '-C', root, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
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
