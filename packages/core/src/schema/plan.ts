import { z } from 'zod';
import { Id, openEnum } from './common.js';

/**
 * What a sub-task asks its Worker to do (Polly's dispatch purposes, ADR-001). Unknown values fall
 * back to `explore`, the read-only kind: a kind this version does not know never gets write
 * access by default.
 */
export const SubtaskKind = openEnum(['implement', 'review', 'explore'], 'explore');
export type SubtaskKind = z.infer<typeof SubtaskKind>;

/**
 * One sub-task in a Mini-conductor plan. It is also stored as its own `task.created` with
 * `parentId` set to the planned task; that `task.created` is authoritative for the sub-task's
 * goal and criteria, the copy here is what the planner proposed. `dependsOn` lives here, not on
 * `Task`, because ADR-003 §4 maps `Task.parentId` to A2A `referenceTaskIds` and keeps sub-tasks
 * internal to the Mini.
 */
export const PlannedSubtask = z.object({
  id: Id.describe('Task id of the sub-task'),
  goal: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)),
  kind: SubtaskKind.default('implement'),
  dependsOn: z
    .array(Id)
    .default([])
    .describe('Ids of sub-tasks in the same plan that must complete first')
    .meta({ uniqueItems: true }),
});
export type PlannedSubtask = z.infer<typeof PlannedSubtask>;

const INVARIANTS = [
  'sub-task ids are unique',
  'dependsOn names only sub-tasks of the same plan, never the sub-task itself, and has no duplicates',
  'the dependency graph has no cycles',
  'each task.planned is the full current plan: a replan lists every sub-task again, completed ones included',
];

/**
 * Payload of `task.planned` (envelope `taskId` = the planned task): how the Mini-conductor split
 * a task into sub-tasks. Each `task.planned` is the full current plan; a later one replaces it
 * and lists completed sub-tasks again. The invariants are enforced here and listed in the JSON
 * Schema as `x-tacet-invariants`, since JSON Schema cannot express them.
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
  })
  .meta({
    description: `A task's plan. Invariants (checked by Tacet, not by this schema): ${INVARIANTS.join('; ')}.`,
    'x-tacet-invariants': INVARIANTS,
  });
export type TaskPlan = z.infer<typeof TaskPlan>;

/**
 * Structural problems in a plan: duplicate ids, duplicate, unknown or self dependencies, and
 * sub-tasks that cannot be ordered because of a dependency cycle.
 */
export function planIssues(
  subtasks: readonly { id: string; dependsOn?: readonly string[] | undefined }[],
): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const s of subtasks) {
    if (ids.has(s.id)) issues.push(`duplicate sub-task id ${s.id}`);
    ids.add(s.id);
  }
  for (const s of subtasks) {
    const seen = new Set<string>();
    for (const d of s.dependsOn ?? []) {
      if (seen.has(d)) issues.push(`sub-task ${s.id} lists dependency ${d} twice`);
      seen.add(d);
      if (d === s.id) issues.push(`sub-task ${s.id} depends on itself`);
      else if (!ids.has(d)) issues.push(`sub-task ${s.id} depends on unknown ${d}`);
    }
  }
  if (issues.length > 0) return issues;
  // Kahn's algorithm: whatever cannot be ordered is on a cycle or behind one.
  const deps = new Map(subtasks.map((s) => [s.id, new Set(s.dependsOn ?? [])]));
  const indegree = new Map([...deps].map(([id, d]) => [id, d.size]));
  const ready = [...indegree].filter(([, n]) => n === 0).map(([id]) => id);
  let ordered = 0;
  while (ready.length > 0) {
    const id = ready.pop() as string;
    ordered += 1;
    for (const [other, d] of deps) {
      if (d.has(id)) {
        const n = (indegree.get(other) ?? 0) - 1;
        indegree.set(other, n);
        if (n === 0) ready.push(other);
      }
    }
  }
  if (ordered < subtasks.length) {
    const stuck = [...indegree].filter(([, n]) => n > 0).map(([id]) => id);
    issues.push(`sub-tasks cannot be ordered (dependency cycle): ${stuck.join(', ')}`);
  }
  return issues;
}
