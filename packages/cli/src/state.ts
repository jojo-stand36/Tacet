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

/** Terminal task states: nothing more happens to the task. */
export const DONE_STATES = new Set(['completed', 'failed', 'canceled', 'rejected']);

export const isSubtaskOf = (id: string, root: string) => id === root || id.startsWith(`${root}/`);

/** Root tasks (not sub-tasks), oldest first. */
export function rootTasks(state: TasksState) {
  return Object.values(state.tasks)
    .filter((t) => t.task.parentId === undefined && !t.task.id.includes('/'))
    .sort((a, b) => a.task.createdAt.localeCompare(b.task.createdAt));
}

export function subtasksOf(state: TasksState, root: string) {
  return Object.values(state.tasks)
    .filter((t) => t.task.id.startsWith(`${root}/`))
    .sort((a, b) => a.task.id.localeCompare(b.task.id, undefined, { numeric: true }));
}

export function readState(store: EventStore): TasksState {
  return store.replay(tasksProjection);
}

/**
 * Open escalations of a task and its sub-tasks: id, the task it is on, the question. Those of a
 * task that has ended (canceled, say) are left out: nobody waits on their answer.
 */
export function pendingEscalations(state: TasksState, root: string) {
  return Object.values(state.tasks)
    .filter((t) => isSubtaskOf(t.task.id, root) && !DONE_STATES.has(t.state))
    .flatMap((t) =>
      Object.entries(t.escalations)
        .filter(([, x]) => x.status === 'pending')
        .map(([id, x]) => ({ id, taskId: t.task.id, question: x.question })),
    );
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
