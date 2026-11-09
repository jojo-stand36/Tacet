import {
  Decision,
  Escalation,
  type EventEnvelope,
  HandoffPacket,
  newUlid,
  tasksProjection,
} from '@tacet/core';
import type { EventStore, WorkerBinding } from '@tacet/core/node';
import type { DecisionSummary, ToolInput, ToolOutput } from './tools.js';

/** A tool failure the worker should see (`isError`), with optional structured detail. */
export class ToolError extends Error {
  override name = 'ToolError';
  constructor(
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/**
 * Resolves an escalation without a human when it can (ARCHITECTURE.md §2.2): policy, precedent or
 * the Mini-conductor's own judgement. Returns `undefined` to leave it pending. The server waits
 * at most `gateTimeoutMs` for it, so it must never block on a person.
 */
export type EscalationGate = (
  escalation: Escalation,
  binding: WorkerBinding,
) => Promise<{ answer: string; source: 'policy' | 'precedent' | 'mini' } | undefined>;

/**
 * What the MCP tools do. The server derives `binding` from the caller's token; a backend must
 * never act outside `binding.taskId`. `EventLogBackend` is the default; the daemon (#17) can wrap
 * it to add scheduling hooks.
 */
export interface MiniBackend {
  readTask(b: WorkerBinding): Promise<ToolOutput<'read_task'>>;
  reportProgress(
    b: WorkerBinding,
    i: ToolInput<'report_progress'>,
  ): Promise<ToolOutput<'report_progress'>>;
  escalate(b: WorkerBinding, i: ToolInput<'escalate'>): Promise<ToolOutput<'escalate'>>;
  getDecision(b: WorkerBinding, i: ToolInput<'get_decision'>): Promise<ToolOutput<'get_decision'>>;
  requestHandoff(
    b: WorkerBinding,
    i: ToolInput<'request_handoff'>,
  ): Promise<ToolOutput<'request_handoff'>>;
  recordDecision(
    b: WorkerBinding,
    i: ToolInput<'record_decision'>,
  ): Promise<ToolOutput<'record_decision'>>;
  searchDecisions(
    b: WorkerBinding,
    i: ToolInput<'search_decisions'>,
  ): Promise<ToolOutput<'search_decisions'>>;
}

export interface EventLogBackendOptions {
  store: EventStore;
  /** Repo id stamped on events (envelope `repo`). */
  repo?: string;
  /** Mini-conductor id for the event `source`. */
  miniId?: string;
  gate?: EscalationGate;
  /** Longest the escalation gate may take before the result is `pending`. Default 3000 ms. */
  gateTimeoutMs?: number;
  /** Whether a worker's repo-scope decision becomes precedent without approval. Default: never. */
  allowRepoDecision?: (b: WorkerBinding, d: ToolInput<'record_decision'>) => boolean;
  /** Called when a handoff packet is accepted; the daemon closes the session and seeds a new one. */
  onHandoff?: (b: WorkerBinding, packet: HandoffPacket, reason: string) => void;
  /** Minimum interval between stored progress reports per worker. Default 1000 ms. */
  progressIntervalMs?: number;
  /** Extra task constraints for `read_task`, e.g. from repo policy. */
  constraints?: (taskId: string) => string[];
  now?: () => Date;
}

const ANSWER_SOURCES = new Set(['policy', 'precedent', 'mini', 'user']);

/** The MCP tools over the append-only event log (ADR-003 §1); all state changes are events. */
export class EventLogBackend implements MiniBackend {
  readonly #o: EventLogBackendOptions;
  readonly #lastProgress = new Map<string, number>();

  constructor(opts: EventLogBackendOptions) {
    this.#o = opts;
  }

  #now(): Date {
    return this.#o.now?.() ?? new Date();
  }

  #append(
    b: WorkerBinding | undefined,
    type: string,
    data: unknown,
    kind: 'worker' | 'mini',
  ): string {
    const now = this.#now();
    const id = newUlid(now.getTime());
    const env: EventEnvelope = {
      v: 1,
      id,
      ts: now.toISOString(),
      source:
        kind === 'worker' && b
          ? { kind, id: b.workerSessionId }
          : { kind: 'mini', id: this.#o.miniId ?? 'mini' },
      ...(this.#o.repo !== undefined ? { repo: this.#o.repo } : {}),
      ...(b ? { taskId: b.taskId, sessionId: b.workerSessionId } : {}),
      type,
      data,
    };
    this.#o.store.append(env);
    return id;
  }

  #events(b: WorkerBinding, typePrefix: string) {
    return this.#o.store.query({ taskId: b.taskId, typePrefix }).map((e) => e.envelope);
  }

  #decisions(b: WorkerBinding): Decision[] {
    // Task decisions for this task, plus repo-scope precedent from any task.
    return this.#o.store
      .query({ typePrefix: 'decision.recorded' })
      .flatMap((e) => {
        const d = Decision.safeParse(e.envelope.data);
        return d.success ? [d.data] : [];
      })
      .filter((d) => d.scope === 'repo' || d.taskId === b.taskId);
  }

