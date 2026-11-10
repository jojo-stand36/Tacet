import { z } from 'zod';
import { TaskState } from '../events/projection.js';
import { Id } from './common.js';
import { SummaryOutcome } from './summary.js';
import { TaskTarget } from './task.js';

const Tokens = z.number().int().min(0);
const TaskUsage = z.object({
  inputTokens: Tokens,
  outputTokens: Tokens,
  costUsd: z.number().min(0),
});

/**
 * A Tacet task's state beyond what an A2A `Task` carries (#201): its sub-tasks, active Workers,
 * usage and open escalations, which stay internal to a Mini-conductor in v0 (ADR-003 §4). Sent in
 * `Task.metadata["urn:tacet:a2a-ext:status:v1"]` by `GetTask` and `ListTasks`; the same shape is
 * each task of `tacet status --json` (with the task's `id`).
 */
export const StatusExt = z.object({
  goal: z.string().min(1),
  state: TaskState,
  outcome: SummaryOutcome.optional(),
  target: TaskTarget.optional(),
  usage: TaskUsage.describe('Spent on the task itself: the planner'),
  subtasks: z.array(
    z.object({
      id: Id,
      goal: z.string().min(1),
      state: TaskState,
      activeWorkers: z.array(Id).describe('Worker session ids running now'),
      usage: TaskUsage,
    }),
  ),
  escalations: z
    .array(z.object({ id: Id, taskId: Id, question: z.string() }))
    .describe('Open escalations of the task and its unfinished sub-tasks'),
});
export type StatusExt = z.infer<typeof StatusExt>;

export const STATUS_EXT_URI = 'urn:tacet:a2a-ext:status:v1';
