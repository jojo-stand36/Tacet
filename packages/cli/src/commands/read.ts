import {
  type EscalationStats,
  escalationStats,
  statusEntries,
  type TaskStatusEntry,
  TaskTarget,
} from '@tacet/core';
import type { EventStore, RepoStatePaths, StoredEvent } from '@tacet/core/node';
import { liveControl, livePty, liveStatus } from '../control.js';
import type { Io } from '../io.js';
import { OscFilter } from '../osc-filter.js';
import {
  formatEvent,
  formatStatusEntry,
  isSummaryEvent,
  safeJson,
  terminalSafe,
} from '../render.js';
import {
  DONE_STATES,
  isSubtaskOf,
  openLog,
  readState,
  repoRootFrom,
  rootTasks,
  sleep,
  statePaths,
  subtasksOf,
} from '../state.js';

/**
 * Undo what a Worker's terminal may have left on (#201): attributes, a hidden cursor, the
 * alternate screen, bracketed paste and mouse reporting.
 */
const RESTORE_TERMINAL =
  '\x1b[0m\x1b[?25h\x1b[?1049l\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l';

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
): Promise<
  { store: EventStore; live: () => boolean; repoRoot: string; paths: RepoStatePaths } | undefined
> {
  const repoRoot = repoRootFrom(where.repo ?? io.cwd);
  const paths = statePaths(repoRoot, where['user-dir'], io.home);
  const store = openLog(paths);
  if (!store) {
    io.err(`no Tacet state for ${terminalSafe(repoRoot)}: run \`tacet run "<task>"\` first`);
    return undefined;
  }
  const { miniLockHolder } = await import('@tacet/mini');
  return { store, live: () => miniLockHolder(paths.lock) !== undefined, repoRoot, paths };
}

/** Where a task starts and lands, as recorded when it started (#219); undefined for older tasks. */
function targetOf(store: EventStore, taskId: string): TaskTarget | undefined {
  const data = store.query({ taskId, typePrefix: 'task.target' }).at(-1)?.envelope.data;
  const parsed = TaskTarget.safeParse(data);
  return parsed.success ? parsed.data : undefined;
}

/**
 * `tacet status`: every task with its sub-tasks, open escalations and usage; whether a run is live.
 * A live run answers over its control port (#201); otherwise the log is read, read-only.
 */
