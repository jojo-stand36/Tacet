import type { SummaryPacket } from '@tacet/core';
import type { Standalone } from '@tacet/mini/standalone';
import type { Io } from '../io.js';
import { formatEvent, formatTask, isSummaryEvent, terminalSafe } from '../render.js';
import {
  DONE_STATES,
  isSubtaskOf,
  pendingEscalations,
  readState,
  repoRootFrom,
  rootTasks,
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
}

/** Exit codes of `tacet run`. */
export const EXIT = { done: 0, failed: 1, usage: 2, waiting: 3, interrupted: 130 } as const;

/**
 * `tacet run "<task>"` (#21): host a standalone Mini-conductor in this process until the task is
 * done. On a terminal it asks the user each open escalation; without one it stops with exit code
 * 3 and the escalation ids, for `tacet run --resume --answer <id>=<text>`. Interrupted (SIGINT),
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
  const { startStandalone } = await import('@tacet/mini/standalone');
  const dropped = new Set<string>();
  let sa: Standalone;
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
      onError: (m) => io.err(`mcp: ${terminalSafe(m)}`),
      ...io.standalone,
    });
  } catch (err) {
    io.err(terminalSafe(err instanceof Error ? err.message : String(err)));
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
    let roots: string[];
    if (goal !== undefined) {
      roots = [sa.mini.submit({ goal, acceptanceCriteria: o.accept ?? [] })];
      io.err(`task ${roots[0]} submitted`);
    } else {
      roots = rootTasks(readState(sa.store))
        .filter((t) => !DONE_STATES.has(t.state))
        .map((t) => t.task.id);
      if (roots.length === 0) {
        io.err('nothing to resume');
        return EXIT.done;
      }
      io.err(`resuming ${roots.join(', ')}`);
    }

    // Progress: what happens from now on, summary-grade, to stderr.
    let after = sa.store.query({}).at(-1)?.seq ?? 0;
    const progress = () => {
      for (const e of sa.store.query({ afterSeq: after })) {
        after = e.seq;
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
          io.err('interrupted: open Worker sessions resume with `tacet run --resume`');
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

      const pending = open.flatMap((r) => pendingEscalations(state, r));
      if (pending.length > 0) {
        let asked = false;
        for (const x of io.prompt ? pending : []) {
          const answer = await io.prompt?.(terminalSafe(`${x.taskId} asks: ${x.question}\n> `));
          // End of input: nobody is there to ask.
          if (answer === undefined || io.signal?.aborted) break;
          asked = true;
          if (answer.trim() === '') continue;
          try {
            sa.mini.answer(x.id, answer);
          } catch (err) {
            io.err(terminalSafe((err as Error).message));
          }
        }
        if (!asked) {
          for (const x of pending) {
            io.out(terminalSafe(`escalation ${x.id} (${x.taskId}): ${x.question}`));
          }
          io.err('waiting for answers: tacet run --resume --answer <escalation id>=<answer>');
          return EXIT.waiting;
        }
        continue;
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
  if (json) io.out(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
  else {
    for (const r of results) {
      const t = state.tasks[r.id];
      if (t) io.out(formatTask(t, subtasksOf(state, r.id)));
      if (r.result) io.out(terminalSafe(r.result.summary));
    }
  }
  return results.every((r) => r.state === 'completed') ? EXIT.done : EXIT.failed;
}
