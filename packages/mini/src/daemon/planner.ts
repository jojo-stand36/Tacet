import { planIssues, type Task } from '@tacet/core';
import { z } from 'zod';
import type { Planner, PlanResult, ProposedSubtask, WorkerAdapter } from './ports.js';
import { PLANNER_SYSTEM_PROMPT, plannerPrompt } from './prompts.js';
import { sessionTurns } from './turns.js';

const Proposal = z.object({
  rationale: z.string().optional(),
  subtasks: z
    .array(
      z.object({
        key: z.string().min(1).max(64),
        goal: z.string().min(1),
        acceptanceCriteria: z.array(z.string().min(1)).min(1),
        kind: z.enum(['implement', 'review', 'explore']).optional(),
        dependsOn: z.array(z.string()).optional(),
      }),
    )
    .min(1)
    .max(20),
});

/** Parse a planner reply: JSON only, tolerating a code fence around it. */
export function parseProposal(text: string): {
  subtasks: ProposedSubtask[];
  rationale?: string;
} {
  const body = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error('the reply is not JSON');
  }
  const parsed = Proposal.safeParse(json);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  const issues = planIssues(
    parsed.data.subtasks.map((s) => ({ id: s.key, dependsOn: s.dependsOn })),
  );
  if (issues.length > 0) throw new Error(issues.join('; '));
  const { rationale, subtasks } = parsed.data;
  return {
    subtasks: subtasks.map((s) => ({
      key: s.key,
      goal: s.goal,
      acceptanceCriteria: s.acceptanceCriteria,
      ...(s.kind ? { kind: s.kind } : {}),
      ...(s.dependsOn ? { dependsOn: s.dependsOn } : {}),
    })),
    ...(rationale !== undefined ? { rationale } : {}),
  };
}

export interface AdapterPlannerOptions {
  /** The `mini` tier: adapter, model and effort for planning. */
  worker: WorkerAdapter;
  adapterId: string;
  model?: string;
  effort?: string;
  /** The repository to plan in; the planner reads it but must not change it. */
  cwd: string;
  /** Milliseconds to wait for one planner reply. Default 10 minutes. */
  timeoutMs?: number;
}

/**
 * Plans with one session on the `mini` tier. The session is read-only by instruction and every
 * approval request (a tool that would change something) is refused. An invalid reply is retried
 * once with the validation error.
 */
export class AdapterPlanner implements Planner {
  readonly #o: AdapterPlannerOptions;

  constructor(opts: AdapterPlannerOptions) {
    if (opts.worker.authRoute !== 'api_key') {
      throw new Error('the planner runs unattended and must use the api_key route (#65)');
    }
    this.#o = opts;
  }

  async plan(task: Task, opts: { signal?: AbortSignal } = {}): Promise<PlanResult> {
    const { adapter } = this.#o.worker;
    opts.signal?.throwIfAborted();
    const h = await adapter.start({
      cwd: this.#o.cwd,
      systemPrompt: PLANNER_SYSTEM_PROMPT,
      ...(this.#o.model !== undefined ? { model: this.#o.model } : {}),
      ...(this.#o.effort !== undefined ? { effort: this.#o.effort } : {}),
    });
    const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    const onAbort = () => void adapter.close(h).catch(() => {});
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const turns = sessionTurns(this.#o.worker, h, usage, {
        label: 'planner',
        refusal: 'The planner is read-only.',
        timeoutMs: this.#o.timeoutMs ?? 600_000,
      });
      let reply = await turns(plannerPrompt(task));
      let lastError: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return {
            ...parseProposal(reply),
            planner: {
              sessionId: h.id,
              adapter: this.#o.adapterId,
              ...(this.#o.model !== undefined ? { model: this.#o.model } : {}),
            },
            usage: {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              ...(usage.costUsd > 0 ? { costUsd: Math.round(usage.costUsd * 1e6) / 1e6 } : {}),
              ...(this.#o.model !== undefined ? { model: this.#o.model } : {}),
            },
          };
        } catch (err) {
          lastError = err;
          if (attempt === 0) {
            reply = await turns(
              `That reply was invalid (${(err as Error).message}). Reply again with the JSON only.`,
            );
          }
        }
      }
      throw new Error(`planner reply invalid: ${(lastError as Error).message}`);
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      await adapter.close(h).catch(() => {});
    }
  }
}

/** One sub-task with the task's own goal and criteria: for small tasks and tests. */
export class SingleStepPlanner implements Planner {
  async plan(task: Task): Promise<PlanResult> {
    return {
      subtasks: [{ key: 'all', goal: task.goal, acceptanceCriteria: [...task.acceptanceCriteria] }],
    };
  }
}
