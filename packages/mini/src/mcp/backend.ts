import {
  Decision,
  Escalation,
  type EventEnvelope,
  HandoffPacket,
  newUlid,
  tasksProjection,
} from '@tacet/core';
import type { EventStore, WorkerBinding } from '@tacet/core/node';
import { rootTasks } from '../gate/gate.js';
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

/** What the escalation gate answered, and why (ADR-004). */
export interface GateAnswer {
  answer: string;
  source: 'policy' | 'precedent' | 'mini';
  /** Why, for the user reading the log later; recorded on the Decision and `escalation.resolved`. */
  rationale?: string;
}

/**
 * Resolves an escalation without a human when it can (ARCHITECTURE.md §2.2, ADR-004): a precedent
 * of the user's own, or the Mini-conductor's own judgement. Returns `undefined` to leave it to the
 * user. The server waits at most `gateTimeoutMs` for its promise, so it must never block on a
 * person; synchronous work is not bounded by that time. Its
 * answer is advice to the sub-task, never a permission (ADR-004 E).
 */
export type EscalationGate = (
  escalation: Escalation,
  binding: WorkerBinding,
  /** Aborted when the gate's time is up: its answer would be dropped, so work for it can stop. */
  signal?: AbortSignal,
) => Promise<GateAnswer | undefined>;

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
  /**
   * The Worker's token was revoked (its session ended): drop whatever is kept in memory for it
   * (#122). Anything needed later is in the event log.
   */
  forget?(workerSessionId: string): void;
}

export interface EventLogBackendOptions {
  store: EventStore;
  /** Repo id stamped on events (envelope `repo`). */
  repo?: string;
  /** Mini-conductor id for the event `source`. */
  miniId?: string;
  gate?: EscalationGate;
  /**
   * Longest the escalation gate may take before the result is `pending`, or how to tell it for a
   * Worker (by its task's autonomy). Default 3000 ms.
   */
  gateTimeoutMs?: number | ((b: WorkerBinding) => number);
  /** Whether a worker's repo-scope decision becomes precedent without approval. Default: never. */
  allowRepoDecision?: (b: WorkerBinding, d: ToolInput<'record_decision'>) => boolean;
  /** Called when a handoff packet is accepted; the daemon closes the session and seeds a new one. */
  onHandoff?: (b: WorkerBinding, packet: HandoffPacket, reason: string) => void;
  /**
   * Why this Worker may not hand off now, if so (#129): asked before the packet is recorded, so a
   * refused handoff leaves nothing behind.
   */
  canHandoff?: (b: WorkerBinding) => string | undefined;
  /** Minimum interval between stored progress reports per worker. Default 1000 ms. */
  progressIntervalMs?: number;
  /**
   * Per-Worker limits on the tools that ask a person for something (#121): at most `max` calls
   * per `windowMs`. Defaults: `escalate` 6 and `record_decision` 30 per 10 minutes.
   */
  limits?: Partial<Record<LimitedTool, ToolLimit>>;
  /** Extra task constraints for `read_task`, e.g. from repo policy. */
  constraints?: (taskId: string) => string[];
  now?: () => Date;
}

const ANSWER_SOURCES = new Set(['policy', 'precedent', 'mini', 'user']);
/**
 * Sources a gate may answer with. `policy` is reserved until a rule kind that can answer exists
 * (ADR-004 D), and a gate never answers as the user.
 */
const GATE_SOURCES: ReadonlySet<string> = new Set(['precedent', 'mini']);

export type LimitedTool = 'escalate' | 'record_decision';
export interface ToolLimit {
  max: number;
  windowMs: number;
}

/**
 * A Worker that escalates more than this in ten minutes is looping, not asking: each escalation
 * lands in the user's queue. Decisions are cheaper, so the bar is higher.
 */
export const DEFAULT_TOOL_LIMITS: Readonly<Record<LimitedTool, ToolLimit>> = {
  escalate: { max: 6, windowMs: 600_000 },
  record_decision: { max: 30, windowMs: 600_000 },
};

/** What the rate limits keep per Worker: recent call times, and when it was last throttled. */
interface WorkerCalls {
  calls: Map<LimitedTool, number[]>;
  throttled: Map<LimitedTool, number>;
}

