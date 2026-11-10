import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { tokenKey } from './auth/secret.js';

/** `~/.tacet/state`, the default for config `events.state_dir`. Never inside a repo. */
export function defaultStateDir(home: string = homedir()): string {
  return join(home, '.tacet', 'state');
}

/**
 * The state directory config `events.state_dir` names, or the default. `~` and `~/...` are
 * expanded; anything else must be absolute. Refused inside `repoRoot`, where it could be
 * committed or read by Workers. Throws `Error` with the reason.
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
    throw new Error(`events.state_dir must be absolute or start with ~/ (got ${configured})`);
  }
  dir = resolve(dir);
  if (repoRoot !== undefined) {
    const rel = relative(canonical(resolve(repoRoot)), canonicalPrefix(dir));
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
      throw new Error(`events.state_dir ${configured} is inside the repo; put it outside`);
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

function canonical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}
