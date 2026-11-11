import {
  A2A_ERRORS,
  A2ACancelTaskRequest,
  A2AGetTaskRequest,
  A2AListTasksRequest,
  A2ASendMessageRequest,
  DECISION_EXT_URI,
  DecisionExt,
  DONE_STATES,
  statusEntries,
  type TasksState,
  TaskTarget,
  tasksProjection,
  toA2AState,
  toA2ATask,
} from '@tacet/core';
import {
  type EventStore,
  RpcError,
  type RpcServer,
  type Secret,
  startRpcServer,
} from '@tacet/core/node';
import type { z } from 'zod';
import type { MiniConductor } from '../daemon/daemon.js';
import type { AnswerCodes } from './answer-codes.js';

export interface MiniControlOptions {
  mini: Pick<MiniConductor, 'answer' | 'cancel'>;
  store: EventStore;
  /** The A2A `contextId` of every task: the repo's id (a standalone task has no wider context). */
  contextId: string;
  token: Secret;
  /**
   * The one-time codes an answer must carry (#269): the token alone, which code a Worker wrote
   * can read, does not answer an Escalation.
   */
  answerCodes: AnswerCodes;
  serverInfo?: { name: string; version: string };
  onError?: (message: string) => void;
}

const PAGE_SIZE = 50;

/** Params parsed against `schema`, or `-32602` without echoing them. */
function params<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value ?? {});
  if (!parsed.success) throw new RpcError(-32602, 'invalid params');
  return parsed.data;
}

/**
 * The standalone Mini-conductor's control port (#201, ADR-003 §4): the A2A methods a Conductor
 * would call, served to the CLI over Tacet JSON-RPC (`startRpcServer`). `ListTasks` and `GetTask`
 * answer from the log as the running Mini-conductor sees it, with the status extension; `CancelTask`
 * and `SendMessage` (an answer to an open escalation, with the decision extension and its one-time
 * answer code, #269) act through the
 * Mini-conductor itself, so the log keeps one writer. Sub-tasks are not A2A tasks (ADR-003 §4);
 * new tasks over the port are not offered yet (`-32004`).
 */
export async function startMiniControl(o: MiniControlOptions): Promise<RpcServer> {
  let cached: { count: number; state: TasksState } | undefined;
  const state = (): TasksState => {
    const count = o.store.count();
    if (cached?.count !== count) cached = { count, state: o.store.replay(tasksProjection) };
    return cached.state;
  };
  const targetOf = (taskId: string) => {
    const data = o.store.query({ taskId, typePrefix: 'task.target' }).at(-1)?.envelope.data;
    const parsed = TaskTarget.safeParse(data);
    return parsed.success ? parsed.data : undefined;
  };
  const entries = () => statusEntries(state(), targetOf);
  const entry = (id: string) => {
    const e = entries().find((x) => x.id === id);
    if (!e) throw new RpcError(A2A_ERRORS.taskNotFound, `no task ${id}`);
    return e;
  };

  return startRpcServer({
    token: o.token,
    // The CLI only: a Mini-conductor dials the Conductor, never another Mini-conductor.
    roles: ['cli'],
    serverInfo: o.serverInfo ?? { name: 'tacet-mini', version: '0.0.0' },
    ...(o.onError ? { onError: o.onError } : {}),
    handlers: {
      ListTasks: (p) => {
        const req = params(A2AListTasksRequest, p);
        // Every task here shares the one context.
        const inContext = !req.contextId || req.contextId === o.contextId;
        const all = entries().filter(
          (e) => inContext && (!req.status || toA2AState(e.state) === req.status),
        );
        const size = req.pageSize ?? PAGE_SIZE;
        const start = req.pageToken ? Number.parseInt(req.pageToken, 10) : 0;
        if (!Number.isInteger(start) || start < 0 || String(start) !== (req.pageToken ?? '0')) {
          throw new RpcError(-32602, 'invalid page token');
        }
        const page = all.slice(start, start + size);
        return {
          tasks: page.map((e) => toA2ATask(e, o.contextId, req.historyLength)),
          ...(start + size < all.length ? { nextPageToken: String(start + size) } : {}),
          pageSize: size,
          totalSize: all.length,
        };
      },
      GetTask: (p) => {
        const req = params(A2AGetTaskRequest, p);
        return toA2ATask(entry(req.id), o.contextId, req.historyLength);
      },
      CancelTask: async (p) => {
        const req = params(A2ACancelTaskRequest, p);
        if (DONE_STATES.has(entry(req.id).state)) {
          throw new RpcError(A2A_ERRORS.taskNotCancelable, `task ${req.id} has already ended`);
        }
        try {
          await o.mini.cancel(req.id);
        } catch (err) {
          // Ended meanwhile, or another reason the Mini-conductor gives: its message names ids only.
          throw new RpcError(A2A_ERRORS.taskNotCancelable, (err as Error).message);
        }
        return toA2ATask(entry(req.id), o.contextId);
      },
      SendMessage: (p) => {
        const { message } = params(A2ASendMessageRequest, p);
        if (!message.taskId) {
          throw new RpcError(
            A2A_ERRORS.unsupportedOperation,
            'new tasks are started with tacet run',
          );
        }
        if (message.role !== 'ROLE_USER') throw new RpcError(-32602, 'an answer is a user message');
        const decision = DecisionExt.safeParse(message.metadata?.[DECISION_EXT_URI]);
        if (!decision.success) {
          throw new RpcError(-32602, `an answer needs the ${DECISION_EXT_URI} extension`);
        }
        const task = entry(message.taskId);
        const { escalationId } = decision.data;
        // Only an open escalation of this task or one of its unfinished sub-tasks.
        if (!task.escalations.some((x) => x.id === escalationId)) {
          throw new RpcError(-32602, `no open escalation ${escalationId} on task ${task.id}`);
        }
        // The code is never echoed, logged or stored.
        const refused = o.answerCodes.check(escalationId, decision.data.code);
        if (refused) {
          throw new RpcError(
            -32602,
            refused === 'none'
              ? `escalation ${escalationId} has no answer code yet: the tacet run terminal shows it when it asks the question`
              : refused === 'wrong'
                ? `wrong answer code for escalation ${escalationId}`
                : `too many wrong answer codes for escalation ${escalationId}: the tacet run terminal shows a new one when it asks again`,
          );
        }
        const text = message.parts
          .flatMap((part) => ('text' in part ? [part.text] : []))
          .join('\n')
          .trim();
        try {
          o.mini.answer(escalationId, text || decision.data.choice);
        } catch (err) {
          // Resolved meanwhile, or an empty answer: the message names the escalation only.
          throw new RpcError(-32602, (err as Error).message);
        } finally {
          // Used once, answered or not.
          o.answerCodes.drop(escalationId);
        }
        return { task: toA2ATask(entry(task.id), o.contextId) };
      },
    },
  });
}
