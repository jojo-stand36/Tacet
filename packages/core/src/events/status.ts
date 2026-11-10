import type { A2ATask, A2ATaskState } from '../schema/a2a.js';
import { STATUS_EXT_URI, type StatusExt } from '../schema/status-ext.js';
import type { TaskTarget } from '../schema/task.js';
import type { TaskState, TasksState, TaskView } from './projection.js';

/** Task states a task never leaves. */
export const DONE_STATES: ReadonlySet<string> = new Set<TaskState>([
  'completed',
  'failed',
  'canceled',
  'rejected',
]);

export const isSubtaskOf = (id: string, root: string) => id === root || id.startsWith(`${root}/`);

/** Tasks the user created (not sub-tasks), oldest first. */
export function rootTasks(state: TasksState): TaskView[] {
  return Object.values(state.tasks)
    .filter((t) => t.task.parentId === undefined && !t.task.id.includes('/'))
    .sort((a, b) => a.task.createdAt.localeCompare(b.task.createdAt));
}

/** A task's sub-tasks in id order (numeric parts as numbers). */
export function subtasksOf(state: TasksState, root: string): TaskView[] {
  return Object.values(state.tasks)
    .filter((t) => t.task.id.startsWith(`${root}/`))
    .sort((a, b) => a.task.id.localeCompare(b.task.id, undefined, { numeric: true }));
}

/**
 * Open escalations of a task and its sub-tasks: id, the task it is on, the question. Those of a
 * sub-task or task that has ended (canceled, failed, completed) are left out: an answer to them
 * would never reach a Worker, so nobody waits on it (#202).
 */
export function pendingEscalations(state: TasksState, root: string) {
  return Object.values(state.tasks)
    .filter((t) => isSubtaskOf(t.task.id, root) && !DONE_STATES.has(t.state))
    .flatMap((t) =>
      Object.entries(t.escalations)
        .filter(([, x]) => x.status === 'pending')
        .map(([id, x]) => ({ id, taskId: t.task.id, question: x.question })),
    );
}

/** One task as `tacet status` shows it: the status extension with the task's id (#201). */
export type TaskStatusEntry = StatusExt & { id: string };

/**
 * Every task the user created, with its sub-tasks, open escalations and usage: what `tacet status`
 * shows, built the same way from the log or by a running Mini-conductor. `targetOf` gives the
 * task's recorded target (#219), if any.
 */
export function statusEntries(
  state: TasksState,
  targetOf: (taskId: string) => TaskTarget | undefined,
): TaskStatusEntry[] {
  return rootTasks(state).map((t) => {
    const target = targetOf(t.task.id);
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
}

const A2A_STATES: Record<TaskState, A2ATaskState> = {
  submitted: 'TASK_STATE_SUBMITTED',
  working: 'TASK_STATE_WORKING',
  input_required: 'TASK_STATE_INPUT_REQUIRED',
  auth_required: 'TASK_STATE_AUTH_REQUIRED',
  completed: 'TASK_STATE_COMPLETED',
  failed: 'TASK_STATE_FAILED',
  canceled: 'TASK_STATE_CANCELED',
  rejected: 'TASK_STATE_REJECTED',
};

/** A Tacet task state as the A2A `TaskState` it maps to (ADR-003 §4). */
export const toA2AState = (s: TaskState): A2ATaskState => A2A_STATES[s];

/**
 * A status entry as an A2A `Task` (ADR-003 §4): the goal as the first user message, the state,
 * and the rest in the status extension. `contextId` is the Mini-conductor's: a standalone task has
 * no cross-repo context.
 */
export function toA2ATask(
  entry: TaskStatusEntry,
  contextId: string,
  historyLength?: number,
): A2ATask {
  const { id, ...ext } = entry;
  const history = [
    {
      messageId: `${id}:goal`,
      contextId,
      taskId: id,
      role: 'ROLE_USER' as const,
      parts: [{ text: entry.goal }],
    },
  ];
  return {
    id,
    contextId,
    status: { state: toA2AState(entry.state) },
    ...(historyLength === 0 ? {} : { history }),
    metadata: { [STATUS_EXT_URI]: ext },
  };
}
