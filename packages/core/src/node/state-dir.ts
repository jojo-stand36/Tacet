import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { tokenKey } from './auth/secret.js';

/** `~/.tacet/state`, the default for config `events.state_dir`. Never inside a repo. */
export function defaultStateDir(home: string = homedir()): string {
  return join(home, '.tacet', 'state');
}

/**
 * Per-repo state directory `<stateDir>/<repo-hash>`: the event log and every other piece of
 * Tacet state for that repo live here. `<repo-hash>` is keyed by the absolute repo path.
 */
export function repoStateDir(repoPath: string, stateDir: string = defaultStateDir()): string {
  return join(stateDir, tokenKey(resolve(repoPath)).slice(0, 16));
}
