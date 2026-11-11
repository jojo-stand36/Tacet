import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SummaryPacket } from '@tacet/core';
import { wslPathWarnings } from '@tacet/core/node';
import type { Standalone } from '@tacet/mini/standalone';
import type { Io } from '../io.js';
import { formatEvent, formatTask, isSummaryEvent, safeJson, terminalSafe } from '../render.js';
import {
  DONE_STATES,
  isSubtaskOf,
  pendingEscalations,
  readState,
  repoRootFrom,
  rootTasks,
  statePaths,
  subtasksOf,
} from '../state.js';

export interface RunOptions {
  repo?: string;
  'user-dir'?: string;
  /** Acceptance criteria for the task. */
  accept?: string[];
  /** One sub-task per task, even when `tiers.mini` would plan. */
  single?: boolean;
  /** No new task: carry on with the unfinished ones. */
  resume?: boolean;
  /** `<escalation id>=<answer>`, given before the run continues. */
  answer?: string[];
  json?: boolean;
  /** The background run `tacet run --detach` started (#201): never asks; stops for an answer (#269). */
  'detached-child'?: boolean;
}

/** Exit codes of `tacet run`. */
export const EXIT = { done: 0, failed: 1, usage: 2, waiting: 3, interrupted: 130 } as const;

/**
 * `tacet run "<task>"` (#21): host a standalone Mini-conductor in this process until the task is
 * done. On a terminal it asks the user each open escalation, showing the one-time code an answer
 * from another terminal (`tacet answer`) needs (#269); without one it stops with exit code 3 and
 * the escalation ids, for `tacet run --resume --answer <id>=<text>`. Interrupted (SIGINT),
 * open Worker sessions are recorded as `restart` and resume with `--resume`.
 */
