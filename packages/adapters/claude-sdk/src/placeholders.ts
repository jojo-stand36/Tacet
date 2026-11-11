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

/**
 * Paths in the user's `HOME` where the same sandbox leaves an empty placeholder (a file, or a
 * directory: `.claude/ssh`, `.config/{anthropic,gh,git,glab-cli,pip}`, `.pip`) when it was
 * missing (#263), observed live on Claude Code 2.1.319 with bubblewrap and socat (the dotfiles
 * its protected-path list names, which the bundled binary holds as `/.gitconfig` … `/.yarnrc.yml`),
 * and `.npm`, the directory npm makes for the `npm root --global` Claude Code runs as it starts:
 * empty when npm writes no log (`npm_config_logs_max=0`, set by the adapters under the scrub).
 */
export const HOME_PLACEHOLDERS: readonly string[] = [
  '.bash_aliases',
  '.bash_profile',
  '.bashrc',
  '.bunfig.toml',
  '.gitconfig',
  '.netrc',
  '.npmrc',
  '.profile',
  '.yarnrc',
  '.yarnrc.yml',
  '.zshrc',
  '.npm',
  // Empty directories, children before their parents.
  '.claude/ssh',
  '.claude',
  '.config/anthropic',
  '.config/gh',
  '.config/git',
  '.config/glab-cli',
  '.config/pip',
  '.config',
  '.pip',
];

/**
 * The environment the adapters add under the scrub (#263): npm writes no debug log for the
 * `npm root --global` Claude Code runs as it starts, nor for a Worker's own npm commands
 * ("If set to 0, no log files will be written for the current run", npm 10's `logs-max`).
 */
export const SANDBOX_ENV: Readonly<Record<string, string>> = { npm_config_logs_max: '0' };

/** What a session's sandbox may leave behind, and what was there before it started (#263). */
export interface SandboxResidue {
  cwd: string;
  before: Set<string>;
  home: string;
  homeBefore: Set<string>;
}

/** Snapshot the checkout and `home` before a session under the sandbox starts. */
export function residueSnapshot(cwd: string, home: string): SandboxResidue {
  return {
    cwd,
    before: placeholderSnapshot(cwd),
    home,
    homeBefore: placeholderSnapshot(home, HOME_PLACEHOLDERS),
  };
}

/**
 * Remove what the session's sandbox left (#263): the placeholders in the checkout and in `home`
 * that were not there before and are still empty (`removeSandboxPlaceholders`). A placeholder
 * another session running at the same time made looks new to this one and is removed too, and
 * that session's sandbox may make it again; it is still only ever an empty entry.
 */
export function removeSandboxResidue(r: SandboxResidue): string[] {
  return [
    ...removeSandboxPlaceholders(r.cwd, r.before),
    ...removeSandboxPlaceholders(r.home, r.homeBefore, HOME_PLACEHOLDERS).map((p) => join('~', p)),
  ];
}

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

/** Which of the sandbox's placeholder paths (`list`) exist in `cwd` now (before a session starts). */
export function placeholderSnapshot(
  cwd: string,
  list: readonly string[] = SANDBOX_PLACEHOLDERS,
): Set<string> {
  return new Set(
    list.filter((p) => {
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
 * is empty and has one of these names (an empty `.env` it wrote is removed too). For a session
 * that never closed (a crash), the Mini-conductor calls it at its next start with the paths the
 * checkout's base commit or HEAD has as `before` (#263). Returns what was removed, relative to `cwd`;
 * errors leave the path in place.
 */
export function removeSandboxPlaceholders(
  cwd: string,
  before: ReadonlySet<string>,
  list: readonly string[] = SANDBOX_PLACEHOLDERS,
): string[] {
  const removed: string[] = [];
  for (const p of list) {
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
