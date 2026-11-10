import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync, rmdirSync, rmSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
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
  /** Branches (other than its own) that hold its work, so it survives the purge there. */
  heldBy?: string[];
}

export interface StatePlan {
  dir: string;
  exists: boolean;
  /** The event log is there. */
  events: boolean;
  /** Everything directly in the state dir, all of which goes (Worker homes, logs, the lock). */
  entries: string[];
  /** Tacet's internal refs (`refs/tacet/*`, e.g. a task's pinned target, #236): all deleted. */
  refs: string[];
  checkouts: StateCheckout[];
  /** Set when the config could not be read and the default state dir was assumed. */
  note?: string;
}

export interface StateResult {
  removed: string[];
  /** Internal refs deleted. */
  refs: string[];
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
    refs: [],
    checkouts: [],
    ...(note ? { note } : {}),
  };
  if (!plan.exists) return plan;
  const pid = await liveRun(paths.lock);
  if (pid !== undefined) throw liveRunError(pid);
  plan.entries = readdirSync(paths.dir).sort();
  plan.refs = [...internalRefs(io, root).keys()];
  // Only looked at when it exists: the manager would create it.
  if (!existsSync(paths.worktrees)) return plan;
  const worktrees = await manager(io, root, paths);
  const tips = tacetTips(io, root);
  for (const w of await worktrees.registered()) {
    const kept = await worktrees.check(w.id, { landed: keptElsewhere(tips, w.branchName) });
    const heldBy = await worktrees.holders(w.id);
    plan.checkouts.push({
      id: w.id,
      path: w.path,
      missing: w.missing,
      ...(kept ? { kept: kept.message, forceable: true } : {}),
      ...(heldBy.length > 0 ? { heldBy } : {}),
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
    refs: [],
  };
  if (!existsSync(paths.dir)) return result;
  if (note) {
    throw new StatePurgeError(
      'the config could not be read, so where the run state lives is unknown: fix .tacet/tacet.yaml first',
    );
  }
  const { withStoppedMini, WorktreeKeptError } = await import('@tacet/mini');
  let locked: { errors: unknown[] };
  try {
    locked = await withStoppedMini(paths.lock, async () => {
      if (existsSync(paths.worktrees)) {
        const worktrees = await manager(io, root, paths);
        const tips = tacetTips(io, root);
        for (const w of await worktrees.registered()) {
          try {
            await worktrees.remove(w.id, {
              force,
              keepBranch: true,
              landed: keptElsewhere(tips, w.branchName),
            });
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
      // Tacet's internal refs go with its state; the tacet/* branches are the user's to keep.
      for (const [ref, tip] of internalRefs(io, root)) {
        try {
          execFileSync('git', [...SAFE_GIT_ARGS, '-C', root, 'update-ref', '-d', ref, tip], {
            stdio: 'ignore',
            env: gitEnv(io),
          });
          result.refs.push(ref);
        } catch {
          result.warnings.push(`could not delete ${ref}`);
        }
      }
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
  result.warnings.push(...locked.errors.map((e) => (e instanceof Error ? e.message : String(e))));
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

/** `refs/tacet/*` and their tips (#236): never branches, only Tacet's own bookkeeping. */
function internalRefs(io: Io, root: string): Map<string, string> {
  const refs = new Map<string, string>();
  let out = '';
  try {
    out = execFileSync(
      'git',
      [
        ...SAFE_GIT_ARGS,
        '-C',
        root,
        'for-each-ref',
        '--format=%(objectname) %(refname)',
        'refs/tacet/',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: gitEnv(io) },
    );
  } catch {
    // None listed: none deleted.
  }
  for (const line of out.split('\n')) {
    const [tip, ref] = line.trim().split(' ');
    if (tip && ref?.startsWith('refs/tacet/') && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(tip)) {
      refs.set(ref, tip);
    }
  }
  return refs;
}

/**
 * Every `refs/heads/tacet/*` branch and its tip. The purge keeps them all, so (owner decision on
 * #211) work they hold counts as kept: a checkout whose commits are on one need no `--force`.
 */
function tacetTips(io: Io, root: string): Map<string, string> {
  const tips = new Map<string, string>();
  let out = '';
  try {
    out = execFileSync(
      'git',
      [
        ...SAFE_GIT_ARGS,
        '-C',
        root,
        'for-each-ref',
        '--format=%(objectname) %(refname)',
        'refs/heads/tacet/',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: gitEnv(io) },
    );
  } catch {
    // None counted: checkouts are then kept unless forced, as before.
  }
  for (const line of out.split('\n')) {
    const [tip, ref] = line.trim().split(' ');
    if (tip && ref && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(tip)) tips.set(ref, tip);
  }
  return tips;
}

/** The kept `tacet/*` tips that may cover a checkout: never its own `tacet/<id>` branch. */
function keptElsewhere(tips: ReadonlyMap<string, string>, ownBranch: string): string[] {
  const own = `refs/heads/${ownBranch}`;
  return [...new Set([...tips].filter(([ref]) => ref !== own).map(([, tip]) => tip))];
}

function gitEnv(io: Io): Record<string, string> {
  const env = io.env ?? process.env;
  return {
    ...(env.PATH !== undefined ? { PATH: env.PATH } : {}),
    ...(env.HOME !== undefined ? { HOME: env.HOME } : {}),
  };
}

/** Worktrees git still has registered at or under `dir`. On any doubt, `dir` itself. */
function registeredUnder(io: Io, root: string, dir: string): string[] {
  let out: string;
  try {
    out = execFileSync('git', [...SAFE_GIT_ARGS, '-C', root, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: gitEnv(io),
    });
  } catch {
    return [dir];
  }
  // Both sides as given and resolved: a missing worktree path cannot be resolved, and git may
  // report either form (macOS: /var is a symlink to /private/var).
  const bases = [...new Set([resolve(dir), real(dir)])];
  const under = (p: string) => bases.some((b) => p === b || p.startsWith(`${b}${sep}`));
  return out
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
    .filter((path) => under(resolve(path)) || under(real(path)));
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
