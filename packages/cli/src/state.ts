import { closeSync, constants, existsSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { type TasksState, tasksProjection } from '@tacet/core';
import {
  type EventStore,
  loadConfig,
  openEventStore,
  type RepoStatePaths,
  repoStatePaths,
  resolveStateDir,
} from '@tacet/core/node';

/**
 * Whether `dir` is the top of a git checkout: its `.git` is a git directory (one with a `HEAD`)
 * or a gitdir file (`gitdir: <path>`, a linked worktree or submodule). Symbolic links are
 * followed, as git follows them. An empty `.git`, or one with only the read-only placeholders
 * Claude Code's Linux sandbox leaves in directories it guards (`config`, `hooks`,
 * `info/.claude-sandbox-noreplace`, but no `HEAD`; #326), is not one: git would not take it for a
 * repository either. A gitdir file's target is not checked, so a stale pointer still counts.
 */
export function isGitCheckout(dir: string): boolean {
  const dotGit = join(dir, '.git');
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(dotGit);
  } catch {
    return false;
  }
  if (st.isDirectory()) {
    try {
      return statSync(join(dotGit, 'HEAD')).isFile();
    } catch {
      return false;
    }
  }
  if (!st.isFile()) return false;
  // The first bytes only: a gitdir file is one short line. Non-blocking, and checked again once
  // open, so a FIFO swapped in after the stat cannot hang the read.
  const buf = Buffer.alloc(8);
  let fd: number | undefined;
  try {
    fd = openSync(dotGit, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return false;
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString('utf8') === 'gitdir: ';
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The repo `dir` is in: the nearest directory up from it that is a git checkout, else `dir`. */
export function repoRootFrom(dir: string): string {
  let at = resolve(dir);
  for (;;) {
    if (isGitCheckout(at)) return at;
    const up = dirname(at);
    if (up === at) return resolve(dir);
    at = up;
  }
}

/** Where this repo's Tacet state is, as `tacet run` puts it (config `events.state_dir`). */
export function statePaths(repoRoot: string, userDir?: string, home?: string): RepoStatePaths {
  const { config } = loadConfig({ repoRoot, ...(userDir ? { userDir } : {}) });
  return repoStatePaths(repoRoot, resolveStateDir(config.events?.state_dir, repoRoot, home));
}

/** The repo's event log opened read-only, or undefined when Tacet never ran here. */
export function openLog(paths: RepoStatePaths): EventStore | undefined {
  if (!existsSync(paths.events)) return undefined;
  return openEventStore(paths.events, { readonly: true });
}

// Shared with a running Mini-conductor, which answers `tacet status` the same way (#201).
export { DONE_STATES, isSubtaskOf, pendingEscalations, rootTasks, subtasksOf } from '@tacet/core';

export function readState(store: EventStore): TasksState {
  return store.replay(tasksProjection);
}

/** Wait `ms`, or less if `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((r) => {
    if (signal?.aborted) return r();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      r();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
