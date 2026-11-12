import { type TacetConfig, tasksProjection } from '@tacet/core';
import type { EventStore } from '@tacet/core/node';
import type { AsideUsage } from '../daemon/daemon.js';
import type { EscalationGate } from '../mcp/backend.js';
import { effectiveAutonomy, findPrecedent, forUser, rootTasks } from './gate.js';
import { type ReasonRequest, type ReasonResult, reasoningCandidates } from './reasoning.js';

/** Runs a Mini-conductor session of its own for a task (`MiniConductor.aside`). */
export type Aside = <T>(
  taskId: string,
  label: string,
  fn: (ctx: {
    marker: string;
    signal: AbortSignal;
    charge: (usage: AsideUsage) => void;
  }) => Promise<T>,
) => Promise<T>;

export interface EscalationGateOptions {
  store: EventStore;
  /** The merged config: `escalation.autonomy` and `escalation.always_ask`. */
  config: TacetConfig;
  /** The repo id, so another repo's Decisions are never precedent. */
  repo?: string;
  /** The reasoning step on `tiers.mini`; without it the gate answers by exact precedent only. */
  reasoner?: { reason(req: ReasonRequest): Promise<ReasonResult> };
  /** How the reasoning session runs (process marker, usage charged); required with `reasoner`. */
  aside?: Aside;
  /** The time the reasoning session may take, for a task. */
  timeoutMs: (taskId: string) => number;
}

/** Below this share of its budget left, a task gets no reasoning step (ADR-004 B). */
const BUDGET_FLOOR = 0.1;

/**
 * The escalation gate (#25, ADR-004): the user's own exact precedent at every autonomy level;
 * then, at `medium` and `high` and only for urgency `low` or `normal`, the Mini-conductor's own
 * reasoning: at `medium` only with at least one candidate precedent, which its answer must cite;
 * at `high` also without one. `blocking` questions, approval requests and `always_ask` matches
 * always go to the user. Reasoning is skipped when the task has a budget and less than a tenth
 * of it is left. Its answers are recorded as `source: mini`, never precedent.
 */
export function escalationGate(o: EscalationGateOptions): EscalationGate {
  const alwaysAsk = o.config.escalation?.always_ask ?? [];
  return async (escalation, b, gateSignal) => {
    // The gate's time runs from here: the reasoning session gets what is left of it.
    const deadline = Date.now() + o.timeoutMs(b.taskId);
    await Promise.resolve();
    if (forUser(escalation, alwaysAsk)) return undefined;
    const p = findPrecedent(o.store, escalation, o.repo);
    if (p) {
      return {
        answer: p.answer,
        source: 'precedent',
        rationale: `The user answered the same question before (escalation ${p.escalationId}, decision ${p.decision.id}).`,
      };
    }
    if (!o.reasoner || !o.aside) return undefined;
    if (escalation.urgency !== 'low' && escalation.urgency !== 'normal') return undefined;
    const autonomy = effectiveAutonomy(o.store, o.config, b.taskId);
    if (autonomy === 'low') return undefined;
    const candidates = reasoningCandidates(o.store, escalation, o.repo);
    if (autonomy === 'medium' && candidates.length === 0) return undefined;
    // Budgets are the root task's (the user's), and its sub-tasks spend them.
    const rootOf = rootTasks(o.store);
    const root = rootOf(b.taskId);
    const tasks = o.store.replay(tasksProjection).tasks;
    const rootView = tasks[root];
    const view = tasks[b.taskId];
    if (!rootView || !view) return undefined;
    const budget = rootView.task.budget?.usd;
    if (budget !== undefined) {
      let spent = 0;
      for (const [id, t] of Object.entries(tasks)) {
        if (rootOf(id) === root) spent += t.usage.costUsd;
      }
      if (budget - spent < budget * BUDGET_FLOOR) return undefined;
    }
    const reasoner = o.reasoner;
    const verdict = await o.aside(b.taskId, 'gate', async ({ marker, signal, charge }) => {
      const r = await reasoner.reason({
        goal: rootView.task.goal,
        ...(b.taskId !== root ? { subtaskGoal: view.task.goal } : {}),
        escalation,
        candidates,
        alwaysAsk,
        mayAnswerWithoutPrecedent: autonomy === 'high',
        marker,
        signal: gateSignal ? AbortSignal.any([signal, gateSignal]) : signal,
        timeoutMs: Math.max(1, deadline - Date.now()),
      });
      charge(r.usage);
      return r.verdict;
    });
    if (verdict.verdict !== 'answer') return undefined;
    const cited = verdict.cites.length > 0 ? ` (cites ${verdict.cites.join(', ')})` : '';
    return {
      answer: verdict.answer,
      source: 'mini',
      rationale: `${verdict.rationale || "The Mini-conductor's own judgement."}${cited}`,
    };
  };
}
