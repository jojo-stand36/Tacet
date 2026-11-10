import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Session directories are named by the session's UUID; nothing else under the root is ours. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Remove one session's Claude config directory (#153): its transcript and its `.claude.json`.
 * Only a UUID-named, real (not symlinked) directory of the current user is removed.
 */
export function removeClaudeConfigDir(root: string, vendorSessionId: string): boolean {
  if (!UUID.test(vendorSessionId)) throw new Error('a PTY session is named by its UUID');
  const dir = join(root, vendorSessionId);
  if (!ownDir(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/**
 * Remove the session directories under `root` that nothing has written to for `maxAgeMs` (#153):
 * sessions no Mini-conductor discarded, e.g. after a crash. `keep` names the directories of
 * sessions open in this process, which are never removed. Returns how many were removed.
 */
export function sweepClaudeConfigDirs(
  root: string,
  maxAgeMs: number,
  keep: ReadonlySet<string>,
  now = Date.now(),
): number {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!UUID.test(name) || keep.has(name)) continue;
    const dir = join(root, name);
    if (!ownDir(dir)) continue;
    if (now - newestMtime(dir) < maxAgeMs) continue;
    rmSync(dir, { recursive: true, force: true });
    removed++;
  }
  return removed;
}

function ownDir(path: string): boolean {
  try {
    const st = lstatSync(path);
    return st.isDirectory() && (!process.getuid || st.uid === process.getuid());
  } catch {
    return false;
  }
}

/** The newest modification time in a directory tree (symlinks not followed), in ms. */
function newestMtime(dir: string, depth = 0): number {
  let newest = lstatSync(dir).mtimeMs;
  if (depth > 6) return newest;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    const t = e.isDirectory() ? newestMtime(p, depth + 1) : lstatSync(p).mtimeMs;
    if (t > newest) newest = t;
  }
  return newest;
}
