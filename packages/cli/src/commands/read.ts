import { TaskTarget } from '@tacet/core';
import type { EventStore, StoredEvent } from '@tacet/core/node';
import type { Io } from '../io.js';
import { formatEvent, formatTask, isSummaryEvent, safeJson, terminalSafe } from '../render.js';
import {
  DONE_STATES,
  isSubtaskOf,
  openLog,
  pendingEscalations,
  readState,
  repoRootFrom,
  rootTasks,
  sleep,
  statePaths,
  subtasksOf,
} from '../state.js';

export interface Where {
  repo?: string;
  'user-dir'?: string;
}

/**
 * Open the repo's log read-only, or say there is none. With it, `live()`: whether a Mini-conductor
 * is running for the repo, so a follower stops once nothing more can be written.
 */
async function open(
  io: Io,
  where: Where,
): Promise<{ store: EventStore; live: () => boolean } | undefined> {
  const repoRoot = repoRootFrom(where.repo ?? io.cwd);
  const paths = statePaths(repoRoot, where['user-dir'], io.home);
  const store = openLog(paths);
  if (!store) {
    io.err(`no Tacet state for ${terminalSafe(repoRoot)}: run \`tacet run "<task>"\` first`);
    return undefined;
  }
  const { miniLockHolder } = await import('@tacet/mini');
  return { store, live: () => miniLockHolder(paths.lock) !== undefined };
}

/** Where a task starts and lands, as recorded when it started (#219); undefined for older tasks. */
function targetOf(store: EventStore, taskId: string): TaskTarget | undefined {
  const data = store.query({ taskId, typePrefix: 'task.target' }).at(-1)?.envelope.data;
  const parsed = TaskTarget.safeParse(data);
  return parsed.success ? parsed.data : undefined;
}

/** `tacet status`: every task with its sub-tasks, open escalations and usage; whether a run is live. */
export async function status(io: Io, o: Where & { json?: boolean }): Promise<number> {
  const repoRoot = repoRootFrom(o.repo ?? io.cwd);
  const paths = statePaths(repoRoot, o['user-dir'], io.home);
  const { miniLockHolder } = await import('@tacet/mini');
  const pid = miniLockHolder(paths.lock);
  const store = openLog(paths);
  if (!store) {
    if (o.json) io.out(safeJson({ running: pid ?? null, tasks: [] }));
    else io.out(`no Tacet state for ${repoRoot}`);
    return 0;
  }
  try {
    const state = readState(store);
    const roots = rootTasks(state);
    if (o.json) {
      const tasks = roots.map((t) => {
        const target = targetOf(store, t.task.id);
        return {
          id: t.task.id,
          goal: t.task.goal,
          state: t.state,
          ...(t.result ? { outcome: t.result.outcome } : {}),
          ...(target ? { target } : {}),
          usage: t.usage,
          subtasks: subtasksOf(state, t.task.id).map((s) => ({
            id: s.task.id,
            goal: s.task.goal,
            state: s.state,
            activeWorkers: s.activeWorkers,
            usage: s.usage,
          })),
          escalations: pendingEscalations(state, t.task.id),
        };
      });
      io.out(safeJson({ running: pid ?? null, tasks }));
      return 0;
    }
    io.out(pid ? `Mini-conductor running (pid ${pid})` : 'Mini-conductor not running');
    if (roots.length === 0) io.out('no tasks');
    for (const t of roots) {
      io.out(formatTask(t, subtasksOf(state, t.task.id)));
      const target = targetOf(store, t.task.id);
      if (target) {
        const where = target.branch ? terminalSafe(target.branch) : 'a detached HEAD';
        io.out(`  targets ${where} (started at ${target.commit.slice(0, 12)})`);
      }
    }
    return 0;
  } finally {
    store.close();
  }
}

/**
 * `tacet logs <task>`: the task's events and its sub-tasks'. Summary-grade by default,
 * `--transcript` adds the Workers' own events, `--json` prints raw envelopes (JSON lines),
 * `--follow` keeps printing until the task is done.
 */
