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
 * or an empty directory. Anything that existed before, has content, or is a link is kept, so a
 * Worker's own file is never removed unless it is empty and has one of these names. Returns what
 * was removed, relative to `cwd`; errors leave the path in place.
 */
export function removeSandboxPlaceholders(cwd: string, before: ReadonlySet<string>): string[] {
  const removed: string[] = [];
  for (const p of SANDBOX_PLACEHOLDERS) {
    if (before.has(p)) continue;
    const full = join(cwd, p);
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
