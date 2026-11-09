import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  type AgentEvent,
  type Decision,
  type EventEnvelope,
  newUlid,
  type Priority,
  redactSecrets,
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
  type VerificationStatus,
} from '@tacet/core';
import type { EventStore } from '@tacet/core/node';
import { TOOL_NAMES } from '../mcp/tools.js';
import {
  type Integrator,
  type Planner,
  type Verifier,
  type WorkerAdapter,
  type WorkerMcp,
  type Workspace,
  type Workspaces,
  WorktreeRefusedError,
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
  /** Brings Worker commits into the repo after each finished turn (#119). Default: none. */
  integrator?: Integrator;
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
  workspaceId?: string;
  vendorSessionId?: string;
  ended?: string;
  /** Its checkout failed the integrity checks: never reuse it. */
  refused?: boolean;
}

interface EscalationRecord {
  id: string;
  taskId: string;
  sessionId?: string;
  resolved: boolean;
  answer?: string;
  decisionId?: string;
  delivered: boolean;
}

/** One consistent reading of the log, rebuilt only when the log has grown. */
interface View {
  count: number;
  tasks: Record<string, TaskView>;
  sessions: Map<string, SessionRecord>;
  kinds: Map<string, string>;
  escalations: Map<string, EscalationRecord>;
  decisions: Map<string, string>;
  progress: Map<string, string>;
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
  /** The Worker's commit, once integrated into the repo. */
  commit?: string;
  /** A turn is running: answers wait until it ends. */
  turnActive: boolean;
  /** The turn's end is being handled, so it is handled once. */
  settling: boolean;
}