export async function logs(
  io: Io,
  task: string,
  o: Where & { transcript?: boolean; json?: boolean; follow?: boolean },
): Promise<number> {
  const opened = await open(io, o);
  if (!opened) return 1;
  const { store, live } = opened;
  try {
    if (!readState(store).tasks[task]) {
      io.err(`unknown task ${terminalSafe(task)}`);
      return 1;
    }
    let after = 0;
    let stopped = false;
    for (;;) {
      for (const e of store.query({ afterSeq: after })) {
        after = e.seq;
        if (e.envelope.taskId === undefined || !isSubtaskOf(e.envelope.taskId, task)) continue;
        if (!o.transcript && !isSummaryEvent(e.envelope.type)) continue;
        print(io, e, o.json);
      }
      if (!o.follow || io.signal?.aborted) return 0;
      if (DONE_STATES.has(readState(store).tasks[task]?.state ?? '')) return 0;
      // Nothing is running, so nothing more will come; one more read catches a last write.
      if (stopped) return 0;
      stopped = !live();
      await sleep(io.pollMs ?? 250, io.signal);
    }
  } finally {
    store.close();
  }
}

/**
 * `tacet attach <session | task/n>`: follow one Worker session from the log as it runs, until it
 * ends. Given a sub-task, its latest session, then each one that replaces it. Live PTY attach
 * needs the Mini-conductor's control endpoint, which standalone mode does not have yet.
 */
export async function attach(
  io: Io,
  target: string,
  o: Where & { json?: boolean },
): Promise<number> {
  if (target === '') return 2;
  const opened = await open(io, o);
  if (!opened) return 1;
  const { store, live } = opened;
  try {
    const started = () =>
      store.query({ typePrefix: 'worker.started' }).map((e) => ({
        seq: e.seq,
        taskId: e.envelope.taskId ?? '',
        sessionId: String((e.envelope.data as { sessionId?: unknown }).sessionId ?? ''),
      }));
    let session: string | undefined;
    const subtask = target.includes('/') ? target : undefined;
    if (subtask) {
      session = started()
        .filter((s) => s.taskId === subtask)
        .at(-1)?.sessionId;
    } else {
      const matches = [...new Set(started().map((s) => s.sessionId))].filter((s) =>
        s.startsWith(target),
      );
      if (matches.length > 1) {
        io.err(`${terminalSafe(target)} matches ${matches.length} sessions; give more of the id`);
        return 1;
      }
      session = matches[0];
    }
    if (!session) {
      io.err(`no Worker session for ${terminalSafe(target)}`);
      return 1;
    }
    const followed = new Set([session]);
    let after = 0;
    let ended = false;
    let stopped = false;
    for (;;) {
      for (const e of store.query({ afterSeq: after })) {
        after = e.seq;
        const own = sessionOf(e);
        if (e.envelope.sessionId !== session && own !== session) continue;
        print(io, e, o.json);
        if (e.envelope.type === 'worker.ended' && own === session) ended = true;
      }
      if (ended) {
        if (!subtask) return 0;
        // The session may be replaced (restart, handoff, retry): follow the next one while the
        // sub-task is still being worked on.
        const next = started().find((s) => s.taskId === subtask && !followed.has(s.sessionId));
        if (next) {
          followed.add(next.sessionId);
          session = next.sessionId;
          after = next.seq - 1;
          ended = false;
          continue;
        }
        const state = readState(store).tasks[subtask]?.state;
        if (state !== 'working' && state !== 'submitted') return 0;
      }
      if (io.signal?.aborted) return 0;
      if (stopped) {
        io.err(
          'no Mini-conductor is running for this repo; the session continues at the next tacet run',
        );
        return 0;
      }
      stopped = !live();
      await sleep(io.pollMs ?? 250, io.signal);
    }
  } finally {
    store.close();
  }
}

function sessionOf(e: StoredEvent): string | undefined {
  if (!e.envelope.type.startsWith('worker.')) return undefined;
  const id = (e.envelope.data as { sessionId?: unknown }).sessionId;
  return typeof id === 'string' ? id : undefined;
}

function print(io: Io, e: StoredEvent, json?: boolean) {
  io.out(json ? safeJson(e.raw, 0) : formatEvent(e.envelope));
}
