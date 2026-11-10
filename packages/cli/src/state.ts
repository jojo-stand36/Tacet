import { existsSync } from 'node:fs';
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

/** The repo `dir` is in: the nearest directory up from it with a `.git`, else `dir` itself. */
export function repoRootFrom(dir: string): string {
  let at = resolve(dir);
  for (;;) {
    if (existsSync(join(at, '.git'))) return at;
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
