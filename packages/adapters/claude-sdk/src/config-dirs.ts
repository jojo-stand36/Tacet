import { lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/** Session directories are named by the session's UUID; nothing else under the root is ours. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Remove one session's Claude config directory (#153): its transcript and its `.claude.json`.
 * Only a UUID-named, real (not symlinked) directory of the current user is removed.
 */
export function removeClaudeConfigDir(root: string, vendorSessionId: string): boolean {
  if (!UUID.test(vendorSessionId)) throw new Error('a Claude session is named by its UUID');
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
    // One directory that cannot be read (or is removed meanwhile) never stops the others.
    try {
      if (!ownDir(dir)) continue;
      if (now - newestMtime(dir) < maxAgeMs) continue;
      rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch {
      // Left for the next sweep.
    }
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

/**
 * The newest modification time in a directory tree (symlinks not followed), in ms. Claude Code's
 * transcripts sit about three levels down; the depth cap only bounds a pathological tree.
 */
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

/**
 * The repo a working directory belongs to, for keying per-repo state: for a linked git worktree
 * (a `.git` file pointing into `<repo>/.git/worktrees/<name>`), the main checkout; otherwise the
 * directory itself. Read from git's own pointer files, without running git.
 */
export function repoOf(cwd: string): string {
  try {
    const pointer = /^gitdir: (.+)$/m.exec(readFileSync(join(cwd, '.git'), 'utf8'))?.[1]?.trim();
    if (!pointer) return cwd;
    const gitDir = resolve(cwd, pointer);
    const common = resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim());
    return basename(common) === '.git' ? dirname(common) : cwd;
  } catch {
    return cwd;
  }
}