export async function status(io: Io, o: Where & { json?: boolean }): Promise<number> {
  const repoRoot = repoRootFrom(o.repo ?? io.cwd);
  const paths = statePaths(repoRoot, o['user-dir'], io.home);
  const { miniLockHolder } = await import('@tacet/mini');
  const pid = miniLockHolder(paths.lock);
  let tasks: TaskStatusEntry[] | undefined;
  let source: 'run' | 'log' = 'log';
  const client = pid !== undefined ? await liveControl(io, repoRoot, paths) : undefined;
  if (client) {
    try {
      tasks = await liveStatus(client);
      source = 'run';
    } catch (err) {
      const why = terminalSafe((err as Error).message);
      io.err(`note: the live run did not answer (${why}); reading the log instead`);
    } finally {
      await client.close();
    }
  }
  if (!tasks) {
    const store = openLog(paths);
    if (!store) {
      if (o.json) io.out(safeJson({ running: pid ?? null, tasks: [], problems: [] }));
      else io.out(`no Tacet state for ${repoRoot}`);
      return 0;
    }
    try {
      tasks = statusEntries(readState(store), (id) => targetOf(store, id));
    } finally {
      store.close();
    }
  }
  // Kept in the log only, whoever answered for the tasks (#254).
  const problems = readProblems(paths);
  // From the log too: how many escalations the gate kept from the user (#25).
  const escalations = readEscalationStats(paths);
  if (o.json) {
    io.out(
      safeJson({
        running: pid ?? null,
        source,
        tasks,
        problems: problems.map(problemJson),
        ...(escalations ? { escalations } : {}),
      }),
    );
    return 0;
  }
  io.out(
    pid
      ? `Mini-conductor running (pid ${pid})${source === 'run' ? '' : '; read from the log'}`
      : 'Mini-conductor not running',
  );
  if (tasks.length === 0) io.out('no tasks');
  for (const t of tasks) io.out(formatStatusEntry(t));
  if (problems.length > 0) {
    io.out('maintenance problems (latest first):');
    for (const p of problems) io.out(`  ${formatEvent(p.envelope)}`);
  }
  if (escalations && escalations.total.raised + escalations.total.raisedByMini > 0) {
    io.out(`escalations, last 7 days: ${formatEscalationStats(escalations.last7Days)}`);
    io.out(`escalations, in all: ${formatEscalationStats(escalations.total)}`);
  }
  return 0;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** The repo's escalation counts (#25), the last 7 days and in all; none without a log. */
function readEscalationStats(
  paths: Parameters<typeof openLog>[0],
): { last7Days: EscalationStats; total: EscalationStats } | undefined {
  const store = openLog(paths);
  if (!store) return undefined;
  try {
    const events = store.query({ typePrefix: 'escalation' }).map((e) => e.envelope);
    const since = new Date(Date.now() - WEEK_MS).toISOString();
    return { last7Days: escalationStats(events, { since }), total: escalationStats(events) };
  } finally {
    store.close();
  }
}

/** One line: what Workers asked, what was answered here, and what reached the user. */
export function formatEscalationStats(s: EscalationStats): string {
  if (s.raised === 0 && s.raisedByMini === 0) return 'none';
  const local = s.resolvedLocally.policy + s.resolvedLocally.precedent + s.resolvedLocally.mini;
  const parts = [`${s.raised} from Workers`];
  if (s.raised > 0) {
    parts.push(
      `${local} answered without you (policy ${s.resolvedLocally.policy}, precedent ${s.resolvedLocally.precedent}, Mini-conductor ${s.resolvedLocally.mini})`,
      `${s.raised - local} to you (${Math.round((s.rate ?? 0) * 100)}%)`,
    );
    if (s.open > 0) parts.push(`${s.open} open`);
  }
  if (s.raisedByMini > 0) parts.push(`${s.raisedByMini} from the Mini-conductor`);
  return parts.join(', ');
}

/** The recent maintenance problems in the repo's log (#254); none without a log. */
function readProblems(paths: Parameters<typeof openLog>[0]): StoredEvent[] {
  const store = openLog(paths);
  if (!store) return [];
  try {
    return recentProblems(store);
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
 * ends. Given a sub-task, its latest session, then each one that replaces it. A PTY Worker
 * running in a live run is shown as its terminal instead, live from the run's port (#201), when
 * the output is a terminal and not `--json`: until that session ends. Its bytes go through
 * `OscFilter` (#302): clipboard writes (OSC 52, kitty's 5522, iTerm2's 1337 copy keys) are
 * removed, and only well-formed text and sequences pass; window titles (in ASCII), hyperlinks,
 * colours and images do.
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
    // A PTY Worker running in a live run: its terminal itself, as it draws (#201, ADR-003 §5).
    const raw = io.raw;
    if (!o.json && raw) {
      // No clipboard writes (OSC 52 and the like) from a Worker's terminal reach the user's (#302).
      const osc = new OscFilter();
      const pty = await livePty(io, opened.repoRoot, opened.paths, session, (chunk) => {
        const shown = osc.push(chunk);
        if (shown.length > 0) raw(shown);
      });
      if (pty) {
        const stop = () => pty.close();
        io.signal?.addEventListener('abort', stop, { once: true });
        if (io.signal?.aborted) stop();
        let code = 1000;
        try {
          code = (await pty.closed).code;
        } finally {
          io.signal?.removeEventListener('abort', stop);
          // An OSC the Worker left open is ended, then whatever its bytes left switched on, the
          // user's own terminal gets back.
          const end = osc.flush();
          if (end.length > 0) raw(end);
          raw(new TextEncoder().encode(RESTORE_TERMINAL));
        }
        if (io.signal?.aborted) return 0;
        if (code === 1000) io.err('\r\n[the Worker session ended]');
        else if (code === 1001) io.err('\r\n[the run ended]');
        else {
          io.err(`\r\n[the terminal stream failed (${code})]`);
          return 1;
        }
        return 0;
      }
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

/**
 * The Mini-conductor's latest upkeep failures (#254): at most 5, from the last 7 days, newest
 * first. Nothing records that one was fixed, so older ones are not shown.
 */
function recentProblems(store: EventStore, now = Date.now()): StoredEvent[] {
  const since = new Date(now - 7 * 86_400_000).toISOString();
  return store
    .query({ typePrefix: 'maintenance.problem' })
    .filter((e) => e.envelope.ts >= since)
    .slice(-5)
    .reverse();
}

/** A problem as `tacet status --json` shows it. */
function problemJson(e: StoredEvent): Record<string, unknown> {
  const d = (e.envelope.data ?? {}) as Record<string, unknown>;
  return {
    ts: e.envelope.ts,
    op: d.op,
    message: d.message,
    ...(e.envelope.taskId !== undefined ? { taskId: e.envelope.taskId } : {}),
    ...(typeof d.workspaceId === 'string' ? { workspaceId: d.workspaceId } : {}),
  };
}
