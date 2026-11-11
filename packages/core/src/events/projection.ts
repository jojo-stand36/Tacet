import { z } from 'zod';
import { Usage } from '../schema/agent-event.js';
import { Id, openEnum, Ulid } from '../schema/common.js';
import { Decision } from '../schema/decision.js';
import type { EventEnvelope } from '../schema/envelope.js';
import { Escalation } from '../schema/escalation.js';
import { TaskPlan } from '../schema/plan.js';
import {
  RegistryConnected,
  RegistryDisconnected,
  RegistryRepoAdded,
  RegistryRepoRemoved,
} from '../schema/registry.js';
import { type SummaryOutcome, SummaryPacket } from '../schema/summary.js';
import { Task } from '../schema/task.js';
import { WorkerEnded, WorkerStarted } from '../schema/worker.js';
import { WorkspaceCreated, WorkspaceRemoved } from '../schema/workspace.js';

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
  'task.planned': TaskPlan,
  'task.result': SummaryPacket,
  'escalation.raised': Escalation,
  'escalation.resolved': z.object({
    escalationId: Ulid,
    decisionId: Ulid.optional(),
    answer: z.string().optional(),
  }),
  'decision.recorded': Decision,
  'handoff.accepted': z.object({ handoffId: Ulid, sessionId: Id }),
  'worker.started': WorkerStarted,
  'worker.ended': WorkerEnded,
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
  /** Sub-task ids and their dependencies, from the latest `task.planned`. */
  plan?: { id: string; dependsOn: string[] }[];
  /** Outcome of the latest `task.result`. */
  result?: { outcome: SummaryOutcome; createdAt: string };
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
      case 'task.planned':
        next.plan = (data as TaskPlan).subtasks.map((st) => ({
          id: st.id,
          dependsOn: [...st.dependsOn],
        }));
        break;
      case 'task.result': {
        const r = data as SummaryPacket;
        if (r.taskId !== taskId) return { ...state, skipped: [...state.skipped, e.id] };
        next.result = { outcome: r.outcome, createdAt: r.createdAt };
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

/** A workspace in the Mini-conductor's worktree registry (#126). */
export interface WorkspaceView {
  workspaceId: string;
  workerId: string;
  baseCommit: string;
  baseBranch?: string;
  /** When `workspace.created` was recorded (the envelope's `ts`). */
  createdAt: string;
  migrated?: true;
  /** A throwaway checkout (#238): force-removed at the next start. */
  scratch?: true;
}

export interface WorkspacesState {
  /** Workspaces created and not removed, by id, in creation order. */
  live: Record<string, WorkspaceView>;
  /** Ids removed, so a late duplicate `created` does not bring one back. */
  removed: Record<string, true>;
}

/**
 * The worktree registry from `workspace.*` events (#126). Malformed payloads and unknown types
 * are skipped. An id once removed stays removed.
 */
export const workspacesProjection: Projection<WorkspacesState> = {
  name: 'workspaces',
  initial: () => ({ live: {}, removed: {} }),
  apply(state, e) {
    if (e.type === 'workspace.created') {
      const d = WorkspaceCreated.safeParse(e.data);
      if (!d.success) return state;
      const id = d.data.workspaceId;
      if (state.removed[id] || state.live[id]) return state;
      const view: WorkspaceView = {
        workspaceId: id,
        workerId: d.data.workerId,
        baseCommit: d.data.baseCommit,
        ...(d.data.baseBranch !== undefined ? { baseBranch: d.data.baseBranch } : {}),
        createdAt: e.ts,
        ...(d.data.migrated ? { migrated: true as const } : {}),
        ...(d.data.scratch ? { scratch: true as const } : {}),
      };
      return { ...state, live: { ...state.live, [id]: view } };
    }
    if (e.type === 'workspace.removed') {
      const d = WorkspaceRemoved.safeParse(e.data);
      if (!d.success) return state;
      const { [d.data.workspaceId]: _gone, ...live } = state.live;
      return { live, removed: { ...state.removed, [d.data.workspaceId]: true } };
    }
    return state;
  },
};

/** A repo in the Conductor's registry (#23). */
export interface RegisteredRepo {
  repoId: string;
  repoPath: string;
  /** When `registry.repo_added` was recorded. */
  addedAt: string;
  /**
   * The id of that `registry.repo_added` envelope: this registration, told apart from an earlier
   * one of the same repo even when the user removes and adds it again in quick succession (#24).
   */
  registration: string;
}

/** A Mini-conductor connected to the Conductor (#23), registered or not. */
export interface ConnectedMini {
  repoId: string;
  repoPath: string;
  sessionId: string;
  miniVersion: string;
  adapters: string[];
  /** When `registry.connected` was recorded. */
  since: string;
}

export interface RegistryState {
  /** Repos the user registered, by repo id. */
  repos: Record<string, RegisteredRepo>;
  /** Live connections as the log last recorded them, by repo id. */
  connected: Record<string, ConnectedMini>;
}

/**
 * The Conductor's registry from `registry.*` events (#23). A `disconnected` ends only the session
 * it names, so a late one for a connection already replaced leaves the new one. Malformed payloads
 * and unknown types are skipped. A repo removed and added again is registered again.
 */
export const registryProjection: Projection<RegistryState> = {
  name: 'registry',
  initial: () => ({ repos: {}, connected: {} }),
  apply(state, e) {
    switch (e.type) {
      case 'registry.repo_added': {
        const d = RegistryRepoAdded.safeParse(e.data);
        if (!d.success) return state;
        const repo = {
          repoId: d.data.repoId,
          repoPath: d.data.repoPath,
          addedAt: e.ts,
          registration: e.id,
        };
        return { ...state, repos: { ...state.repos, [d.data.repoId]: repo } };
      }
      case 'registry.repo_removed': {
        const d = RegistryRepoRemoved.safeParse(e.data);
        if (!d.success) return state;
        const { [d.data.repoId]: _gone, ...repos } = state.repos;
        return { ...state, repos };
      }
      case 'registry.connected': {
        const d = RegistryConnected.safeParse(e.data);
        if (!d.success) return state;
        const mini = { ...d.data, since: e.ts };
        return { ...state, connected: { ...state.connected, [d.data.repoId]: mini } };
      }
      case 'registry.disconnected': {
        const d = RegistryDisconnected.safeParse(e.data);
        if (!d.success || state.connected[d.data.repoId]?.sessionId !== d.data.sessionId) {
          return state;
        }
        const { [d.data.repoId]: _gone, ...connected } = state.connected;
        return { ...state, connected };
      }
      default:
        return state;
    }
  },
};
