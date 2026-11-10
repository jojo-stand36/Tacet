import type { Priority } from '@tacet/core';

/** Where a sub-task is, as far as scheduling is concerned. */
export type SubtaskPhase = 'pending' | 'running' | 'done' | 'failed' | 'blocked';

export interface SchedulableSubtask {
  id: string;
  dependsOn: readonly string[];
  phase: SubtaskPhase;
  /** Priority of the task it belongs to; higher priority tasks are scheduled first. */
  priority: Priority;
  /** Adapter the sub-task would run on. */
  adapter: string;
  /** Tie-breaker: lower first (plan order, then submission order). */
  order: number;
}

export interface CapacityLimits {
  /** Running Workers per repo, every adapter counted (Gas Town's `max_polecats`). */
  max: number;
  /** Further cap per adapter. */
  perAdapter?: Readonly<Record<string, number>>;
}

const RANK: Record<Priority, number> = { p0: 0, p1: 1, p2: 2, p3: 3 };

/**
 * The sub-tasks to start now. A sub-task is ready when it is pending and every sub-task it
 * depends on is done; ready ones go by priority, then order, as long as the repo-wide and
 * per-adapter capacity allow. `running` counts every running Worker, including ones this
 * scheduler did not start (capacity = max - active, as in Gas Town's scheduler). Pure: the same
 * input always gives the same answer.
 */
export function pickReady(
  subtasks: readonly SchedulableSubtask[],
  running: readonly { adapter: string }[],
  limits: CapacityLimits,
): string[] {
  const byId = new Map(subtasks.map((s) => [s.id, s]));
  const perAdapter = new Map<string, number>();
  for (const r of running) perAdapter.set(r.adapter, (perAdapter.get(r.adapter) ?? 0) + 1);
  let capacity = limits.max - running.length;
  const ready = subtasks
    .filter((s) => s.phase === 'pending' && s.dependsOn.every((d) => byId.get(d)?.phase === 'done'))
    .sort((a, b) => RANK[a.priority] - RANK[b.priority] || a.order - b.order);
  const picked: string[] = [];
  for (const s of ready) {
    if (capacity <= 0) break;
    const cap = limits.perAdapter?.[s.adapter];
    const used = perAdapter.get(s.adapter) ?? 0;
    if (cap !== undefined && used >= cap) continue;
    picked.push(s.id);
    perAdapter.set(s.adapter, used + 1);
    capacity -= 1;
  }
  return picked;
}

/**
 * Sub-tasks that can never run: something they depend on (directly or not) failed. They are
 * reported so the task can fail instead of waiting forever.
 */
export function blockedByFailure(subtasks: readonly SchedulableSubtask[]): string[] {
  const byId = new Map(subtasks.map((s) => [s.id, s]));
  const memo = new Map<string, boolean>();
  const doomed = (id: string, seen: Set<string>): boolean => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    const s = byId.get(id);
    if (!s || seen.has(id)) return false;
    seen.add(id);
    const result = s.phase === 'failed' || s.dependsOn.some((d) => doomed(d, seen));
    memo.set(id, result);
    return result;
  };
  return subtasks
    .filter((s) => s.phase === 'pending' && s.dependsOn.some((d) => doomed(d, new Set())))
    .map((s) => s.id);
}