const TERMINAL: ReadonlySet<TaskState> = new Set(['completed', 'failed', 'canceled', 'rejected']);
/** Sub-task states the parent mirrors while no sub-task failed for good (ADR-003 §4). */
const WAITING: ReadonlySet<TaskState> = new Set(['input_required', 'auth_required']);
const COUNTED: ReadonlySet<string> = new Set(['failed', 'stuck']);

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
  /** Background work (plans, Worker event loops) that `stop()` waits for. */
  readonly #inflight = new Set<Promise<unknown>>();
  #timer: NodeJS.Timeout | undefined;
  #abort = new AbortController();
  /** Bumped by start and stop; work started under an older generation drops its result. */
  #gen = 0;
  #started = false;
  #ticking: Promise<void> = Promise.resolve();
  #view: View | undefined;
  readonly #errors: unknown[] = [];

  constructor(opts: MiniConductorOptions) {
    for (const [id, w] of Object.entries(opts.adapters)) {
      // The label must match what the adapter itself reports, where it reports one.
      const own = (w.adapter as { authRoute?: unknown }).authRoute;
      if (w.authRoute !== 'api_key' || (own !== undefined && own !== 'api_key')) {
        throw new Error(
          `adapter ${id}: Workers run unattended and must use the api_key route (#65)`,
        );
      }
    }
    const worker = opts.config.tiers?.worker;
    if (!worker) throw new Error('config has no tiers.worker');
    for (const tier of [worker, opts.config.tiers?.review]) {
      if (tier && !opts.adapters[tier.adapter]) {
        throw new Error(`no Worker adapter ${tier.adapter} for its tier`);
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
    this.#gen += 1;
    this.#abort = new AbortController();
    const v = this.#state();
    // Sessions without `worker.ended` belonged to a Mini-conductor that stopped without closing
    // them (a crash): they are gone now. Recording that is what lets their sub-tasks resume.
    const ended: EventEnvelope[] = [];
    for (const s of v.sessions.values()) {
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
    // A login problem may be fixed by now: try those sub-tasks again.
    for (const t of Object.values(v.tasks)) {
      if (t.task.parentId && t.state === 'auth_required') {
        ended.push(
          this.#env(t.task.id, 'task.status', {
            state: 'working',
            message: 'retrying after a restart',
          }),
        );
      }
    }
    if (ended.length > 0) this.#o.store.append(ended);
    for (const t of Object.values(v.tasks)) {
      if (!t.task.parentId && !TERMINAL.has(t.state) && t.plan === undefined) this.#plan(t.task);
    }
    this.#timer = setInterval(() => this.#kick(), this.#o.pollMs ?? 1000);
    this.#timer.unref();
    this.#kick();
  }

  /** Accept a task. Returns its id; planning and scheduling continue in the background. */
  submit(input: Omit<TaskInput, 'id' | 'createdAt' | 'parentId'> & { id?: string }): string {
    if (!this.#started) throw new Error('call start() first');
    if ('parentId' in input) throw new Error('sub-tasks are created by the Mini-conductor');
    const id = input.id ?? newUlid(this.#now().getTime());
    // `/` separates a task from its sub-tasks, so ids never collide.
    if (id.includes('/')) throw new Error('task ids must not contain "/"');
    if (this.#state().tasks[id]) throw new Error(`task ${id} already exists`);
    const task = { ...input, id, createdAt: this.#now().toISOString() };
    this.#o.store.append(this.#env(id, 'task.created', task));
    const view = this.#state().tasks[id];
    if (view) this.#plan(view.task);
    return id;
  }

  /**
   * Wait until there is nothing left to do now: nothing planning or running, nothing ready to
   * start, no answer waiting to be delivered and no result waiting to be rolled up.
   */
  async settled(timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await this.#ticking;
      const busy = [...this.#runs.values()].some((r) => r.settling || r.turnActive);
      // Idle sessions waiting on a person's answer do not count: there is nothing to do now.
      if (!busy && this.#planning.size === 0 && !this.#hasWork()) return;
      if (Date.now() > deadline) {
        throw new Error('timed out waiting for the Mini-conductor to settle');
      }
      await new Promise((r) => setTimeout(r, 20));
      this.#kick();
    }
  }

  /**
   * Stop: close every Worker session, recorded as `restart` so the next `start()` resumes it,
   * wait for background work, and release the lock.
   */
  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#started = false;
    this.#gen += 1;
    this.#abort.abort();
    if (this.#timer) clearInterval(this.#timer);
    await this.#ticking;
    await Promise.all([...this.#runs.values()].map((r) => this.#end(r, 'restart')));
    await Promise.allSettled([...this.#inflight]);
    this.#unlock();
  }

  /**
   * @internal Tests only: abandon everything without recording it, as a crash would. Sessions
   * are left to the adapter; nothing more is written to the log by this instance.
   */
  crashForTest(): void {
    this.#started = false;
    this.#gen += 1;
    this.#abort.abort();
    if (this.#timer) clearInterval(this.#timer);
    this.#runs.clear();
    this.#unlock();
  }

  #live(gen: number): boolean {
    return this.#started && gen === this.#gen;
  }

  #track<T>(p: Promise<T>): void {
    const tracked = p
      .catch((err: unknown) => this.#errors.push(err))
      .finally(() => {
        this.#inflight.delete(tracked);
      });
    this.#inflight.add(tracked);
  }

  // ---- planning --------------------------------------------------------------------------

  #plan(task: Task): void {
    if (this.#planning.has(task.id)) return;
    this.#planning.add(task.id);
    const gen = this.#gen;
    this.#track(
      (async () => {
        try {
          const proposal = await this.#o.planner.plan(task, { signal: this.#abort.signal });
          if (!this.#live(gen)) return;
          const idOf = new Map(proposal.subtasks.map((s, i) => [s.key, `${task.id}/${i + 1}`]));
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
          const now = this.#now().toISOString();
          // One batch: a crash leaves either no plan (re-planned on start) or the whole plan.
          this.#o.store.append([
            ...(proposal.usage
              ? [
                  this.#env(task.id, 'agent.usage', {
                    t: 'usage',
                    source: 'reported',
                    ...proposal.usage,
                  }),
                ]
              : []),
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
          if (!this.#live(gen)) return;
          this.#errors.push(err);
          this.#o.store.append(
            this.#env(task.id, 'task.status', {
              state: 'failed',
              message: redactSecrets(`planning failed: ${(err as Error).message}`),
            }),
          );
        } finally {
          this.#planning.delete(task.id);
          this.#kick();
        }
      })(),
    );
  }

  // ---- scheduling ------------------------------------------------------------------------

  #kick(): void {
    if (!this.#started) return;
    const gen = this.#gen;
    this.#ticking = this.#ticking
      .then(() => (this.#live(gen) ? this.#tick(gen) : undefined))
      .catch((err) => {
        this.#errors.push(err);
      });
  }

  async #tick(gen: number): Promise<void> {
    for (const run of [...this.#runs.values()]) {
      if (!this.#live(gen)) return;
      await this.#deliverAnswers(run);
    }
    this.#failBlocked();
    this.#rollUp();
    for (const id of this.#ready()) {
      if (!this.#live(gen)) return;
      // One sub-task that cannot start must not hold up the others, nor be retried every tick.
      await this.#run(id, gen).catch((err: unknown) => {
        this.#errors.push(err);
        this.#o.store.append(
          this.#env(id, 'task.status', {
            state: 'failed',
            message: redactSecrets(`could not start a Worker: ${(err as Error).message}`),
          }),
        );
      });
    }
  }

  /** Is there something the next tick would do? */
  #hasWork(): boolean {
    const v = this.#state();
    if (this.#ready().length > 0 || blockedByFailure(this.#schedulable()).length > 0) return true;
    if (this.#parentUpdates(v).length > 0) return true;
    return [...this.#runs.values()].some((r) => this.#undelivered(r.subtaskId).length > 0);
  }

  /** Sub-tasks of open tasks, as the scheduler sees them. */
  #schedulable(): SchedulableSubtask[] {
    const { tasks, kinds } = this.#state();
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
          adapter: this.#tierFor(kinds.get(p.id)).adapter,
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
    if (v.state === 'input_required') {
      // With no session open and every escalation answered, it runs again; the answers go into
      // the first message of the new session.
      const open = [...this.#state().escalations.values()].some(
        (x) => x.taskId === v.task.id && !x.resolved,
      );
      return open ? 'blocked' : 'pending';
    }
    if (WAITING.has(v.state)) return 'blocked';
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

  #tierFor(kind: string | undefined): { adapter: string; model?: string; effort?: string } {
    const tiers = this.#o.config.tiers ?? {};
    const tier = (kind === 'review' ? tiers.review : undefined) ?? tiers.worker;
    if (!tier) throw new Error('config has no tiers.worker');
    return {
      adapter: tier.adapter,
      model: tier.model,
      ...(tier.effort !== undefined ? { effort: tier.effort } : {}),
    };
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

  /**
   * What each open parent task should be now: done when every sub-task completed, failed when
   * one failed for good and nothing else can run, waiting (input or auth) while a sub-task waits
   * on the user, otherwise working.
   */
  #parentUpdates(v: View): { parent: TaskView; subs: TaskView[]; state: TaskState }[] {
    const out: { parent: TaskView; subs: TaskView[]; state: TaskState }[] = [];
    for (const parent of Object.values(v.tasks)) {
      if (parent.task.parentId || !parent.plan || TERMINAL.has(parent.state)) continue;
      const subs = parent.plan
        .map((p) => v.tasks[p.id])
        .filter((t): t is TaskView => t !== undefined);
      if (subs.length !== parent.plan.length) continue;
      let state: TaskState;
      if (subs.every((t) => t.state === 'completed')) state = 'completed';
      else if (subs.every((t) => TERMINAL.has(t.state))) state = 'failed';
      else state = subs.find((t) => WAITING.has(t.state))?.state ?? 'working';
      if (state !== parent.state) out.push({ parent, subs, state });
    }
    return out;
  }

  #rollUp(): void {
    const v = this.#state();
    for (const { parent, subs, state } of this.#parentUpdates(v)) {
      if (!TERMINAL.has(state)) {
        this.#o.store.append(this.#env(parent.task.id, 'task.status', { state }));
        continue;
      }
      // The latest result of each sub-task, not earlier failed attempts.
      const results = subs
        .map((t) =>
          this.#o.store
            .query({ taskId: t.task.id, typePrefix: 'task.result' })
            .map((e) => e.envelope.data as SummaryPacket)
            .at(-1),
        )
        .filter((r): r is SummaryPacket => r !== undefined);
      const done = state === 'completed';
      const statuses = results.map((r) => r.verification?.status);
      const verification: VerificationStatus =
        !done || statuses.includes('failed')
          ? 'failed'
          : statuses.some((s) => s !== 'passed')
            ? 'not_run'
            : 'passed';
      const failed = subs.filter((t) => t.state !== 'completed').length;
      const summary: SummaryPacket = {
        v: 1,
        taskId: parent.task.id,
        createdAt: this.#now().toISOString(),
        outcome: done ? 'completed' : 'failed',
        summary: subs.map((t) => `${t.task.id} ${t.state}: ${t.task.goal}`).join('\n'),
        filesTouched: [...new Set(results.flatMap((r) => r.filesTouched ?? []))],
        commits: [...new Set(results.flatMap((r) => r.commits ?? []))],
        verification: {
          status: verification,
          commands: [...new Set(results.flatMap((r) => r.verification?.commands ?? []))],
        },
        openQuestions: results.flatMap((r) => r.openQuestions ?? []),
      };
      this.#o.store.append([
        this.#env(parent.task.id, 'task.result', summary),
        this.#env(parent.task.id, 'task.status', {
          state,
          ...(done ? {} : { message: `${failed} sub-task(s) failed` }),
        }),
      ]);
    }
  }

  // ---- Workers ---------------------------------------------------------------------------

  async #run(subtaskId: string, gen: number): Promise<void> {
    if (this.#runs.has(subtaskId) || !this.#live(gen)) return;
    const v = this.#state();
    const view = v.tasks[subtaskId];
    if (!view) return;
    const history = [...v.sessions.values()].filter((s) => s.taskId === subtaskId);
    const failed = history.filter((s) => s.ended !== undefined && COUNTED.has(s.ended)).length;
    const maxAttempts = this.#o.config.workers?.max_attempts ?? 3;
    // A crash after the last failed attempt but before the terminal status: finish it now.
    if (failed >= maxAttempts) {
      this.#o.store.append(
        this.#env(subtaskId, 'task.status', {
          state: 'failed',
          message: `failed after ${failed} attempts`,
        }),
      );
      return;
    }
    const tier = this.#tierFor(v.kinds.get(subtaskId));
    const worker = this.#o.adapters[tier.adapter] as WorkerAdapter;
    const last = history.at(-1);
    // Reuse the checkout of an earlier run: a restart or a retry continues the same work.
    // Never one whose checkout failed the integrity checks: that run gets a fresh checkout.
    const existing =
      last?.workspaceId && !last.refused
        ? await this.#o.workspaces.get(last.workspaceId)
        : undefined;
    const sessionId = randomUUID();
    // A new checkout is named after the session that first uses it, so a sub-task that needs a
    // fresh one (its last failed the integrity checks) never collides with its old one.
    const workspace = existing ?? (await this.#o.workspaces.create(sessionId));
    if (!this.#live(gen)) return;
    const resume =
      last?.ended === 'restart' &&
      last.vendorSessionId !== undefined &&
      last.adapter === tier.adapter &&
      existing !== undefined &&
      worker.adapter.capabilities().resume
        ? { vendorSessionId: last.vendorSessionId }
        : undefined;
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
    let revoke = () => {};
    let mcpServerName = '';
    let handle: SessionHandle;
    try {
      const minted = this.#o.mcp.workerConfig({ workerSessionId: sessionId, taskId: subtaskId });
      revoke = minted.revoke;
      mcpServerName = minted.config.name;
      handle = await worker.adapter.start({
        cwd: workspace.path,
        systemPrompt: WORKER_SYSTEM_PROMPT,
        mcpServers: [minted.config],
        ...(tier.model !== undefined ? { model: tier.model } : {}),
        ...(tier.effort !== undefined ? { effort: tier.effort } : {}),
        ...(resume ? { resume } : {}),
      });
    } catch (err) {
      revoke();
      if (!this.#live(gen)) return;
      this.#errors.push(err);
      this.#o.store.append(
        this.#env(
          subtaskId,
          'worker.ended',
          { sessionId, reason: 'failed', message: redactSecrets((err as Error).message) },
          sessionId,
        ),
      );
      this.#afterFailure(subtaskId);
      return;
    }
    if (!this.#live(gen)) {
      // Stopped while the session started: give it back without registering it.
      revoke();
      await worker.adapter.close(handle).catch(() => {});
      return;
    }
    const run: Run = {
      sessionId,
      subtaskId,
      adapterId: tier.adapter,
      handle,
      workspace,
      revoke,
      mcpServerName,
      text: '',
      turnActive: true,
      settling: false,
    };
    this.#runs.set(subtaskId, run);
    this.#noteVendorSession(run);
    this.#track(this.#consume(run, worker, gen));
    // Answers that came while no session was open go into the first message.
    const answers = this.#undelivered(subtaskId);
    const text = resume
      ? [RESUME_PROMPT, ...answers.map(answerText)].join('\n\n')
      : workerPrompt(view.task, this.#lastFeedback(subtaskId), [
          ...(history.length > 0 && v.progress.has(subtaskId)
            ? [`Progress reported before: ${v.progress.get(subtaskId)}`]
            : []),
          ...answers.map(answerText),
        ]);
    try {
      await worker.adapter.send(handle, { text });
      if (this.#live(gen)) this.#markDelivered(run, answers);
    } catch (err) {
      if (!this.#live(gen)) return;
      this.#errors.push(err);
      await this.#end(run, 'failed', `could not send the first message: ${(err as Error).message}`);
      this.#afterFailure(subtaskId);
    }
  }

  #noteVendorSession(run: Run): void {
    const v = run.handle.vendorSessionId;
    if (v === undefined || this.#runs.get(run.subtaskId) !== run) return;
    if (this.#state().sessions.get(run.sessionId)?.vendorSessionId === v) return;
    this.#o.store.append(
      this.#env(
        run.subtaskId,
        'worker.vendor_session',
        { sessionId: run.sessionId, vendorSessionId: v },
        run.sessionId,
      ),
    );
  }

  async #consume(run: Run, worker: WorkerAdapter, gen: number): Promise<void> {
    let started = false;
    try {
      for await (const e of worker.adapter.events(run.handle)) {
        if (this.#runs.get(run.subtaskId) !== run || !this.#live(gen)) return;
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
          if (e.state === 'running') {
            started = true;
            run.turnActive = true;
          } else if (e.state === 'idle') {
            // Only the idle that ends a turn counts: adapters also report idle when they start.
            if (started) {
              started = false;
              run.turnActive = false;
              this.#noteVendorSession(run);
              await this.#turnEnded(run);
            }
          } else if (e.state === 'auth_required') {
            // A login problem, not a failed attempt: the user has to fix it (ADR-003 §4).
            this.#o.store.append(
              this.#env(run.subtaskId, 'task.status', {
                state: 'auth_required',
                message: 'the Worker adapter needs valid credentials',
              }),
            );
            await this.#end(run, 'canceled', 'auth required');
            return;
          } else if (e.state === 'error' || e.state === 'done') {
            await this.#end(run, 'failed', redactSecrets(e.message ?? `session ${e.state}`));
            this.#afterFailure(run.subtaskId);
            return;
          }
        }
      }
    } catch (err) {
      this.#errors.push(err);
    } finally {
      // However the event stream ended, a run still registered is over: free its slot and token.
      if (this.#runs.get(run.subtaskId) === run && this.#live(gen)) {
        await this.#end(run, 'failed', 'the Worker session ended unexpectedly');
        this.#afterFailure(run.subtaskId);
      }
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
    if (run.settling || !this.#started) return;
    run.settling = true;
    let ended = false;
    try {
      // An answer that came while the turn ran: deliver it now and keep the session.
      if (this.#undelivered(run.subtaskId).length > 0) {
        run.settling = false;
        await this.#deliverAnswers(run);
        return;
      }
      const open = [...this.#state().escalations.values()].filter(
        (x) => x.taskId === run.subtaskId && !x.resolved,
      );
      if (open.length > 0) {
        // Waiting on a person can take long: bring the commits in now, so the repo's gc and fsck
        // keep working meanwhile. A failure here is logged, not counted.
        if (!(await this.#integrate(run, { bestEffort: true }))) {
          ended = true;
          return;
        }
        this.#o.store.append(this.#env(run.subtaskId, 'task.status', { state: 'input_required' }));
        return;
      }
      const view = this.#state().tasks[run.subtaskId];
      if (!view) return;
      // The Worker's commits come into the repo before its work is verified or built on.
      if (!(await this.#integrate(run))) {
        ended = true;
        return;
      }
      const verification = await (this.#o.verifier ?? this.#defaultVerifier()).verify(
        view.task,
        run.workspace,
      );
      if (this.#runs.get(run.subtaskId) !== run || !this.#started) return;
      if (verification.status === 'failed') {
        this.#o.store.append(
          this.#env(run.subtaskId, 'task.result', this.#summary(run, 'failed', verification)),
        );
        ended = true;
        await this.#end(run, 'failed', 'verification failed');
        this.#afterFailure(run.subtaskId);
        return;
      }
      this.#o.store.append([
        this.#env(run.subtaskId, 'task.result', this.#summary(run, 'completed', verification)),
        this.#env(run.subtaskId, 'task.status', { state: 'completed' }),
      ]);
      // Roll up and schedule dependents while the session closes.
      this.#kick();
      ended = true;
      await this.#end(run, 'finished');
    } finally {
      if (!ended) run.settling = false;
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
      summary: text ? redactSecrets(text.slice(-2000)) : `Worker turn ended (${outcome}).`,
      filesTouched: [],
      commits: run.commit ? [run.commit] : [],
      verification,
      openQuestions: [],
    };
  }

  /**
   * Integrate the run's commits (#119). False when the run had to end: its checkout failed the
   * integrity checks (the user is asked; nothing ran in it) or integration failed (a failed
   * attempt).
   */
  async #integrate(run: Run, opts: { bestEffort?: boolean } = {}): Promise<boolean> {
    const integrator = this.#o.integrator;
    if (!integrator) return true;
    try {
      const result = await integrator.integrate(run.subtaskId, run.workspace);
      if (result && this.#runs.get(run.subtaskId) === run && run.commit !== result.commit) {
        run.commit = result.commit;
        this.#o.store.append(
          this.#env(
            run.subtaskId,
            'worker.integrated',
            { sessionId: run.sessionId, ...result },
            run.sessionId,
          ),
        );
      }
      return true;
    } catch (err) {
      this.#errors.push(err);
      if (err instanceof WorktreeRefusedError) {
        // Paths stay out: escalations go up to the Conductor. The workspace is named by id.
        this.#o.store.append([
          this.#env(run.subtaskId, 'escalation.raised', {
            id: newUlid(this.#now().getTime()),
            taskId: run.subtaskId,
            question: `The Worker's checkout ${run.workspace.id} for ${run.subtaskId} failed its integrity checks, so nothing was run in it. Inspect it; when you answer, the sub-task runs again in a fresh checkout.`,
            urgency: 'high',
            createdAt: this.#now().toISOString(),
            status: 'pending',
          }),
          this.#env(run.subtaskId, 'task.status', { state: 'input_required' }),
        ]);
        await this.#end(run, 'canceled', 'checkout failed its integrity checks', {
          workspaceRefused: true,
        });
        return false;
      }
      if (opts.bestEffort) return true;
      this.#o.store.append(
        this.#env(
          run.subtaskId,
          'task.result',
          this.#summary(run, 'failed', {
            status: 'failed',
            commands: [],
            notes: `integrating the Worker's commits failed: ${redactSecrets((err as Error).message)}`,
          }),
        ),
      );
      await this.#end(run, 'failed', 'integration failed');
      this.#afterFailure(run.subtaskId);
      return false;
    }
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
    const failed = [...this.#state().sessions.values()].filter(
      (s) => s.taskId === subtaskId && s.ended !== undefined && COUNTED.has(s.ended),
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
    extra: { workspaceRefused?: boolean } = {},
  ): Promise<void> {
    if (this.#runs.get(run.subtaskId) !== run) return;
    this.#runs.delete(run.subtaskId);
    run.revoke();
    this.#o.store.append(
      this.#env(
        run.subtaskId,
        'worker.ended',
        { sessionId: run.sessionId, reason, ...(message ? { message } : {}), ...extra },
        run.sessionId,
      ),
    );
    await this.#o.adapters[run.adapterId]?.adapter
      .close(run.handle)
      .catch((err: unknown) => this.#errors.push(err));
  }

  // ---- escalation answers ----------------------------------------------------------------

  /** Answered escalations of a sub-task that its Worker has not been sent yet. */
  #undelivered(subtaskId: string): EscalationRecord[] {
    return [...this.#state().escalations.values()].filter(
      (x) => x.taskId === subtaskId && x.resolved && !x.delivered,
    );
  }

  /**
   * Send answered escalations to the sub-task's Worker as its next message, between turns only,
   * and record each as delivered once the message is sent.
   */
  async #deliverAnswers(run: Run): Promise<void> {
    if (run.turnActive || run.settling || this.#runs.get(run.subtaskId) !== run) return;
    const answers = this.#undelivered(run.subtaskId);
    if (answers.length === 0) return;
    const worker = this.#o.adapters[run.adapterId];
    if (!worker) return;
    run.turnActive = true;
    try {
      await worker.adapter.send(run.handle, { text: answers.map(answerText).join('\n') });
    } catch (err) {
      run.turnActive = false;
      this.#errors.push(err);
      return;
    }
    this.#markDelivered(run, answers);
  }

  #markDelivered(run: Run, answers: EscalationRecord[]): void {
    if (answers.length === 0) return;
    const waiting = this.#state().tasks[run.subtaskId]?.state === 'input_required';
    this.#o.store.append([
      ...answers.map((x) =>
        this.#env(
          run.subtaskId,
          'escalation.delivered',
          { escalationId: x.id, sessionId: run.sessionId },
          run.sessionId,
        ),
      ),
      ...(waiting ? [this.#env(run.subtaskId, 'task.status', { state: 'working' })] : []),
    ]);
  }

  // ---- event log -------------------------------------------------------------------------

  /** The current reading of the log, rebuilt only when it has grown. */
  #state(): View {
    const count = this.#o.store.count();
    if (this.#view && this.#view.count === count) return this.#view;
    const tasks = this.#o.store.replay(tasksProjection).tasks;
    const sessions = new Map<string, SessionRecord>();
    const kinds = new Map<string, string>();
    const escalations = new Map<string, EscalationRecord>();
    const decisions = new Map<string, string>();
    const progress = new Map<string, string>();
    for (const { envelope: e } of this.#o.store.query({})) {
      const d = (e.data ?? {}) as Record<string, unknown>;
      const str = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : undefined);
      if (e.type.startsWith('worker.')) {
        const id = str('sessionId');
        if (!id || !e.taskId) continue;
        if (e.type === 'worker.started') {
          const adapter = str('adapter');
          const workspaceId = str('workspaceId');
          sessions.set(id, {
            sessionId: id,
            taskId: e.taskId,
            ...(adapter ? { adapter } : {}),
            ...(workspaceId ? { workspaceId } : {}),
          });
        } else {
          const s = sessions.get(id);
          if (!s) continue;
          const vendor = str('vendorSessionId');
          if (e.type === 'worker.vendor_session' && vendor) s.vendorSessionId = vendor;
          else if (e.type === 'worker.ended') {
            s.ended = str('reason') ?? 'failed';
            if (d.workspaceRefused === true) s.refused = true;
          } else if (e.type === 'worker.progress') {
            const summary = str('summary') ?? str('message');
            if (summary) progress.set(e.taskId, summary);
          }
        }
      } else if (e.type === 'task.planned') {
        const plan = TaskPlan.safeParse(e.data);
        if (plan.success) for (const s of plan.data.subtasks) kinds.set(s.id, s.kind);
      } else if (e.type === 'escalation.raised') {
        const id = str('id');
        if (id && e.taskId) {
          escalations.set(id, {
            id,
            taskId: e.taskId,
            ...(e.sessionId ? { sessionId: e.sessionId } : {}),
            resolved: false,
            delivered: false,
          });
        }
      } else if (e.type === 'escalation.resolved') {
        const x = escalations.get(str('escalationId') ?? '');
        if (x) {
          x.resolved = true;
          const answer = str('answer');
          const decisionId = str('decisionId');
          if (answer !== undefined) x.answer = answer;
          if (decisionId !== undefined) x.decisionId = decisionId;
        }
      } else if (e.type === 'escalation.delivered') {
        const x = escalations.get(str('escalationId') ?? '');
        if (x) x.delivered = true;
      } else if (e.type === 'decision.recorded') {
        const dec = d as Partial<Decision>;
        if (typeof dec.id === 'string' && typeof dec.decision === 'string') {
          decisions.set(dec.id, dec.decision);
        }
      }
    }
    // An answer given as a recorded decision (ADR-003 §4 DecisionExt) carries its text there.
    for (const x of escalations.values()) {
      if (x.answer === undefined && x.decisionId) {
        const text = decisions.get(x.decisionId);
        if (text !== undefined) x.answer = text;
      }
    }
    this.#view = { count, tasks, sessions, kinds, escalations, decisions, progress };
    return this.#view;
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
      throw new Error('a Mini-conductor in this process is already running for this repo');
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        writeFileSync(path, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
        HELD_LOCKS.add(path);
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      // Take a stale lock over by renaming it away first: of two processes doing this at once,
      // only one rename succeeds, and the loser retries against the winner's new lock.
      const aside = `${path}.${process.pid}.${randomUUID()}.stale`;
      try {
        renameSync(path, aside);
      } catch {
        continue;
      }
      const pid = Number.parseInt(readFileSync(aside, 'utf8'), 10);
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && alive(pid)) {
        // Not stale after all: put it back and refuse.
        try {
          renameSync(aside, path);
        } catch {
          rmSync(aside, { force: true });
        }
        throw new Error(`another Mini-conductor (pid ${pid}) is running for this repo`);
      }
      rmSync(aside, { force: true });
    }
    throw new Error('could not take the Mini-conductor lock');
  }

  #unlock(): void {
    if (!HELD_LOCKS.delete(this.#o.lockPath)) return;
    rmSync(this.#o.lockPath, { force: true });
  }
}

function answerText(x: EscalationRecord): string {
  return x.answer !== undefined
    ? `Answer to your escalation ${x.id}: ${x.answer}`
    : `Your escalation ${x.id} was resolved without an answer text; continue with your best judgement or escalate again.`;
}

/**
 * Whether an approval request is for one of the Mini-conductor's own MCP tools. Claude Code asks
 * before every MCP call and names the tool `mcp__<server>__<tool>`; only the exact names of the
 * Mini's tools on its own server match, so a server named `tacet_` or a tool named `tacet__x`
 * does not. Codex 0.167.0 calls a configured MCP server's tools without asking (verified live,
 * #17), so its MCP elicitations are refused like everything else.
 */
export function isOwnMcpTool(e: { toolName?: string | undefined }, serverName: string): boolean {
  return TOOL_NAMES.some((t) => e.toolName === `mcp__${serverName}__${t}`);
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
