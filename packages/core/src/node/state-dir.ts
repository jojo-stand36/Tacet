import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tokenKey } from './auth/secret.js';

/** `~/.tacet/state`, the default for config `events.state_dir`. Never inside a repo. */
export function defaultStateDir(home: string = homedir()): string {
  return join(home, '.tacet', 'state');
}

/** Config `events.state_dir` cannot be used; the message says why. */
export class StateDirError extends Error {
  override name = 'StateDirError';
}

/**
 * The state directory config `events.state_dir` names, or the default. `~` and `~/...` are
 * expanded; anything else must be absolute. Refused inside `repoRoot`, where it could be
 * committed or read by Workers. Throws `StateDirError` with the reason.
 */
export function resolveStateDir(
  configured: string | undefined,
  repoRoot?: string,
  home: string = homedir(),
): string {
  if (configured === undefined) return defaultStateDir(home);
  let dir = configured;
  if (dir === '~') dir = home;
  else if (dir.startsWith('~/')) dir = join(home, dir.slice(2));
  if (!isAbsolute(dir)) {
    throw new StateDirError(
      `events.state_dir must be absolute or start with ~/ (got ${configured})`,
    );
  }
  dir = resolve(dir);
  if (repoRoot !== undefined) {
    const rel = relative(canonical(resolve(repoRoot)), canonicalPrefix(dir));
    const outside = rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
    if (!outside) {
      throw new StateDirError(`events.state_dir ${configured} is inside the repo; put it outside`);
    }
  }
  return dir;
}

/** `path` with its longest existing ancestor canonicalized, so a not-yet-created dir compares right. */
function canonicalPrefix(path: string): string {
  let head = path;
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(head), ...tail.reverse());
    } catch {
      const parent = resolve(head, '..');
      if (parent === head) return path;
      tail.push(basename(head));
      head = parent;
    }
  }
}

/**
 * Per-repo state directory `<stateDir>/<repo-hash>`: the event log and every other piece of
 * Tacet state for that repo live here. `<repo-hash>` is keyed by the canonical repo path (symlinks
 * resolved when the path exists, e.g. macOS `/var` → `/private/var`), so every caller gets the
 * same directory however it spells the path.
 */
export function repoStateDir(repoPath: string, stateDir: string = defaultStateDir()): string {
  return join(stateDir, tokenKey(canonical(resolve(repoPath))).slice(0, 16));
}

/** Where each piece of a repo's Tacet state lives, under `repoStateDir` (#21). */
export interface RepoStatePaths {
  /** `<stateDir>/<repo-hash>` */
  dir: string;
  /** Its `<repo-hash>`: the repo id on events, never a path. */
  repoId: string;
  /** The event log (`defaultEventDbPath`). */
  events: string;
  /** The Mini-conductor's single-instance lock. */
  lock: string;
  /** The Workers' checkouts (standalone mode). */
  worktrees: string;
}

export function repoStatePaths(
  repoPath: string,
  stateDir: string = defaultStateDir(),
): RepoStatePaths {
  const dir = repoStateDir(repoPath, stateDir);
  return {
    dir,
    repoId: basename(dir),
    events: join(dir, 'events.db'),
    lock: join(dir, 'mini.lock'),
    worktrees: join(dir, 'worktrees'),
  };
}

function canonical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/** Where the Conductor keeps its state (#23), under the user layer's `events.state_dir`. */
export interface ConductorStatePaths {
  dir: string;
  /** Its event log: the registry of Mini-conductors (`registry.*`). */
  events: string;
  /** Its single-instance lock. */
  lock: string;
}

export function conductorStatePaths(stateDir: string = defaultStateDir()): ConductorStatePaths {
  const dir = join(stateDir, 'conductor');
  return { dir, events: join(dir, 'events.db'), lock: join(dir, 'conductor.lock') };
}
