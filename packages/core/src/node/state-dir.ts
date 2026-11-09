import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { tokenKey } from './auth/secret.js';

/** `~/.tacet/state`, the default for config `events.state_dir`. Never inside a repo. */
export function defaultStateDir(home: string = homedir()): string {
  return join(home, '.tacet', 'state');
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
