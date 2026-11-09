import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  type AgentEvent,
  type EventEnvelope,
  newUlid,
  type Priority,
  type SessionHandle,
  type SummaryPacket,
  type TacetConfig,
  type Task,
  type TaskInput,
  TaskPlan,
  type TaskState,
  type TaskView,
  tasksProjection,
  type Verification,
} from '@tacet/core';
import type { EventStore } from '@tacet/core/node';
import type {
  Planner,
  Verifier,
  WorkerAdapter,
  WorkerMcp,
  Workspace,
  Workspaces,
} from './ports.js';
import { RESUME_PROMPT, WORKER_SYSTEM_PROMPT, workerPrompt } from './prompts.js';
import { blockedByFailure, pickReady, type SchedulableSubtask } from './scheduler.js';

export interface MiniConductorOptions {
  store: EventStore;
  /** Effective config (`loadConfig`): tiers, workers, verify. */
  config: TacetConfig;
  /** Worker adapters by id (`tiers.*.adapter`), each on the `api_key` route. */
  adapters: Record<string, WorkerAdapter>;
  workspaces: Workspaces;
  planner: Planner;
  /** Default: passes, with the configured `verify` commands recorded as not run (#19). */
  verifier?: Verifier;
  mcp: WorkerMcp;
  /** Single-instance lock, e.g. `<repoStateDir>/mini.lock`. */
  lockPath: string;
  /** Repo id stamped on events. */
  repo?: string;
  miniId?: string;
  now?: () => Date;
  /** How often to look for answered escalations, in ms. Default 1000. */
  pollMs?: number;
}

/** What the pool knows about each Worker session, rebuilt from `worker.*` events. */
interface SessionRecord {
  sessionId: string;
  taskId: string;
  adapter?: string;
  model?: string;
  workspaceId?: string;
  attempt: number;
  vendorSessionId?: string;
  ended?: string;
}

interface Run {
  sessionId: string;
  subtaskId: string;
  adapterId: string;
  handle: SessionHandle;
  workspace: Workspace;
  revoke: () => void;
  /** Name of the Mini-conductor's MCP server in this Worker's config. */
  mcpServerName: string;
  text: string;
  /** The last complete assistant message, for the summary. */
  lastMessage?: string;
  /** Set while the turn's end is being handled, so it is handled once. */
  settling: boolean;
}

const TERMINAL: ReadonlySet<TaskState> = new Set(['completed', 'failed', 'canceled', 'rejected']);

/**
 * The Mini-conductor's core loop (#17): accept a task, plan it into sub-tasks, schedule them
 * onto Workers by dependency and capacity, verify each finished turn, and roll results up as
 * summary packets. All state lives in the event log; `start()` rebuilds it, so a restart
 * mid-task resumes without losing work.
 */
export class MiniConductor {
  readonly #o: MiniConductorOptions;
  readonly #runs = new Map<string, Run>();
  readonly #planning = new Set<string>();
  #timer: NodeJS.Timeout | undefined;
  #started = false;
  #stopping = false;
  #ticking: Promise<void> = Promise.resolve();
  readonly #errors: unknown[] = [];

  constructor(opts: MiniConductorOptions) {
    for (const [id, w] of Object.entries(opts.adapters)) {
      if (w.authRoute !== 'api_key') {
        throw new Error(
          `adapter ${id}: Workers run unattended and must use the api_key route (#65)`,
        );
      }
    }
    this.#o = opts;
  }

  /** Errors from background work (planning, Worker runs), for logs and tests. */
  get errors(): readonly unknown[] {
    return this.#errors;
  }