  async readTask(b: WorkerBinding): Promise<ToolOutput<'read_task'>> {
    const view = this.#o.store.replay(tasksProjection, { taskId: b.taskId }).tasks[b.taskId];
    if (!view) throw new ToolError('your task is not known to this Mini-conductor');
    const budget = view.task.budget?.usd;
    const handoffs = this.#events(b, 'handoff.requested');
    const last = handoffs.at(-1)?.data as { packet?: unknown } | undefined;
    const packet = last?.packet !== undefined ? HandoffPacket.safeParse(last.packet) : undefined;
    return {
      goal: view.task.goal,
      acceptanceCriteria: view.task.acceptanceCriteria,
      constraints: this.#o.constraints?.(b.taskId) ?? [],
      budgetRemaining:
        budget === undefined
          ? null
          : Math.max(0, Math.round((budget - view.usage.costUsd) * 1e6) / 1e6),
      relevantDecisions: this.#decisions(b).slice(-20).map(summary),
      ...(packet?.success ? { handoff: packet.data } : {}),
    };
  }

  async reportProgress(b: WorkerBinding, i: ToolInput<'report_progress'>) {
    const now = this.#now().getTime();
    const last = this.#lastProgress.get(b.workerSessionId) ?? Number.NEGATIVE_INFINITY;
    // Rate limit (ADR-003 §6): reports inside the interval are acknowledged but not stored.
    if (now - last >= (this.#o.progressIntervalMs ?? 1000)) {
      this.#lastProgress.set(b.workerSessionId, now);
      this.#append(b, 'worker.progress', i, 'worker');
    }
    return { ack: true as const };
  }

  /** Record a new pending escalation, without consulting the gate. */
  #raise(
    b: WorkerBinding,
    i: ToolInput<'escalate'>,
    extra: Record<string, unknown> = {},
  ): Escalation {
    const now = this.#now();
    const escalation = Escalation.parse({
      id: newUlid(now.getTime()),
      taskId: b.taskId,
      sessionId: b.workerSessionId,
      ...(this.#o.repo !== undefined ? { repo: this.#o.repo } : {}),
      question: i.question,
      ...(i.options ? { options: i.options } : {}),
      urgency: i.urgency,
      ...(i.context !== undefined ? { context: i.context } : {}),
      ...(i.contextRef !== undefined ? { contextRef: i.contextRef } : {}),
      blockedWorkers: i.urgency === 'blocking' ? 1 : 0,
      status: 'pending',
      createdAt: now.toISOString(),
    });
    this.#append(b, 'escalation.raised', { ...escalation, ...extra }, 'worker');
    return escalation;
  }

  async escalate(b: WorkerBinding, i: ToolInput<'escalate'>): Promise<ToolOutput<'escalate'>> {
    const escalation = this.#raise(b, i);
    const gate = this.#o.gate;
    if (!gate) return { escalationId: escalation.id, status: 'pending' };
    const resolve = (result: { answer: string; source: 'policy' | 'precedent' | 'mini' }) =>
      this.#append(
        b,
        'escalation.resolved',
        { escalationId: escalation.id, answer: result.answer, source: result.source },
        'mini',
      );
    let timedOut = false;
    const answered = gate(escalation, b).then(
      (result) => {
        // A late answer is still recorded; the daemon delivers it as the worker's next message.
        if (result && timedOut) resolve(result);
        return result;
      },
      (err: unknown) => {
        this.#append(
          b,
          'escalation.gate_failed',
          {
            escalationId: escalation.id,
            message: err instanceof Error ? err.message : String(err),
          },
          'mini',
        );
        return undefined;
      },
    );
    let timer: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      answered,
      new Promise<undefined>((r) => {
        timer = setTimeout(() => {
          timedOut = true;
          r(undefined);
        }, this.#o.gateTimeoutMs ?? 3000);
      }),
    ]);
    clearTimeout(timer);
    if (result && !timedOut) {
      resolve(result);
      return {
        escalationId: escalation.id,
        status: 'resolved',
        answer: result.answer,
        source: result.source,
      };
    }
    return { escalationId: escalation.id, status: 'pending' };
  }

  async getDecision(
    b: WorkerBinding,
    i: ToolInput<'get_decision'>,
  ): Promise<ToolOutput<'get_decision'>> {
    // Only escalations of the caller's own task are visible.
    const raised = this.#events(b, 'escalation.raised').some(
      (e) => (e.data as { id?: unknown }).id === i.escalationId,
    );
    if (!raised) throw new ToolError('no such escalation for your task');
    const resolved = this.#events(b, 'escalation.resolved')
      .map((e) => e.data as { escalationId?: unknown; answer?: unknown; source?: unknown })
      .filter((d) => d.escalationId === i.escalationId)
      .at(-1);
    if (!resolved) return { status: 'pending' };
    const source =
      typeof resolved.source === 'string' && ANSWER_SOURCES.has(resolved.source)
        ? resolved.source
        : undefined;
    return {
      status: 'resolved',
      ...(typeof resolved.answer === 'string' ? { answer: resolved.answer } : {}),
      ...(source ? { source: source as 'policy' | 'precedent' | 'mini' | 'user' } : {}),
    };
  }

  async requestHandoff(
    b: WorkerBinding,
    i: ToolInput<'request_handoff'>,
  ): Promise<ToolOutput<'request_handoff'>> {
    // One accepted handoff per session: each one seeds a new session, so more would fan out cost.
    const already = this.#events(b, 'handoff.requested').some(
      (e) => e.sessionId === b.workerSessionId,
    );
    if (already) throw new ToolError('a handoff was already accepted for this session');
    const raw = (typeof i.packet === 'object' && i.packet !== null ? i.packet : {}) as Record<
      string,
      unknown
    >;
    // Identity comes from the token, not from the packet; the Mini-conductor mints the id.
    const { id: _ignored, ...rest } = raw;
    const parsed = HandoffPacket.safeParse({
      v: 1,
      createdAt: this.#now().toISOString(),
      ...rest,
      taskId: b.taskId,
      parentSession: b.workerSessionId,
    });
    if (!parsed.success) {
      const errors = parsed.error.issues.map(
        (x) => `${x.path.join('.') || '(packet)'}: ${x.message}`,
      );
      throw new ToolError(
        'the handoff packet is invalid; fix these fields and call request_handoff again',
        {
          accepted: false,
          errors,
        },
      );
    }
    const handoffId = newUlid(this.#now().getTime());
    const packet = { ...parsed.data, id: handoffId };
    this.#append(b, 'handoff.requested', { handoffId, reason: i.reason, packet }, 'worker');
    this.#lastProgress.delete(b.workerSessionId);
    this.#o.onHandoff?.(b, packet, i.reason);
    return { accepted: true, handoffId };
  }

  async recordDecision(
    b: WorkerBinding,
    i: ToolInput<'record_decision'>,
  ): Promise<ToolOutput<'record_decision'>> {
    const decisionId = newUlid(this.#now().getTime());
    if (i.scope === 'repo' && !(this.#o.allowRepoDecision?.(b, i) ?? false)) {
      // Repo-wide precedent needs approval: it becomes an escalation instead (ADR-003 §6). It
      // never goes through the gate, which could otherwise approve it on its own; only repo
      // policy (`allowRepoDecision`) or the user may. The proposal travels with the escalation,
      // so an approval can record it under `decisionId`.
      const esc = this.#raise(
        b,
        {
          question: `Approve a repo-wide decision on "${i.topic}": ${i.decision}`,
          urgency: 'normal',
          ...(i.rationale !== undefined ? { context: i.rationale } : {}),
        },
        {
          category: 'decision',
          proposedDecision: {
            decisionId,
            topic: i.topic,
            decision: i.decision,
            ...(i.rationale !== undefined ? { rationale: i.rationale } : {}),
            scope: 'repo',
          },
        },
      );
      return { decisionId, status: 'needs_approval', escalationId: esc.id };
    }
    const decision = Decision.parse({
      id: decisionId,
      taskId: b.taskId,
      ...(this.#o.repo !== undefined ? { repo: this.#o.repo } : {}),
      topic: i.topic,
      decision: i.decision,
      ...(i.rationale !== undefined ? { rationale: i.rationale } : {}),
      scope: i.scope,
      source: 'worker',
      decidedAt: this.#now().toISOString(),
    });
    this.#append(b, 'decision.recorded', decision, 'worker');
    return { decisionId, status: 'recorded' };
  }

  async searchDecisions(
    b: WorkerBinding,
    i: ToolInput<'search_decisions'>,
  ): Promise<ToolOutput<'search_decisions'>> {
    const terms = i.query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length > 1);
    const scored = this.#decisions(b)
      .map((d, order) => {
        const text = `${d.topic} ${d.decision} ${d.rationale ?? ''}`.toLowerCase();
        return { d, order, score: terms.filter((t) => text.includes(t)).length };
      })
      .filter((x) => x.score > 0)
      // Best match first; newer first among equals.
      .sort((a, c) => c.score - a.score || c.order - a.order);
    return { decisions: scored.slice(0, i.limit ?? 10).map((x) => summary(x.d)) };
  }
}

function summary(d: Decision): DecisionSummary {
  return {
    id: d.id,
    topic: d.topic,
    decision: d.decision,
    ...(d.rationale !== undefined ? { rationale: d.rationale } : {}),
    scope: d.scope,
    source: d.source,
  };
}