export async function run(io: Io, goal: string | undefined, o: RunOptions): Promise<number> {
  const answers: [string, string][] = [];
  for (const a of o.answer ?? []) {
    const eq = a.indexOf('=');
    if (eq <= 0) {
      io.err(`--answer takes <escalation id>=<answer>, got ${terminalSafe(a)}`);
      return EXIT.usage;
    }
    answers.push([a.slice(0, eq), a.slice(eq + 1)]);
  }
  if (goal === undefined && !o.resume) {
    io.err('tacet run needs a task, or --resume');
    return EXIT.usage;
  }

  const repoRoot = repoRootFrom(o.repo ?? io.cwd);
  if (!existsSync(join(repoRoot, '.git'))) {
    io.err(`${terminalSafe(repoRoot)} is not in a git repository: Tacet works on a git repo`);
    return EXIT.failed;
  }
  // Inside WSL, a repo or state directory on a Windows drive works, but badly (#193): say so.
  let stateDir: string | undefined;
  try {
    stateDir = statePaths(repoRoot, o['user-dir'], io.home).dir;
  } catch {
    // A bad config or `events.state_dir` is reported by the start below.
  }
  for (const w of wslPathWarnings(
    [
      { label: 'repo', path: repoRoot },
      ...(stateDir ? [{ label: 'Tacet state directory', path: stateDir }] : []),
    ],
    io.wslProbe,
  )) {
    io.err(w);
  }
  const { startStandalone } = await import('@tacet/mini/standalone');
  const dropped = new Set<string>();
  const warned = new Set<string>();
  let sa: Standalone;
  // Problems the start itself records (the worktree reconcile, #254) come before the cursor below.
  const startedAt = new Date().toISOString();
  try {
    sa = await startStandalone({
      repoRoot,
      ...(o['user-dir'] ? { userDir: o['user-dir'] } : {}),
      ...(io.env ? { baseEnv: io.env } : {}),
      ...(io.home ? { home: io.home } : {}),
      ...(o.single ? { singleStep: true } : {}),
      // Names only, once per adapter: values never leave the environment.
      onEnvDropped: (id, names) => {
        if (dropped.has(id) || names.length === 0) return;
        dropped.add(id);
        io.err(
          `note: ${id} Workers do not get ${names.length} variable(s) of your environment (workers.env.pass adds names)`,
        );
      },
      // Once per message: every Worker start, of every adapter it applies to, would repeat it.
      onWarning: (id, m) => {
        if (warned.has(m)) return;
        warned.add(m);
        io.err(`warning: ${id}: ${terminalSafe(m)}`);
      },
      onError: (m) => io.err(`mcp: ${terminalSafe(m)}`),
      ...io.standalone,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    io.err(terminalSafe(message));
    if (
      message === 'config has no tiers.worker' &&
      !existsSync(join(repoRoot, '.tacet', 'tacet.yaml'))
    ) {
      io.err('this repo has no .tacet/tacet.yaml: run `tacet init` first');
    }
    return EXIT.failed;
  }

  try {
    for (const [id, text] of answers) {
      try {
        sa.mini.answer(id, text);
      } catch (err) {
        io.err(terminalSafe((err as Error).message));
        return EXIT.usage;
      }
    }
    // The Mini-conductor resumes every unfinished task when it starts, so this run follows,
    // asks for and waits on all of them, not only a new one.
    const unfinished = rootTasks(readState(sa.store))
      .filter((t) => !DONE_STATES.has(t.state))
      .map((t) => t.task.id);
    const roots: string[] = [];
    if (goal !== undefined) {
      roots.push(sa.mini.submit({ goal, acceptanceCriteria: o.accept ?? [] }));
      io.err(`task ${roots[0]} submitted`);
    } else if (unfinished.length === 0) {
      io.err('nothing to resume');
      return EXIT.done;
    }
    if (unfinished.length > 0) {
      roots.push(...unfinished);
      io.err(`${goal !== undefined ? 'also resuming' : 'resuming'} ${unfinished.join(', ')}`);
    }

    // Progress: what happens from now on, summary-grade, to stderr.
    let after = sa.store.query({}).at(-1)?.seq ?? 0;
    for (const e of sa.store.query({ typePrefix: 'maintenance' })) {
      if (e.seq <= after && e.envelope.ts >= startedAt) io.err(formatEvent(e.envelope));
    }
    const progress = () => {
      for (const e of sa.store.query({ afterSeq: after })) {
        after = e.seq;
        // The Mini-conductor's own upkeep failing (#254): about no task of the user's, or any.
        if (e.envelope.type.startsWith('maintenance.')) {
          io.err(formatEvent(e.envelope));
          continue;
        }
        const t = e.envelope.taskId;
        if (t === undefined || !roots.some((r) => isSubtaskOf(t, r))) continue;
        if (isSummaryEvent(e.envelope.type) && e.envelope.type !== 'agent.usage') {
          io.err(formatEvent(e.envelope));
        }
      }
    };

    for (;;) {
      // Short waits, so an interrupt is noticed and progress is shown while Workers run.
      for (;;) {
        if (io.signal?.aborted) {
          progress();
          io.err(
            'interrupted: open Worker sessions resume with `tacet run --resume`; `tacet cancel <task>` drops a task',
          );
          return EXIT.interrupted;
        }
        try {
          await sa.mini.settled(io.pollMs ?? 1000);
          break;
        } catch {
          progress();
        }
      }
      progress();
      const state = readState(sa.store);
      const open = roots.filter((r) => !DONE_STATES.has(state.tasks[r]?.state ?? ''));
      if (open.length === 0) return report(io, sa, roots, o.json);

      // In the background nobody is at a terminal, and an answer over the control port needs a
      // code only a terminal may show (#269): it stops as a run without a terminal does.
      const pending = open.flatMap((r) => pendingEscalations(state, r));
      if (pending.length > 0) {
        let answered = 0;
        if (io.prompt) io.err('answer each question, or press Enter to leave it for later');
        for (const x of io.prompt ? pending : []) {
          // Answered meanwhile over the run's control port (`tacet answer`, #201): not asked again.
          const now = readState(sa.store);
          if (!open.flatMap((r) => pendingEscalations(now, r)).some((y) => y.id === x.id)) continue;
          // The one-time code an answer from another terminal needs (#269): shown here only, on
          // the terminal this run asks on, never in its log or the event log.
          const code = sa.answerCodes.issue(x.id);
          const answer = await io.prompt?.(
            `${terminalSafe(`${x.taskId} asks: ${x.question}`)}\n(from another terminal: tacet answer ${terminalSafe(x.id)} <answer>, with code ${code})\n> `,
          );
          // End of input: nobody is there to ask.
          if (answer === undefined || io.signal?.aborted) break;
          if (answer.trim() === '') continue;
          try {
            sa.mini.answer(x.id, answer);
            sa.answerCodes.drop(x.id);
            answered += 1;
          } catch (err) {
            io.err(terminalSafe((err as Error).message));
          }
        }
        if (io.signal?.aborted) continue;
        if (answered > 0) continue;
        const left = readState(sa.store);
        const still = open.flatMap((r) => pendingEscalations(left, r));
        // Answered meanwhile, over the run's control port (`tacet answer`, #201): carry on.
        if (still.length === 0) continue;
        if (o.json) {
          const tasks = open.map((r) => ({ id: r, state: left.tasks[r]?.state }));
          io.out(safeJson({ tasks, escalations: still }));
        } else {
          for (const x of still) {
            io.out(terminalSafe(`escalation ${x.id} (${x.taskId}): ${x.question}`));
          }
        }
        io.err('waiting for answers: tacet run --resume --answer <escalation id>=<answer>');
        return EXIT.waiting;
      }
      const stuck = open.flatMap((r) =>
        [state.tasks[r], ...subtasksOf(state, r)].filter((t) => t?.state === 'auth_required'),
      );
      if (stuck.length > 0) {
        io.err(
          `credentials needed for ${stuck.map((t) => t?.task.id).join(', ')}: set the API key the adapter names, then tacet run --resume`,
        );
        return EXIT.failed;
      }
      for (const r of open) {
        const t = state.tasks[r];
        if (t) io.out(formatTask(t, subtasksOf(state, r)));
      }
      io.err('waiting on something only a person can do; see tacet status');
      return EXIT.waiting;
    }
  } finally {
    await sa.close();
  }
}

function report(io: Io, sa: Standalone, roots: string[], json?: boolean): number {
  const state = readState(sa.store);
  const results = roots.map((r) => ({
    id: r,
    state: state.tasks[r]?.state,
    result: sa.store
      .query({ taskId: r, typePrefix: 'task.result' })
      .map((e) => e.envelope.data as SummaryPacket)
      .at(-1),
  }));
  if (json) io.out(safeJson(results.length === 1 ? results[0] : results));
  else {
    for (const r of results) {
      const t = state.tasks[r.id];
      if (t) io.out(formatTask(t, subtasksOf(state, r.id)));
      if (r.result) io.out(terminalSafe(r.result.summary));
    }
  }
  return results.every((r) => r.state === 'completed') ? EXIT.done : EXIT.failed;
}