  /** Start: take the single-instance lock, rebuild state from the log, and resume. */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#lock();
    this.#started = true;
    // Sessions without `worker.ended` belonged to a Mini-conductor that stopped without closing
    // them (a crash): they are gone now. Recording that is what lets their sub-tasks resume.
    const ended: EventEnvelope[] = [];
    for (const s of this.#sessions().values()) {
      if (s.ended === undefined) {
        ended.push(
          this.#env(
            s.taskId,
            'worker.ended',
            { sessionId: s.sessionId, reason: 'restart' },
            s.sessionId,
          ),
        );
      }
    }
    if (ended.length > 0) this.#o.store.append(ended);
    for (const v of Object.values(this.#tasks())) {
      if (!v.task.parentId && !TERMINAL.has(v.state) && v.plan === undefined)
        void this.#plan(v.task);
    }
    this.#timer = setInterval(() => this.#kick(), this.#o.pollMs ?? 1000);
    this.#timer.unref();
    this.#kick();
  }

  /** Accept a task. Returns its id; planning and scheduling continue in the background. */
  submit(input: Omit<TaskInput, 'id' | 'createdAt'> & { id?: string }): string {
    if (!this.#started) throw new Error('call start() first');
    const id = input.id ?? newUlid(this.#now().getTime());
    const task = { ...input, id, createdAt: this.#now().toISOString() };
    this.#o.store.append(this.#env(id, 'task.created', task));
    const view = this.#tasks()[id];
    if (view) void this.#plan(view.task);
    return id;
  }

  /** Wait until nothing is running or ready to run (for tests and `tacet run`). */
  async settled(timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await this.#ticking;
      if (this.#runs.size === 0 && this.#planning.size === 0 && this.#ready().length === 0) return;
      if (Date.now() > deadline)
        throw new Error('timed out waiting for the Mini-conductor to settle');
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /**
   * Stop: close every Worker session, recorded as `restart` so the next `start()` resumes it,
   * and release the lock.
   */
  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#stopping = true;
    if (this.#timer) clearInterval(this.#timer);
    await this.#ticking;
    await Promise.all([...this.#runs.values()].map((r) => this.#end(r, 'restart')));
    this.#started = false;
    this.#stopping = false;
    this.#unlock();
  }

  /** Abandon everything without recording it, as a crash would (tests only). */
  crashForTest(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#stopping = true;
    this.#runs.clear();
    this.#started = false;
    this.#unlock();
  }

  // ---- planning --------------------------------------------------------------------------

  async #plan(task: Task): Promise<void> {
    if (this.#planning.has(task.id)) return;
    this.#planning.add(task.id);
    try {
      const proposal = await this.#o.planner.plan(task);
      const idOf = new Map(proposal.subtasks.map((s, i) => [s.key, `${task.id}.${i + 1}`]));
      const plan = TaskPlan.parse({
        subtasks: proposal.subtasks.map((s) => ({
          id: idOf.get(s.key),
          goal: s.goal,
          acceptanceCriteria: s.acceptanceCriteria,
          kind: s.kind ?? 'implement',
          dependsOn: (s.dependsOn ?? []).map((d) => idOf.get(d) ?? d),
        })),
        ...(proposal.planner ? { planner: proposal.planner } : {}),
        ...(proposal.rationale !== undefined ? { rationale: proposal.rationale } : {}),
      });
      if (this.#stopping) return;
      const now = this.#now().toISOString();
      // One batch: a crash leaves either no plan (re-planned on start) or the whole plan.
      this.#o.store.append([
        this.#env(task.id, 'task.planned', plan),
        ...plan.subtasks.map((s) =>
          this.#env(s.id, 'task.created', {
            id: s.id,
            goal: s.goal,
            acceptanceCriteria: s.acceptanceCriteria,
            priority: task.priority,
            parentId: task.id,
            ...(task.contextId !== undefined ? { contextId: task.contextId } : {}),
            createdAt: now,
          }),
        ),
        this.#env(task.id, 'task.status', { state: 'working' }),
      ]);
    } catch (err) {
      this.#errors.push(err);
      this.#o.store.append(
        this.#env(task.id, 'task.status', {
          state: 'failed',
          message: `planning failed: ${(err as Error).message}`,
        }),
      );
    } finally {
      this.#planning.delete(task.id);
      this.#kick();
    }
  }

  // ---- scheduling ------------------------------------------------------------------------

  #kick(): void {
    if (!this.#started || this.#stopping) return;
    this.#ticking = this.#ticking
      .then(() => this.#tick())
      .catch((err) => {
        this.#errors.push(err);
      });
  }

  async #tick(): Promise<void> {
    if (this.#stopping) return;
    await this.#deliverAnswers();
    this.#failBlocked();
    this.#rollUp();
    for (const id of this.#ready()) await this.#run(id);
  }

  /** Sub-tasks of open tasks, as the scheduler sees them. */
  #schedulable(): SchedulableSubtask[] {
    const tasks = this.#tasks();
    const out: SchedulableSubtask[] = [];
    let order = 0;
    for (const parent of Object.values(tasks)) {
      if (parent.task.parentId || !parent.plan || TERMINAL.has(parent.state)) continue;
      for (const p of parent.plan) {
        const v = tasks[p.id];
        if (!v) continue;
        out.push({
          id: p.id,
          dependsOn: p.dependsOn,
          phase: this.#phase(v),
          priority: parent.task.priority as Priority,
          adapter: this.#tierFor(p.id).adapter,
          order: order++,
        });
      }
    }
    return out;
  }

  #phase(v: TaskView): SchedulableSubtask['phase'] {
    if (this.#runs.has(v.task.id)) return 'running';
    if (v.state === 'completed') return 'done';
    if (TERMINAL.has(v.state)) return 'failed';
    if (v.state === 'input_required') return 'blocked';
    return 'pending';
  }

  #ready(): string[] {
    const w = this.#o.config.workers ?? {};
    return pickReady(
      this.#schedulable(),
      [...this.#runs.values()].map((r) => ({ adapter: r.adapterId })),
      { max: w.max ?? 4, ...(w.per_adapter ? { perAdapter: w.per_adapter } : {}) },
    );
  }

  #tierFor(subtaskId: string): { adapter: string; model?: string; effort?: string } {
    const tiers = this.#o.config.tiers ?? {};
    const kind = this.#plannedKind(subtaskId);
    const tier = (kind === 'review' ? tiers.review : undefined) ?? tiers.worker;
    if (!tier) throw new Error('config has no tiers.worker');
    return {
      adapter: tier.adapter,
      model: tier.model,
      ...(tier.effort !== undefined ? { effort: tier.effort } : {}),
    };
  }

  #plannedKind(subtaskId: string): string | undefined {
    const parentId = this.#tasks()[subtaskId]?.task.parentId;
    if (!parentId) return undefined;
    const planned = this.#o.store
      .query({ taskId: parentId, typePrefix: 'task.planned' })
      .map((e) => TaskPlan.safeParse(e.envelope.data))
      .filter((p) => p.success)
      .at(-1);
    return planned?.data.subtasks.find((s) => s.id === subtaskId)?.kind;
  }

  /** Pending sub-tasks behind a failed one can never run: fail them. */
  #failBlocked(): void {
    const doomed = blockedByFailure(this.#schedulable());
    if (doomed.length === 0) return;
    this.#o.store.append(
      doomed.map((id) =>
        this.#env(id, 'task.status', {
          state: 'failed',
          message: 'a sub-task it depends on failed',
        }),
      ),
    );
  }

  /** A task is done when every sub-task is; it fails when any sub-task failed for good. */
  #rollUp(): void {
    const tasks = this.#tasks();
    for (const parent of Object.values(tasks)) {
      if (parent.task.parentId || !parent.plan || TERMINAL.has(parent.state)) continue;
      const subs = parent.plan
        .map((p) => tasks[p.id])
        .filter((v): v is TaskView => v !== undefined);
      if (subs.length !== parent.plan.length) continue;
      const failed = subs.filter((v) => TERMINAL.has(v.state) && v.state !== 'completed');
      const allDone = subs.every((v) => v.state === 'completed');
      if (!allDone && (failed.length === 0 || subs.some((v) => !TERMINAL.has(v.state)))) continue;
      const results = this.#o.store
        .query({ typePrefix: 'task.result' })
        .filter((e) => subs.some((v) => v.task.id === e.envelope.taskId))
        .map((e) => e.envelope.data as SummaryPacket);
      const summary: SummaryPacket = {
        v: 1,
        taskId: parent.task.id,
        createdAt: this.#now().toISOString(),
        outcome: allDone ? 'completed' : 'failed',
        summary:
          subs.map((v) => `${v.task.id} ${v.state}: ${v.task.goal}`).join('\n') || parent.task.goal,
        filesTouched: [...new Set(results.flatMap((r) => r.filesTouched ?? []))],
        commits: [...new Set(results.flatMap((r) => r.commits ?? []))],
        verification: {
          status: allDone ? 'passed' : 'failed',
          commands: [...new Set(results.flatMap((r) => r.verification?.commands ?? []))],
        },
        openQuestions: results.flatMap((r) => r.openQuestions ?? []),
      };
      this.#o.store.append([
        this.#env(parent.task.id, 'task.result', summary),
        this.#env(parent.task.id, 'task.status', {
          state: allDone ? 'completed' : 'failed',
          ...(allDone ? {} : { message: `${failed.length} sub-task(s) failed` }),
        }),
      ]);
    }
  }

  // ---- Workers ---------------------------------------------------------------------------

  async #run(subtaskId: string): Promise<void> {
    if (this.#runs.has(subtaskId)) return;
    const view = this.#tasks()[subtaskId];
    if (!view) return;
    const tier = this.#tierFor(subtaskId);
    const worker = this.#o.adapters[tier.adapter];
    if (!worker) {
      this.#o.store.append(
        this.#env(subtaskId, 'task.status', {
          state: 'failed',
          message: `no adapter ${tier.adapter}`,
        }),
      );
      return;
    }
    const history = [...this.#sessions().values()].filter((s) => s.taskId === subtaskId);
    const last = history.at(-1);
    const failed = history.filter((s) => s.ended === 'failed' || s.ended === 'stuck').length;
    // Reuse the checkout of an earlier run: a restart or a retry continues the same work.
    const existing = last?.workspaceId ? await this.#o.workspaces.get(last.workspaceId) : undefined;
    const workspace = existing ?? (await this.#o.workspaces.create(subtaskId));
    const resume =
      last?.ended === 'restart' &&
      last.vendorSessionId !== undefined &&
      last.adapter === tier.adapter &&
      existing !== undefined &&
      worker.adapter.capabilities().resume
        ? { vendorSessionId: last.vendorSessionId }
        : undefined;
    const sessionId = randomUUID();
    // Intent first: a crash after this leaves a record of the session and its checkout.
    this.#o.store.append([
      this.#env(
        subtaskId,
        'worker.started',
        {
          sessionId,
          adapter: tier.adapter,
          ...(tier.model !== undefined ? { model: tier.model } : {}),
          workspaceId: workspace.id,
          attempt: failed + 1,
          ...(last ? { previousSessionId: last.sessionId } : {}),
        },
        sessionId,
      ),
      ...(view.state !== 'working'
        ? [this.#env(subtaskId, 'task.status', { state: 'working' })]
        : []),
    ]);
    const { config, revoke } = this.#o.mcp.workerConfig({
      workerSessionId: sessionId,
      taskId: subtaskId,
    });
    let handle: SessionHandle;
    try {
      handle = await worker.adapter.start({
        cwd: workspace.path,
        systemPrompt: WORKER_SYSTEM_PROMPT,
        mcpServers: [config],
        ...(tier.model !== undefined ? { model: tier.model } : {}),
        ...(tier.effort !== undefined ? { effort: tier.effort } : {}),
        ...(resume ? { resume } : {}),
      });
    } catch (err) {
      revoke();
      this.#errors.push(err);
      this.#o.store.append(
        this.#env(
          subtaskId,
          'worker.ended',
          { sessionId, reason: 'failed', message: (err as Error).message },
          sessionId,
        ),
      );
      this.#afterFailure(subtaskId);
      return;
    }
    const run: Run = {
      sessionId,
      subtaskId,
      adapterId: tier.adapter,
      handle,
      workspace,
      revoke,
      mcpServerName: config.name,
      text: '',
      settling: false,
    };
    this.#runs.set(subtaskId, run);
    this.#noteVendorSession(run);
    void this.#consume(run, worker);
    const feedback = this.#lastFeedback(subtaskId);
    await worker.adapter.send(handle, {
      text: resume ? RESUME_PROMPT : workerPrompt(view.task, feedback),
    });
  }

  #noteVendorSession(run: Run): void {
    const v = run.handle.vendorSessionId;
    if (v === undefined) return;
    const known = this.#sessions().get(run.sessionId)?.vendorSessionId;
    if (known === v) return;
    this.#o.store.append(
      this.#env(
        run.subtaskId,
        'worker.vendor_session',
        { sessionId: run.sessionId, vendorSessionId: v },
        run.sessionId,
      ),
    );
  }

  async #consume(run: Run, worker: WorkerAdapter): Promise<void> {
    let started = false;
    try {
      for await (const e of worker.adapter.events(run.handle)) {
        if (this.#runs.get(run.subtaskId) !== run) break;
        this.#record(run, e);
        if (e.t === 'approval.request') {
          // Calls to the Mini-conductor's own MCP tools are what a Worker is for; anything else
          // is refused until policies exist (#25). A refused Worker can escalate.
          await worker.adapter.respond(
            run.handle,
            e.id,
            isOwnMcpTool(e, run.mcpServerName)
              ? { kind: 'allow_once', persist: false }
              : {
                  kind: 'reject',
                  persist: false,
                  message:
                    'Not approved: unattended Worker. Use the escalate tool if you need this.',
                },
          );
        } else if (e.t === 'status') {
          if (e.state === 'running') started = true;
          else if (e.state === 'idle' && started) {
            started = false;
            this.#noteVendorSession(run);
            await this.#turnEnded(run);
          } else if (e.state === 'error' || e.state === 'auth_required') {
            await this.#end(run, 'failed', e.message ?? e.state);
            this.#afterFailure(run.subtaskId);
            break;
          }
        }
      }
    } catch (err) {
      this.#errors.push(err);
    }
  }

  /** Store Worker events in the log, coalescing streamed text into one event per message. */
  #record(run: Run, e: AgentEvent): void {
    if (e.t === 'message.delta') {
      run.text += e.text;
      return;
    }
    const batch: EventEnvelope[] = [];
    if (run.text) {
      batch.push(
        this.#env(
          run.subtaskId,
          'agent.message.delta',
          { t: 'message.delta', text: run.text },
          run.sessionId,
        ),
      );
      run.lastMessage = run.text;
      run.text = '';
    }
    batch.push(this.#env(run.subtaskId, `agent.${e.t}`, e, run.sessionId));
    this.#o.store.append(batch);
  }

  async #turnEnded(run: Run): Promise<void> {
    if (run.settling || this.#stopping) return;
    run.settling = true;
    try {
      const pending = this.#escalations(run.subtaskId).filter(
        (x) => x.sessionId === run.sessionId && !x.resolved,
      );
      if (pending.length > 0) {
        this.#o.store.append(this.#env(run.subtaskId, 'task.status', { state: 'input_required' }));
        return;
      }
      const view = this.#tasks()[run.subtaskId];
      if (!view) return;
      const verification = await (this.#o.verifier ?? this.#defaultVerifier()).verify(
        view.task,
        run.workspace,
      );
      if (verification.status === 'failed') {
        this.#o.store.append(
          this.#env(run.subtaskId, 'task.result', this.#summary(run, 'failed', verification)),
        );
        await this.#end(run, 'failed', 'verification failed');
        this.#afterFailure(run.subtaskId);
        return;
      }
      this.#o.store.append([
        this.#env(run.subtaskId, 'task.result', this.#summary(run, 'completed', verification)),
        this.#env(run.subtaskId, 'task.status', { state: 'completed' }),
      ]);
      await this.#end(run, 'finished');
    } finally {
      run.settling = false;
      this.#kick();
    }
  }

  #summary(run: Run, outcome: 'completed' | 'failed', verification: Verification): SummaryPacket {
    const text = (run.lastMessage ?? run.text).trim();
    return {
      v: 1,
      taskId: run.subtaskId,
      sessionId: run.sessionId,
      createdAt: this.#now().toISOString(),
      outcome,
      summary: text ? text.slice(-2000) : `Worker turn ended (${outcome}).`,
      filesTouched: [],
      commits: [],
      verification,
      openQuestions: [],
    };
  }

  #defaultVerifier(): Verifier {
    const commands = this.#o.config.verify ?? [];
    return {
      // #19 runs the commands and a reviewer; until then nothing is claimed as verified.
      verify: async () => ({ status: commands.length > 0 ? 'not_run' : 'passed', commands }),
    };
  }

  /** Feedback for a retry: the last failed result's summary. */
  #lastFeedback(subtaskId: string): string | undefined {
    const last = this.#o.store
      .query({ taskId: subtaskId, typePrefix: 'task.result' })
      .map((e) => e.envelope.data as SummaryPacket)
      .at(-1);
    return last && last.outcome !== 'completed' ? last.summary.slice(0, 1000) : undefined;
  }

  /** After a failed run: retry (a restart does not count) or fail the sub-task for good. */
  #afterFailure(subtaskId: string): void {
    const failed = [...this.#sessions().values()].filter(
      (s) => s.taskId === subtaskId && (s.ended === 'failed' || s.ended === 'stuck'),
    ).length;
    const max = this.#o.config.workers?.max_attempts ?? 3;
    if (failed >= max) {
      this.#o.store.append(
        this.#env(subtaskId, 'task.status', {
          state: 'failed',
          message: `failed after ${failed} attempts`,
        }),
      );
    }
    this.#kick();
  }

  async #end(
    run: Run,
    reason: 'finished' | 'failed' | 'restart' | 'stuck' | 'canceled',
    message?: string,
  ): Promise<void> {
    if (this.#runs.get(run.subtaskId) !== run) return;
    this.#runs.delete(run.subtaskId);
    run.revoke();
    const worker = this.#o.adapters[run.adapterId];
    await worker?.adapter.close(run.handle).catch((err: unknown) => this.#errors.push(err));
    this.#o.store.append(
      this.#env(
        run.subtaskId,
        'worker.ended',
        { sessionId: run.sessionId, reason, ...(message ? { message } : {}) },
        run.sessionId,
      ),
    );
  }

  // ---- escalation answers ----------------------------------------------------------------

  #escalations(
    taskId: string,
  ): { id: string; sessionId?: string; resolved: boolean; answer?: string; delivered: boolean }[] {
    const out = new Map<
      string,
      { id: string; sessionId?: string; resolved: boolean; answer?: string; delivered: boolean }
    >();
    for (const { envelope: e } of this.#o.store.query({ taskId, typePrefix: 'escalation' })) {
      const d = e.data as { id?: string; escalationId?: string; answer?: string };
      if (e.type === 'escalation.raised' && d.id) {
        out.set(d.id, {
          id: d.id,
          ...(e.sessionId ? { sessionId: e.sessionId } : {}),
          resolved: false,
          delivered: false,
        });
      } else if (e.type === 'escalation.resolved' && d.escalationId) {
        const x = out.get(d.escalationId);
        if (x) {
          x.resolved = true;
          if (d.answer !== undefined) x.answer = d.answer;
        }
      } else if (e.type === 'escalation.delivered' && d.escalationId) {
        const x = out.get(d.escalationId);
        if (x) x.delivered = true;
      }
    }
    return [...out.values()];
  }

  /**
   * Send answered escalations to the Worker that asked, as its next message, once each
   * (`escalation.delivered`). An answer that arrives while the Worker's session is gone (a
   * restart) is delivered when the sub-task runs again.
   */
  async #deliverAnswers(): Promise<void> {
    for (const run of this.#runs.values()) {
      const undelivered = this.#escalations(run.subtaskId).filter(
        (x) => x.resolved && !x.delivered && x.answer !== undefined,
      );
      if (undelivered.length === 0) continue;
      const worker = this.#o.adapters[run.adapterId];
      if (!worker) continue;
      this.#o.store.append([
        ...undelivered.map((x) =>
          this.#env(
            run.subtaskId,
            'escalation.delivered',
            { escalationId: x.id, sessionId: run.sessionId },
            run.sessionId,
          ),
        ),
        ...(this.#tasks()[run.subtaskId]?.state === 'input_required'
          ? [this.#env(run.subtaskId, 'task.status', { state: 'working' })]
          : []),
      ]);
      await worker.adapter.send(run.handle, {
        text: undelivered.map((x) => `Answer to your escalation ${x.id}: ${x.answer}`).join('\n'),
      });
    }
    // Sub-tasks waiting on an answer whose session is gone run again once it is answered.
    for (const v of Object.values(this.#tasks())) {
      if (v.state !== 'input_required' || this.#runs.has(v.task.id)) continue;
      const open = this.#escalations(v.task.id).filter((x) => !x.resolved);
      if (open.length === 0)
        this.#o.store.append(this.#env(v.task.id, 'task.status', { state: 'working' }));
    }
  }

  // ---- event log -------------------------------------------------------------------------

  #tasks(): Record<string, TaskView> {
    return this.#o.store.replay(tasksProjection).tasks;
  }

  #sessions(): Map<string, SessionRecord> {
    const out = new Map<string, SessionRecord>();
    for (const { envelope: e } of this.#o.store.query({ typePrefix: 'worker' })) {
      const d = e.data as Record<string, unknown>;
      const id = typeof d.sessionId === 'string' ? d.sessionId : undefined;
      if (!id || !e.taskId) continue;
      if (e.type === 'worker.started') {
        out.set(id, {
          sessionId: id,
          taskId: e.taskId,
          attempt: typeof d.attempt === 'number' ? d.attempt : 1,
          ...(typeof d.adapter === 'string' ? { adapter: d.adapter } : {}),
          ...(typeof d.model === 'string' ? { model: d.model } : {}),
          ...(typeof d.workspaceId === 'string' ? { workspaceId: d.workspaceId } : {}),
        });
      } else {
        const s = out.get(id);
        if (!s) continue;
        if (e.type === 'worker.vendor_session' && typeof d.vendorSessionId === 'string') {
          s.vendorSessionId = d.vendorSessionId;
        } else if (e.type === 'worker.ended') {
          s.ended = typeof d.reason === 'string' ? d.reason : 'failed';
        }
      }
    }
    return out;
  }

  #env(taskId: string, type: string, data: unknown, sessionId?: string): EventEnvelope {
    const now = this.#now();
    return {
      v: 1,
      id: newUlid(now.getTime()),
      ts: now.toISOString(),
      source: { kind: 'mini', id: this.#o.miniId ?? 'mini' },
      ...(this.#o.repo !== undefined ? { repo: this.#o.repo } : {}),
      taskId,
      ...(sessionId !== undefined ? { sessionId } : {}),
      type,
      data,
    } as EventEnvelope;
  }

  #now(): Date {
    return this.#o.now?.() ?? new Date();
  }

  // ---- single instance -------------------------------------------------------------------

  #lock(): void {
    const path = this.#o.lockPath;
    if (HELD_LOCKS.has(path)) {
      throw new Error(`another Mini-conductor (pid ${process.pid}) is running for this repo`);
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(path, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
      HELD_LOCKS.add(path);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const pid = Number.parseInt(readFileSync(path, 'utf8'), 10);
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && alive(pid)) {
      throw new Error(`another Mini-conductor (pid ${pid}) is running for this repo`);
    }
    // A stale lock from a process that is gone (or from this process, not held any more).
    rmSync(path, { force: true });
    writeFileSync(path, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
    HELD_LOCKS.add(path);
  }

  #unlock(): void {
    if (!HELD_LOCKS.delete(this.#o.lockPath)) return;
    rmSync(this.#o.lockPath, { force: true });
  }
}

/**
 * Whether an approval request is for one of the Mini-conductor's own MCP tools: Claude Code names
 * them `mcp__<server>__<tool>`; Codex asks through an MCP elicitation that names the server
 * (`serverName`, required in 0.167.0's McpServerElicitationRequestParams).
 */
export function isOwnMcpTool(
  e: { toolName?: string | undefined; requestedGrant?: unknown },
  serverName: string,
): boolean {
  if (e.toolName?.startsWith(`mcp__${serverName}__`)) return true;
  const grant = e.requestedGrant as { serverName?: unknown } | undefined;
  return e.toolName === 'mcp_elicitation' && grant?.serverName === serverName;
}

/** Lock files held by Mini-conductors in this process. */
const HELD_LOCKS = new Set<string>();

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