/** The MCP tools over the append-only event log (ADR-003 §1); all state changes are events. */
export class EventLogBackend implements MiniBackend {
  readonly #o: EventLogBackendOptions;
  /** When each Worker's last progress report was stored: only for the rate limit. */
  readonly #lastProgress = new Map<string, number>();
  /** Recent calls to the limited tools, per Worker (#121). */
  readonly #calls = new Map<string, WorkerCalls>();

  constructor(opts: EventLogBackendOptions) {
    for (const [tool, lim] of Object.entries(opts.limits ?? {})) {
      if (
        !lim ||
        !Number.isInteger(lim.max) ||
        lim.max < 1 ||
        !Number.isInteger(lim.windowMs) ||
        lim.windowMs < 1
      ) {
        throw new Error(`limits.${tool}: max and windowMs must be positive integers`);
      }
    }
    this.#o = opts;
  }

  #gateTimeout(b: WorkerBinding): number {
    const t = this.#o.gateTimeoutMs;
    return typeof t === 'function' ? t(b) : (t ?? 3000);
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
    const env = this.#envelope(b, type, data, kind);
    this.#o.store.append(env);
    return env.id;
  }

  #envelope(
    b: WorkerBinding | undefined,
    type: string,
    data: unknown,
    kind: 'worker' | 'mini',
  ): EventEnvelope {
    const now = this.#now();
    const id = newUlid(now.getTime());
    return {
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
  }

  #events(b: WorkerBinding, typePrefix: string) {
    return this.#o.store.query({ taskId: b.taskId, typePrefix }).map((e) => e.envelope);
  }

  #decisions(b: WorkerBinding): Decision[] {
    // Task decisions of any task with the same root task (a task's sub-tasks share them, ADR-004
    // A), plus repo-scope precedent from any task.
    const rootOf = rootTasks(this.#o.store);
    const root = rootOf(b.taskId);
    return this.#o.store
      .query({ typePrefix: 'decision.recorded' })
      .flatMap((e) => {
        const d = Decision.safeParse(e.envelope.data);
        return d.success ? [d.data] : [];
      })
      .filter((d) => d.scope === 'repo' || (d.taskId !== undefined && rootOf(d.taskId) === root));
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

  forget(workerSessionId: string): void {
    this.#lastProgress.delete(workerSessionId);
    this.#calls.delete(workerSessionId);
  }

  /** @internal Tests only: how many Workers the backend keeps state for. */
  get workersWithState(): number {
    return new Set([...this.#lastProgress.keys(), ...this.#calls.keys()]).size;
  }

  #limitFor(tool: LimitedTool): ToolLimit {
    return this.#o.limits?.[tool] ?? DEFAULT_TOOL_LIMITS[tool];
  }

  /**
   * Count a call that uses the limited `tools`, or refuse it (#121). Over any of its limits, the
   * Worker gets a tool error it can read, nothing is created, and nothing is counted. A
   * `worker.throttled` is recorded at most once per window from the first refusal (a Worker that
   * gets under the limit and hits it again within that window gets no second one). Limits are per
   * Worker and kept in memory only: a restarted Mini-conductor starts them afresh.
   */
  #limit(b: WorkerBinding, ...tools: LimitedTool[]): void {
    const now = this.#now().getTime();
    // Calls older than their window limit nothing: drop them, for every Worker, so state for a
    // Worker whose token was never revoked does not stay forever.
    for (const [id, w] of this.#calls) {
      for (const [t, times] of w.calls) {
        const recent = times.filter((x) => now - x < this.#limitFor(t).windowMs);
        if (recent.length > 0) w.calls.set(t, recent);
        else w.calls.delete(t);
      }
      for (const [t, at] of w.throttled) {
        if (now - at >= this.#limitFor(t).windowMs) w.throttled.delete(t);
      }
      if (w.calls.size === 0 && w.throttled.size === 0) this.#calls.delete(id);
    }
    const w = this.#calls.get(b.workerSessionId) ?? { calls: new Map(), throttled: new Map() };
    for (const tool of tools) {
      const lim = this.#limitFor(tool);
      const times = w.calls.get(tool) ?? [];
      if (times.length < lim.max) continue;
      this.#calls.set(b.workerSessionId, w);
      if (!w.throttled.has(tool)) {
        w.throttled.set(tool, now);
        this.#append(
          b,
          'worker.throttled',
          { sessionId: b.workerSessionId, tool, limit: lim.max, windowMs: lim.windowMs },
          'mini',
        );
      }
      const retryAfterMs = Math.max(1, lim.windowMs - (now - (times[0] ?? now)));
      throw new ToolError(
        `${tool} is rate-limited for this Worker: at most ${lim.max} per ${duration(lim.windowMs)}, and the limit is reached. Do not call it again before ${duration(retryAfterMs)} from now; continue with what you have, or end your turn with a summary of what blocks you.`,
        { tool, limit: lim.max, windowMs: lim.windowMs, retryAfterMs },
      );
    }
    for (const tool of tools) w.calls.set(tool, [...(w.calls.get(tool) ?? []), now]);
    this.#calls.set(b.workerSessionId, w);
  }

  async reportProgress(b: WorkerBinding, i: ToolInput<'report_progress'>) {
    const now = this.#now().getTime();
    const interval = this.#o.progressIntervalMs ?? 1000;
    // An entry older than the interval limits nothing: drop it. This also bounds what a call
    // still in flight when its token was revoked can leave behind.
    for (const [id, at] of this.#lastProgress) {
      if (now - at >= interval) this.#lastProgress.delete(id);
    }
    const last = this.#lastProgress.get(b.workerSessionId) ?? Number.NEGATIVE_INFINITY;
    // Rate limit (ADR-003 §6): reports inside the interval are acknowledged but not stored.
    if (now - last >= interval) {
      this.#lastProgress.set(b.workerSessionId, now);
      this.#append(b, 'worker.progress', i, 'worker');
    }
    return { ack: true as const };
  }

  /** Record a new pending escalation, without consulting the gate. */
  #raise(
    b: WorkerBinding,
    i: ToolInput<'escalate'>,
    extra: Pick<Escalation, 'category' | 'proposedDecision'> = {},
  ): Escalation {
    const escalation = this.#escalation(b, i, extra);
    this.#append(b, 'escalation.raised', escalation, 'worker');
    return escalation;
  }

  /** A new pending escalation, not yet written. */
  #escalation(
    b: WorkerBinding,
    i: ToolInput<'escalate'>,
    extra: Pick<Escalation, 'category' | 'proposedDecision'> = {},
  ): Escalation {
    const now = this.#now();
    return Escalation.parse({
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
      ...extra,
    });
  }

  /**
   * Raise an escalation and give the gate up to `gateTimeoutMs` to answer it (ADR-003 addendum on
   * the escalation gate, item 2). The escalation and its outcome are one write: answered in time,
   * `escalation.raised` goes with the gate's Decision (scope `task`, never precedent),
   * `escalation.resolved` and `escalation.delivered` (inline), so the user never sees a question
   * the gate answered, and a crash leaves nothing half-written; not answered in time, the
   * escalation is written as pending and a late answer is dropped, since the user may already
   * be reading it. `blocking` questions never reach the gate (ADR-004 B).
   */
  async escalate(b: WorkerBinding, i: ToolInput<'escalate'>): Promise<ToolOutput<'escalate'>> {
    this.#limit(b, 'escalate');
    const gate = this.#o.gate;
    if (!gate || i.urgency === 'blocking') {
      return { escalationId: this.#raise(b, i).id, status: 'pending' };
    }
    const escalation = this.#escalation(b, i);
    const raised = this.#envelope(b, 'escalation.raised', escalation, 'worker');
    let settled = false;
    let writeError: unknown;
    const failed = (err: unknown) =>
      this.#envelope(
        b,
        'escalation.gate_failed',
        { escalationId: escalation.id, message: err instanceof Error ? err.message : String(err) },
        'mini',
      );
    // A gate that throws at once fails like one that rejects: the escalation is still written.
    const late = new AbortController();
    const answered = Promise.resolve()
      .then(() => gate(escalation, b, late.signal))
      .then(
        (result) => ({ result }),
        (err: unknown) => {
          // Not when the pending write itself failed: there is no escalation to name.
          if (settled && writeError === undefined) {
            // Failing after the time is up still leaves a trace; the user answers either way. The
            // store may be closed by then (the Mini-conductor stopping): nothing is left to tell.
            try {
              this.#o.store.append(failed(err));
            } catch {}
          }
          return { result: undefined, error: err };
        },
      );
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      answered,
      new Promise<undefined>((r) => {
        timer = setTimeout(() => {
          // Time is up: written as pending at once, so a gate failure after it comes after it.
          settled = true;
          late.abort();
          try {
            this.#o.store.append(raised);
          } catch (err) {
            writeError = err;
          }
          r(undefined);
        }, this.#gateTimeout(b));
      }),
    ]);
    clearTimeout(timer);
    if (outcome === undefined) {
      if (writeError !== undefined) throw writeError;
      return { escalationId: escalation.id, status: 'pending' };
    }
    settled = true;
    const result = outcome.result;
    if (!result || !GATE_SOURCES.has(result.source)) {
      this.#o.store.append('error' in outcome ? [raised, failed(outcome.error)] : [raised]);
      return { escalationId: escalation.id, status: 'pending' };
    }
    // A gate's answer that is not a valid Decision (an empty answer) leaves the question pending.
    const parsed = Decision.safeParse({
      id: newUlid(this.#now().getTime()),
      escalationId: escalation.id,
      taskId: b.taskId,
      ...(this.#o.repo !== undefined ? { repo: this.#o.repo } : {}),
      topic: escalation.question,
      decision: result.answer,
      ...(result.rationale !== undefined ? { rationale: result.rationale } : {}),
      scope: 'task',
      source: result.source,
      decidedAt: this.#now().toISOString(),
    });
    if (!parsed.success) {
      this.#o.store.append([raised, failed(new Error('the gate gave an invalid answer'))]);
      return { escalationId: escalation.id, status: 'pending' };
    }
    const decision = parsed.data;
    this.#o.store.append([
      raised,
      this.#envelope(b, 'decision.recorded', decision, 'mini'),
      this.#envelope(
        b,
        'escalation.resolved',
        {
          escalationId: escalation.id,
          answer: result.answer,
          source: result.source,
          decisionId: decision.id,
          ...(result.rationale !== undefined ? { rationale: result.rationale } : {}),
        },
        'mini',
      ),
      // The Worker gets this answer in the tool result itself: the daemon must not send it again.
      this.#envelope(
        b,
        'escalation.delivered',
        { escalationId: escalation.id, sessionId: b.workerSessionId, inline: true },
        'mini',
      ),
    ]);
    return {
      escalationId: escalation.id,
      status: 'resolved',
      answer: result.answer,
      source: result.source,
    };
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
    const refused = this.#o.canHandoff?.(b);
    if (refused !== undefined) throw new ToolError(`handoff refused: ${refused}`);
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
    const needsApproval = i.scope === 'repo' && !(this.#o.allowRepoDecision?.(b, i) ?? false);
    // A proposal that needs approval lands in the user's queue like an escalation, so it counts
    // against both limits.
    if (needsApproval) this.#limit(b, 'record_decision', 'escalate');
    else this.#limit(b, 'record_decision');
    const decisionId = newUlid(this.#now().getTime());
    if (needsApproval) {
      // Repo-wide precedent needs approval: it becomes an escalation instead (ADR-003 §6). It
      // never goes through the gate, which could otherwise approve it on its own; only repo
      // policy (`allowRepoDecision`) or the user may. The proposal travels with the escalation,
      // so an approval can record it under `decisionId`.
      const esc = this.#raise(
        b,
        {
          question: `Approve a repo-wide decision on "${i.topic}": ${i.decision}`,
          // "approve" records the proposal as the user's (#25); anything else leaves it out.
          options: ['approve', 'reject'],
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

/** A duration for a model to read: seconds below two minutes, minutes above. */
function duration(ms: number): string {
  const s = Math.ceil(ms / 1000);
  if (s < 120) return s === 1 ? '1 second' : `${s} seconds`;
  return `${Math.ceil(s / 60)} minutes`;
}
