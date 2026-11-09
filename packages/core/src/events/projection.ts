import { z } from 'zod';
import { Usage } from '../schema/agent-event.js';
import { Id, openEnum, Ulid } from '../schema/common.js';
import { Decision } from '../schema/decision.js';
import type { EventEnvelope } from '../schema/envelope.js';
import { Escalation } from '../schema/escalation.js';
import { Task } from '../schema/task.js';

/**
 * A pure fold over event envelopes. `apply` must not read the clock, randomness or anything
 * outside its arguments, so replaying the same events always gives the same state.
 */
export interface Projection<S> {
  readonly name: string;
  initial(): S;
  apply(state: S, event: EventEnvelope): S;
}

/** Fold `events` (in log order) into a fresh projection state. */
export function project<S>(projection: Projection<S>, events: Iterable<EventEnvelope>): S {
  let state = projection.initial();
  for (const e of events) state = projection.apply(state, e);
  return state;
}

/** Task lifecycle, mirroring A2A TaskState (ADR-003 §4). Unknown values read as `working`. */
export const TaskState = openEnum(
  [
    'submitted',
    'working',
    'input_required',
    'auth_required',
    'completed',
    'failed',
    'canceled',
    'rejected',
  ],
  'working',
);
export type TaskState = z.infer<typeof TaskState>;

/** Payloads of the task-scoped event types the task projection understands. */
export const TaskEventData = {
  'task.created': Task,
  'task.status': z.object({ state: TaskState, message: z.string().optional() }),
  'escalation.raised': Escalation,
  'escalation.resolved': z.object({
    escalationId: Ulid,
    decisionId: Ulid.optional(),
    answer: z.string().optional(),
  }),
  'decision.recorded': Decision,
  'handoff.accepted': z.object({ handoffId: Ulid, sessionId: Id }),
  'worker.started': z.object({ sessionId: Id }),
  'worker.ended': z.object({ sessionId: Id }),
  'agent.usage': Usage,
} as const;

export interface TaskView {
  task: Task;
  state: TaskState;
  escalations: Record<
    string,
    { question: string; status: 'pending' | 'resolved'; decisionId?: string }
  >;
  decisions: string[];
  handoffs: string[];
  activeWorkers: string[];
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  /** Id of the last event applied to this task. */
  lastEventId: string;
}

export interface TasksState {
  tasks: Record<string, TaskView>;
  /** Events of a known type whose payload did not validate, or that named an unknown task. */
  skipped: string[];
}

const KNOWN = new Set(Object.keys(TaskEventData));

/**
 * Current state of every task, rebuilt from the event log. Events are matched to tasks by the
 * envelope's `taskId`. Unknown event types are ignored (ADR-003 §2). The projection only reads
 * summary-grade events, so it still rebuilds exactly after retention drops transcript events.
 */
export const tasksProjection: Projection<TasksState> = {
  name: 'tasks',
  initial: () => ({ tasks: {}, skipped: [] }),
  apply(state, e) {
    if (!KNOWN.has(e.type)) return state;
    const schema = TaskEventData[e.type as keyof typeof TaskEventData];
    const parsed = schema.safeParse(e.data);
    const taskId = e.taskId;
    if (!parsed.success || taskId === undefined) {
      return { ...state, skipped: [...state.skipped, e.id] };
    }
    // Each case below narrows `data` to the schema of its own event type.
    const data: unknown = parsed.data;
    if (e.type === 'task.created') {
      const task = data as Task;
      if (task.id !== taskId) return { ...state, skipped: [...state.skipped, e.id] };
      const view: TaskView = {
        task,
        state: 'submitted',
        escalations: {},
        decisions: [],
        handoffs: [],
        activeWorkers: [],
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        lastEventId: e.id,
      };
      return { ...state, tasks: { ...state.tasks, [taskId]: view } };
    }
    const prev = state.tasks[taskId];
    if (!prev) return { ...state, skipped: [...state.skipped, e.id] };
    const next: TaskView = { ...prev, lastEventId: e.id };
    switch (e.type) {
      case 'task.status':
        next.state = (data as { state: TaskState }).state;
        break;
      case 'escalation.raised': {
        const esc = data as Escalation;
        next.escalations = {
          ...prev.escalations,
          [esc.id]: { question: esc.question, status: 'pending' },
        };
        break;
      }
      case 'escalation.resolved': {
        const r = data as { escalationId: string; decisionId?: string };
        const esc = prev.escalations[r.escalationId];
        if (!esc) return { ...state, skipped: [...state.skipped, e.id] };
        next.escalations = {
          ...prev.escalations,
          [r.escalationId]: {
            ...esc,
            status: 'resolved',
            ...(r.decisionId !== undefined ? { decisionId: r.decisionId } : {}),
          },
        };
        break;
      }
      case 'decision.recorded':
        next.decisions = [...prev.decisions, (data as Decision).id];
        break;
      case 'handoff.accepted':
        next.handoffs = [...prev.handoffs, (data as { handoffId: string }).handoffId];
        break;
      case 'worker.started': {
        const id = (data as { sessionId: string }).sessionId;
        if (!prev.activeWorkers.includes(id)) next.activeWorkers = [...prev.activeWorkers, id];
        break;
      }
      case 'worker.ended': {
        const id = (data as { sessionId: string }).sessionId;
        next.activeWorkers = prev.activeWorkers.filter((w) => w !== id);
        break;
      }
      case 'agent.usage': {
        const u = data as z.infer<typeof Usage>;
        next.usage = {
          inputTokens: prev.usage.inputTokens + u.inputTokens,
          outputTokens: prev.usage.outputTokens + u.outputTokens,
          // Round to micro-dollars so float addition order cannot change the result.
          costUsd: Math.round((prev.usage.costUsd + (u.costUsd ?? 0)) * 1e6) / 1e6,
        };
        break;
      }
    }
    return { ...state, tasks: { ...state.tasks, [taskId]: next } };
  },
};
