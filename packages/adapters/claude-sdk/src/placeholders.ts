import { randomBytes } from 'node:crypto';
import { linkSync, lstatSync, readdirSync, renameSync, rmdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
  /** Linux only, where the placeholders were observed; absent when the session has no HOME. */
  home?: { dir: string; before: Set<string> };
}

/**
 * Snapshot the checkout and `home` (the HOME the session runs with) before a session under the
 * sandbox starts. HOME only on Linux, where its placeholders were observed: elsewhere removing
 * them would risk the races `removeSandboxPlaceholders` narrows for no gain.
 */
export function residueSnapshot(
  cwd: string,
  home: string | undefined,
  platform: NodeJS.Platform = process.platform,
): SandboxResidue {
  return {
    cwd,
    before: placeholderSnapshot(cwd),
    ...(home !== undefined && platform === 'linux'
      ? { home: { dir: home, before: placeholderSnapshot(home, HOME_PLACEHOLDERS) } }
      : {}),
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
    ...(r.home
      ? removeSandboxPlaceholders(r.home.dir, r.home.before, HOME_PLACEHOLDERS).map((p) =>
          join('~', p),
        )
      : []),
  ];
}

/**
 * Remove `full` only if it is still an empty regular file: renamed aside first (atomic), checked
 * there, then removed, or put back without overwriting what may have taken its name meanwhile.
 */
function removeEmptyFile(full: string): boolean {
  const aside = join(dirname(full), `.tacet-rm-${randomBytes(6).toString('hex')}`);
  renameSync(full, aside);
  try {
    const st = lstatSync(aside);
    if (st.isFile() && st.size === 0) {
      unlinkSync(aside);
      return true;
    }
  } catch {
    // Not removed: put back below, never left under the temporary name.
  }
  try {
    // Never over a file that took the name meanwhile: link fails rather than replace it.
    linkSync(aside, full);
    unlinkSync(aside);
  } catch {
    try {
      renameSync(aside, `${full}.tacet-kept-${randomBytes(4).toString('hex')}`);
    } catch {
      // Left under the temporary name: still the same file, never lost.
    }
  }
  return false;
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
 * Removes the placeholders a session's sandbox left in `cwd` (#263): each path in `list`
 * (default `SANDBOX_PLACEHOLDERS`) that was not there before (`before`) and is still a 0-byte
 * regular file or an empty directory. A file is first renamed aside and checked there, so one
 * that someone writes in its place meanwhile (git renaming a new `~/.gitconfig` over it, say) is
 * never removed: it is linked back, or, if the name was taken again meanwhile, kept beside it as
 * `<name>.tacet-kept-<random>`. A directory is removed only while empty (`rmdir` refuses
 * otherwise). Anything that existed before, has content, or is a link is kept, and
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
      if (st.isFile() && st.size === 0) {
        if (!removeEmptyFile(full)) continue;
      } else if (st.isDirectory() && readdirSync(full).length === 0) rmdirSync(full);
      else continue;
      removed.push(p);
    } catch {
      // Gone already, or not removable: left as it is.
    }
  }
  return removed;
}
