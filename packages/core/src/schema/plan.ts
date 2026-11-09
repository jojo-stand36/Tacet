import { z } from 'zod';
import { Id, openEnum } from './common.js';

/**
 * What a sub-task asks its Worker to do (Polly's dispatch purposes, ADR-001). Unknown values fall
 * back to `implement`.
 */
export const SubtaskKind = openEnum(['implement', 'review', 'explore'], 'implement');
export type SubtaskKind = z.infer<typeof SubtaskKind>;

/**
 * One sub-task in a Mini-conductor plan. It is also stored as its own `task.created` with
 * `parentId` set to the planned task; `dependsOn` lives here, not on `Task`, because ADR-003 §4
 * maps `Task.parentId` to A2A `referenceTaskIds` and keeps sub-tasks internal to the Mini.
 */
export const PlannedSubtask = z.object({
  id: Id.describe('Task id of the sub-task'),
  goal: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)),
  kind: SubtaskKind.default('implement'),
  dependsOn: z
    .array(Id)
    .default([])
    .describe('Ids of sub-tasks in the same plan that must complete first'),
});
export type PlannedSubtask = z.infer<typeof PlannedSubtask>;

/**
 * Payload of `task.planned` (envelope `taskId` = the planned task): how the Mini-conductor split
 * a task into sub-tasks. Ids are unique, dependencies name sub-tasks of the same plan, and the
 * dependency graph has no cycles.
 */
export const TaskPlan = z
  .object({
    subtasks: z.array(PlannedSubtask).min(1),
    planner: z
      .object({
        sessionId: Id.optional(),
        adapter: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
      })
      .optional()
      .describe('The planner session, for audit'),
    rationale: z.string().optional(),
  })
  .superRefine((plan, ctx) => {
    for (const issue of planIssues(plan.subtasks)) ctx.addIssue({ code: 'custom', message: issue });
  });
export type TaskPlan = z.infer<typeof TaskPlan>;

/** Structural problems in a plan: duplicate ids, unknown or self dependencies, cycles. */
export function planIssues(
  subtasks: readonly { id: string; dependsOn?: readonly string[] }[],
): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const s of subtasks) {
    if (ids.has(s.id)) issues.push(`duplicate sub-task id ${s.id}`);
    ids.add(s.id);
  }
  for (const s of subtasks) {
    for (const d of s.dependsOn ?? []) {
      if (d === s.id) issues.push(`sub-task ${s.id} depends on itself`);
      else if (!ids.has(d)) issues.push(`sub-task ${s.id} depends on unknown ${d}`);
    }
  }
  if (issues.length > 0) return issues;
  // Kahn's algorithm: whatever cannot be ordered is on a cycle.
  const indegree = new Map(subtasks.map((s) => [s.id, (s.dependsOn ?? []).length]));
  const ready = subtasks.filter((s) => (s.dependsOn ?? []).length === 0).map((s) => s.id);
  let ordered = 0;
  while (ready.length > 0) {
    const id = ready.pop() as string;
    ordered += 1;
    for (const s of subtasks) {
      if ((s.dependsOn ?? []).includes(id)) {
        const n = (indegree.get(s.id) ?? 0) - 1;
        indegree.set(s.id, n);
        if (n === 0) ready.push(s.id);
      }
    }
  }
  if (ordered < subtasks.length) {
    const stuck = [...indegree].filter(([, n]) => n > 0).map(([id]) => id);
    issues.push(`dependency cycle among ${stuck.join(', ')}`);
  }
  return issues;
}
