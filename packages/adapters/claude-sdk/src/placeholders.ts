import { lstatSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Paths in a checkout that Claude Code's Linux sandbox (on with the scrub, #150) protects, and
 * where it leaves an empty placeholder (a 0-byte file or an empty directory) when the path was
 * missing: created as the session starts, tool call or not, and left after it ends (#263).
 * Observed live on Claude Code 2.1.319 with bubblewrap and socat; children before their parents.
 */
export const SANDBOX_PLACEHOLDERS: readonly string[] = [
  '.claude/agents',
  '.claude/commands',
  '.claude/.cc-writes',
  '.claude',
  'node_modules/.bin',
  'node_modules',
  '.env',
  '.env.local',
  '.env.development',
  '.env.development.local',
  '.env.production',
  '.env.production.local',
  '.env.test',
  '.env.test.local',
  '.gitmodules',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  'bunfig.toml',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
];

/** Whether every parent of `rel` under `cwd` is a directory and not a symlink. */
function parentsAreDirs(cwd: string, rel: string): boolean {
  const segs = rel.split('/').slice(0, -1);
  for (let i = 1; i <= segs.length; i++) {
    try {
      const st = lstatSync(join(cwd, ...segs.slice(0, i)));
      if (st.isSymbolicLink() || !st.isDirectory()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Which of the sandbox's placeholder paths exist in `cwd` now (before a session starts). */
export function placeholderSnapshot(cwd: string): Set<string> {
  return new Set(
    SANDBOX_PLACEHOLDERS.filter((p) => {
      try {
        lstatSync(join(cwd, p));
        return true;
      } catch {
        return false;
      }
    }),
  );
}

/**
 * Removes the placeholders a session's sandbox left in `cwd` (#263): each path in
 * `SANDBOX_PLACEHOLDERS` that was not there before (`before`) and is still a 0-byte regular file
 * or an empty directory. Anything that existed before, has content, or is a link is kept, and
 * nothing behind a symlinked parent is touched, so a Worker's own file is never removed unless it
 * is empty and has one of these names (an empty `.env` it wrote is removed too). Placeholders
 * left by a session that never closed (a crash) look pre-existing to the next one and stay
 * (#263). Returns what
 * was removed, relative to `cwd`; errors leave the path in place.
 */
export function removeSandboxPlaceholders(cwd: string, before: ReadonlySet<string>): string[] {
  const removed: string[] = [];
  for (const p of SANDBOX_PLACEHOLDERS) {
    if (before.has(p)) continue;
    const full = join(cwd, p);
    // Only inside the checkout: every parent of a nested entry must be a real directory, never a
    // symlink a Worker (or the user) made, which would lead the removal elsewhere (#164 review).
    if (!parentsAreDirs(cwd, p)) continue;
    try {
      const st = lstatSync(full);
      if (st.isFile() && st.size === 0) unlinkSync(full);
      else if (st.isDirectory() && readdirSync(full).length === 0) rmdirSync(full);
      else continue;
      removed.push(p);
    } catch {
      // Gone already, or not removable: left as it is.
    }
  }
  return removed;
}
