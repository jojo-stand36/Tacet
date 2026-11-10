import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  type AgentEvent,
  type Decision,
  Escalation,
  type EventEnvelope,
  newUlid,
  type Priority,
  type ProfileField,
  redactSecrets,
  type SessionHandle,
  type SummaryPacket,
  type TacetConfig,
  type Task,
  type TaskInput,
  TaskPlan,
  type TaskState,
  type TaskView,
  type TierConfig,
  tasksProjection,
  type Verification,
  type VerificationStatus,
} from '@tacet/core';
import {
  type EventStore,
  endMarkedProcesses,
  isWorkerMarker,
  newWorkerMarker,
  WORKER_MARKER_VAR,
} from '@tacet/core/node';
import { TOOL_NAMES } from '../mcp/tools.js';
import { reviewFeedback } from '../review/adapter-reviewer.js';
import { reviewConfigProblem } from '../review/config.js';
import {
  type Integrator,
  MergeConflictError,
  type Planner,
  type Reviewer,
  type ReviewResult,
  type Verifier,
  type VerifyResult,
  type WorkerAdapter,
  type WorkerMcp,
  type Workspace,
  type Workspaces,
  WorktreeRefusedError,
  workerRefusal,
} from './ports.js';
import { afterRefusal, type ChosenProfile, chooseProfile } from './profile.js';
import { RESUME_PROMPT, safePrompt, WORKER_SYSTEM_PROMPT, workerPrompt } from './prompts.js';
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
  /**
   * Reviews each sub-task's integrated change after its commands pass, when `review.enabled`
   * (#19): an `AdapterReviewer` on `tiers.review`. Required when review is on.
   */
  reviewer?: Reviewer;
  /** Brings Worker commits into the repo after each finished turn (#119). Default: none. */
  integrator?: Integrator;
  mcp: WorkerMcp;
  /** Single-instance lock, e.g. `<repoStateDir>/mini.lock`. */
  lockPath: string;
  /**
   * Where the process markers of running Worker sessions are kept (0600), so a restarted
   * Mini-conductor can end what a crashed one left running (#127). Default `<lockPath>.workers`.
   */
  processFile?: string;
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
  /** The commit its checkout started at (#134). */
  baseCommit?: string;
}

interface EscalationRecord {
  id: string;
  taskId: string;
  sessionId?: string;
  /** The Mini-conductor's own escalations say what they are about here (#134). */
  contextRef?: string | undefined;
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
  /** Sub-tasks the planner marked indivisible (#110). */
  indivisible: Set<string>;
  escalations: Map<string, EscalationRecord>;
  decisions: Map<string, string>;
  progress: Map<string, string>;
  /** When each Worker session last reported progress (ms), for the heartbeat. */
  progressAt: Map<string, number>;
}

interface Run {
  sessionId: string;
  /** The commit its checkout started at (#134). */
  baseCommit?: string;
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
  /** Last sign of life from the Worker (ms): any event, or a progress report. */
  lastActivity: number;
  /** When it was nudged, if it has been silent since. */
  nudgedAt?: number | undefined;
  /** Tool calls that started and have not finished: a long test run is not a stuck Worker. */
  openTools: Map<string, number>;
  /** The latest progress report already counted (its timestamp). */
  progressSeen?: number | undefined;
  /** The turn's end is being handled, so it is handled once. */
  settling: boolean;
  /** Aborts a verification in progress when the session ends (#19). */
  verifyAbort?: AbortController | undefined;
}

/**
 * Whether `verify` commands run for Codex Workers (#19). Off until the owner decides: the
 * commands run code the Worker wrote outside the Codex sandbox, which keeps the shared `.git`
 * read-only for the Worker itself (ARCHITECTURE.md §6). Off, their sub-tasks are recorded as
 * not verified, with this reason.
 */
export const VERIFY_CODEX_WORKERS = false;
const CODEX_ADAPTERS: ReadonlySet<string> = new Set(['codex-app-server', 'acp:codex-acp']);
const CODEX_NOT_VERIFIED = 'codex verify pending sandbox decision';
/** The command name `worker.verification` records for a failure before any command ran. */
const CHECKOUT_CHECK = '(verification failed before any command)';

/**
 * A check's result with the reviewer's verdict folded in (#19). Blocking findings fail it, with
 * the findings as the Worker's feedback. A reviewer that gave no verdict turns `passed` into
 * `partial` (owner decision pending: block instead) and leaves `not_run` or `partial` as they
 * are; an approval turns commands `not_run` into `partial`.
 */
function withReview(v: VerifyResult, r: ReviewResult): VerifyResult {
  const blocking = r.findings.filter((f) => f.severity !== 'minor').length;
  const review = {
    status: r.status,
    adapter: r.adapter,
    ...(r.model !== undefined ? { model: r.model } : {}),
    blocking,
  };
  const notes = (extra: string) => (v.notes ? `${v.notes}\n${extra}` : extra);
  if (r.status === 'failed') {
    // Counts only: the findings' text goes to the Worker as its feedback, never into events or
    // up to the Conductor (coordinator requirement on #19).
    return {
      ...v,
      status: 'failed',
      notes: notes(
        `Review requested changes: ${blocking} blocking finding(s), ${r.findings.length - blocking} minor.`,
      ),
      feedback: reviewFeedback(r.findings),
      review,
    };
  }
  if (r.status === 'error') {
    return {
      ...v,
      status: v.status === 'passed' ? 'partial' : v.status,
      notes: notes(`Review did not finish: ${r.notes ?? 'no verdict'}.`),
      review,
    };
  }
  return { ...v, status: v.status === 'not_run' ? 'partial' : v.status, review };
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
  /** Process markers of Worker sessions that may be running, by session (#127). */
  readonly #markers = new Map<string, string>();
  /** Git errors combining a sub-task's dependencies, by sub-task (#134). */
  readonly #combineFailures = new Map<string, number>();
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
      const refused = workerRefusal(w);
      if (refused) throw new Error(`adapter ${id}: refused for Workers: ${refused}`);
    }
    const worker = opts.config.tiers?.worker;
    if (!worker) throw new Error('config has no tiers.worker');
    for (const tier of [worker, opts.config.tiers?.review]) {
      if (tier && !opts.adapters[tier.adapter]) {
        throw new Error(`no Worker adapter ${tier.adapter} for its tier`);
      }
    }
    const problem = reviewConfigProblem(opts.config);
    if (problem) throw new Error(problem);
    if (opts.config.review?.enabled && !opts.reviewer) {
      throw new Error('review.enabled: review is on but no reviewer was given');
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
    try {
      // Before anything resumes: a Worker a crashed predecessor left running would race it.
      await this.#endStaleWorkers();
    } catch (err) {
      this.#unlock();
      throw err;
    }
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
              ...(s.indivisible ? { indivisible: true } : {}),
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
    this.#checkHealth(gen);
    this.#failBlocked();
    await this.#rollUp(gen);
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

  /**
   * Worker health (#17, after Gas Town's Witness; ADR-001): one heartbeat per session, fed by
   * every adapter event and every `report_progress`. A Worker silent in the middle of a turn for
   * `stuck_after_s` is nudged; still silent `nudge_grace_s` later, its session is replaced (a
   * `stuck` attempt). A session between turns (waiting on an answer) is not judged; nor is one
   * inside a tool call, until the call has been open for `stuck_after_s + nudge_grace_s` (a hung
   * test watcher or editor prompt).
   *
   * The nudge is recorded, not sent: the Claude and Codex adapters queue input sent during a turn
   * as the next turn, so a hung Worker would never read it, and a slow one would start an extra
   * turn while its checkout is integrated and verified.
   */
  #checkHealth(gen: number): void {
    const w = this.#o.config.workers ?? {};
    const stuckMs = (w.stuck_after_s ?? 300) * 1000;
    const graceMs = (w.nudge_grace_s ?? 900) * 1000;
    const now = this.#now().getTime();
    const v = this.#state();
    for (const run of [...this.#runs.values()]) {
      if (!this.#live(gen)) return;
      if (!run.turnActive || run.settling || this.#runs.get(run.subtaskId) !== run) continue;
      const oldestTool = Math.min(...run.openTools.values());
      if (run.openTools.size > 0 && now - oldestTool < stuckMs + graceMs) continue;
      const progress = v.progressAt.get(run.sessionId);
      // A new report is a sign of life when the daemon sees it. Its timestamp comes from the MCP
      // backend's clock, so it only identifies the report and is never trusted as a time.
      if (progress !== undefined && progress !== run.progressSeen) {
        run.progressSeen = progress;
        run.lastActivity = Math.max(run.lastActivity, Math.min(progress, now));
        run.nudgedAt = undefined;
      }
      const silent = now - run.lastActivity;
      if (run.nudgedAt === undefined) {
        if (silent < stuckMs) continue;
        run.nudgedAt = now;
        this.#o.store.append(
          this.#env(
            run.subtaskId,
            'worker.nudged',
            { sessionId: run.sessionId, silentForMs: silent },
            run.sessionId,
          ),
        );
      } else if (now - run.nudgedAt >= graceMs) {
        this.#track(
          this.#end(run, 'stuck', `silent for ${Math.round(silent / 1000)} s after a nudge`).then(
            () => {
              if (this.#live(gen)) this.#afterFailure(run.subtaskId);
            },
          ),
        );
      }
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

  #tierFor(kind: string | undefined): TierConfig & { role: string } {
    const tiers = this.#o.config.tiers ?? {};
    const review = kind === 'review' ? tiers.review : undefined;
    const tier = review ?? tiers.worker;
    if (!tier) throw new Error('config has no tiers.worker');
    return { ...tier, role: review ? 'review' : 'worker' };
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

  async #rollUp(gen: number): Promise<void> {
    const updates = this.#parentUpdates(this.#state());
    // Waiting and working states first, as they are now: the awaits below must not make them stale.
    for (const { parent, state } of updates) {
      if (!TERMINAL.has(state)) {
        this.#o.store.append(this.#env(parent.task.id, 'task.status', { state }));
      }
    }
    for (const update of updates) {
      if (!this.#live(gen) || !TERMINAL.has(update.state)) continue;
      // Still due after the awaits of earlier parents?
      const fresh = this.#parentUpdates(this.#state()).find(
        (u) => u.parent.task.id === update.parent.task.id && u.state === update.state,
      );
      if (!fresh) continue;
      const { parent, subs, state } = fresh;
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
      // The parent's branch gets the work of every sub-task (#134).
      const published = done ? await this.#publish(parent.task.id, results) : undefined;
      if (!this.#live(gen)) return;
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
        summary: [
          ...subs.map((t) => `${t.task.id} ${t.state}: ${t.task.goal}`),
          ...(published?.ref
            ? [`Combined work: ${published.ref.replace(/^refs\/heads\//, '')}`]
            : []),
        ].join('\n'),
        filesTouched: [...new Set(results.flatMap((r) => r.filesTouched ?? []))],
        commits: [
          ...new Set([
            ...results.flatMap((r) => r.commits ?? []),
            ...(published?.commit ? [published.commit] : []),
          ]),
        ],
        verification: {
          status: verification,
          commands: [...new Set(results.flatMap((r) => r.verification?.commands ?? []))],
        },
        openQuestions: [
          ...results.flatMap((r) => r.openQuestions ?? []),
          ...(published?.question ? [published.question] : []),
        ],
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

  /**
   * Combine the sub-tasks' work into the task's result branch (#134). Sub-tasks with no
   * dependency between them can conflict; then nothing is published and the user is told which
   * files, in the result's open questions.
   */
  async #publish(
    taskId: string,
    results: SummaryPacket[],
  ): Promise<{ commit?: string; ref?: string; question?: string } | undefined> {
    const integrator = this.#o.integrator;
    const commits = results.flatMap((r) => r.commits?.slice(-1) ?? []);
    if (!integrator || commits.length === 0) return undefined;
    try {
      const commit = await integrator.combine(commits);
      if (!commit) return undefined;
      return { commit, ref: await integrator.publish(taskId, commit) };
    } catch (err) {
      this.#errors.push(err);
      if (err instanceof MergeConflictError) {
        return {
          question: `The sub-tasks' work conflicts (${fileList(err.files)}), so it was not combined into one branch. Merge the sub-task branches by hand.`,
        };
      }
      return {
        question: `Combining the sub-tasks' work failed: ${redactSecrets((err as Error).message)}`,
      };
    }
  }

  /**
   * The sub-tasks `subtaskId` depends on, directly or not, from its parent's plan: direct ones
   * first. Indirect ones count because a sub-task that commits nothing (a review) has no commit
   * of its own to carry its dependencies' work forward.
   */
  #dependencies(subtaskId: string): string[] {
    const v = this.#state();
    const parentId = v.tasks[subtaskId]?.task.parentId;
    const plan = parentId ? v.tasks[parentId]?.plan : undefined;
    const deps = (id: string) => plan?.find((p) => p.id === id)?.dependsOn ?? [];
    const out: string[] = [];
    const queue = [...deps(subtaskId)];
    while (queue.length > 0) {
      const id = queue.shift() as string;
      if (id === subtaskId || out.includes(id)) continue;
      out.push(id);
      queue.push(...deps(id));
    }
    return out;
  }

  /** The commit holding a completed sub-task's work, if it made one. */
  #resultCommit(subtaskId: string): string | undefined {
    return this.#o.store
      .query({ taskId: subtaskId, typePrefix: 'task.result' })
      .map((e) => e.envelope.data as SummaryPacket)
      .filter((r) => r.outcome === 'completed')
      .at(-1)
      ?.commits?.at(-1);
  }

  /**
   * Where a new checkout of `subtaskId` starts (#134): the combined work of the sub-tasks it
   * depends on, or the main branch. When their work conflicts, the user is asked first
   * (undefined: nothing runs). Once they answered, it starts from the first dependency's work,
   * and the Worker is told to merge the rest.
   */
  async #startingPoint(
    subtaskId: string,
    gen: number,
  ): Promise<{ commit?: string; notes: string[] } | undefined> {
    const integrator = this.#o.integrator;
    const deps = this.#dependencies(subtaskId)
      .map((id) => ({ id, commit: this.#resultCommit(id) }))
      .filter((d): d is { id: string; commit: string } => d.commit !== undefined);
    if (!integrator || deps.length === 0) return { notes: [] };
    try {
      const commit = await integrator.combine(deps.map((d) => d.commit));
      this.#combineFailures.delete(subtaskId);
      return { ...(commit !== undefined ? { commit } : {}), notes: [] };
    } catch (err) {
      if (!this.#live(gen)) return undefined;
      this.#errors.push(err);
      if (!(err instanceof MergeConflictError)) {
        // A git error (a timeout, say) may pass: try again on later ticks, a few times.
        const n = (this.#combineFailures.get(subtaskId) ?? 0) + 1;
        this.#combineFailures.set(subtaskId, n);
        if (n >= (this.#o.config.workers?.max_attempts ?? 3)) {
          this.#combineFailures.delete(subtaskId);
          this.#o.store.append(
            this.#env(subtaskId, 'task.status', {
              state: 'failed',
              message: `combining the work it depends on failed: ${redactSecrets((err as Error).message)}`,
            }),
          );
        }
        return undefined;
      }
      const key = `tacet:merge-conflict:${deps.map((d) => d.commit).join(',')}`;
      const [first, ...rest] = deps as [{ id: string; commit: string }, ...typeof deps];
      // Only the Mini-conductor's own question (no Worker session) counts.
      const answer = [...this.#state().escalations.values()].find(
        (x) => x.taskId === subtaskId && x.contextRef === key && !x.sessionId && x.resolved,
      );
      if (answer) {
        return {
          commit: first.commit,
          notes: [
            `Your checkout started from the work of ${first.id} only. The work of ${rest.map((d) => d.id).join(', ')}, which this sub-task also depends on, conflicts with it (${fileList(err.files)}). Unless your HEAD already has them, first merge these commits into it with git and resolve the conflicts: ${rest.map((d) => d.commit).join(' ')}.`,
            // A retry or a new session after the answer went out still needs it.
            ...(answer.delivered && answer.answer
              ? [`The user's guidance on the conflict: ${answer.answer}`]
              : []),
          ],
        };
      }
      this.#raise(
        subtaskId,
        `The work of ${deps.map((d) => d.id).join(', ')}, which ${subtaskId} depends on, conflicts (${fileList(err.files)}). When you answer, ${subtaskId} starts from the work of ${first.id} and its Worker merges the rest and resolves the conflicts, with your answer as guidance.`,
        { urgency: 'normal', category: 'blocked', contextRef: key },
      );
      return undefined;
    }
  }

  /** The Mini-conductor's own escalation on `taskId`, which waits for it (`input_required`). */
  #raise(
    taskId: string,
    question: string,
    extra: Pick<Escalation, 'urgency'> & Partial<Pick<Escalation, 'category' | 'contextRef'>>,
  ): void {
    const escalation = Escalation.parse({
      id: newUlid(this.#now().getTime()),
      taskId,
      ...(this.#o.repo !== undefined ? { repo: this.#o.repo } : {}),
      question,
      ...extra,
      createdAt: this.#now().toISOString(),
      status: 'pending',
    });
    this.#o.store.append([
      this.#env(taskId, 'escalation.raised', escalation),
      this.#env(taskId, 'task.status', { state: 'input_required' }),
    ]);
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
    // Model, effort and context window within the tier's bounds (#110); outside them, the
    // sub-task fails before any session starts.
    let profile: ChosenProfile;
    try {
      profile = chooseProfile({
        role: tier.role,
        tier,
        capabilities: worker.adapter.capabilities(),
        failedAttempts: failed,
        indivisible: v.indivisible.has(subtaskId),
      });
    } catch (err) {
      this.#o.store.append(
        this.#env(subtaskId, 'task.status', {
          state: 'failed',
          message: `session profile refused: ${(err as Error).message}`,
        }),
      );
      return;
    }
    const last = history.at(-1);
    // Reuse the checkout of an earlier run: a restart or a retry continues the same work.
    // Never one whose checkout failed the integrity checks: that run gets a fresh checkout.
    const existing =
      last?.workspaceId && !last.refused
        ? await this.#o.workspaces.get(last.workspaceId)
        : undefined;
    const sessionId = randomUUID();
    // Worked out for a reused checkout too: it keeps its base, but its Worker may still have to
    // merge conflicting work (#134).
    const start = await this.#startingPoint(subtaskId, gen);
    if (!start || !this.#live(gen) || this.#runs.has(subtaskId)) return;
    const baseCommit = existing ? last?.baseCommit : start.commit;
    const notes = start.notes;
    // A new checkout is named after the session that first uses it, so a sub-task that needs a
    // fresh one (its last failed the integrity checks) never collides with its old one.
    const workspace = existing ?? (await this.#o.workspaces.create(sessionId, baseCommit));
    if (!this.#live(gen)) return;
    const resume =
      last?.ended === 'restart' &&
      last.vendorSessionId !== undefined &&
      last.adapter === tier.adapter &&
      existing !== undefined &&
      worker.adapter.capabilities().resume
        ? { vendorSessionId: last.vendorSessionId }
        : undefined;
    // A session stopped for a restart that is not resumed after all (another adapter or
    // checkout now) never will be: its adapter may drop what it kept for that (#153).
    if (!resume && last?.ended === 'restart' && last.vendorSessionId && last.adapter) {
      // Its own checkout, refused or not, locates its state; the new one only if that is gone.
      const old = last.workspaceId ? await this.#o.workspaces.get(last.workspaceId) : undefined;
      await this.#discard(last.adapter, last.vendorSessionId, (old ?? workspace).path);
      if (!this.#live(gen)) return;
    }
    // Intent first: a crash after this leaves a record of the session and its checkout.
    this.#o.store.append([
      this.#env(
        subtaskId,
        'worker.started',
        {
          sessionId,
          adapter: tier.adapter,
          ...(profile.model !== undefined ? { model: profile.model } : {}),
          workspaceId: workspace.id,
          attempt: failed + 1,
          ...(last ? { previousSessionId: last.sessionId } : {}),
          ...(baseCommit !== undefined ? { baseCommit } : {}),
        },
        sessionId,
      ),
      this.#env(subtaskId, 'worker.profile', { sessionId, ...profile }, sessionId),
      ...(view.state !== 'working'
        ? [this.#env(subtaskId, 'task.status', { state: 'working' })]
        : []),
    ]);
    let revoke = () => {};
    let mcpServerName = '';
    /** Set when the adapter refused a part with no fallback: the sub-task fails, no retry. */
    let profileRefused: string | undefined;
    let handle: SessionHandle;
    // Recorded before the vendor process exists, so a crash at any point after this leaves it
    // findable (#127).
    const marker = newWorkerMarker();
    this.#markers.set(sessionId, marker);
    this.#saveMarkers();
    try {
      const minted = this.#o.mcp.workerConfig({ workerSessionId: sessionId, taskId: subtaskId });
      revoke = minted.revoke;
      mcpServerName = minted.config.name;
      const launch = (p: ChosenProfile) =>
        worker.adapter.start({
          cwd: workspace.path,
          systemPrompt: WORKER_SYSTEM_PROMPT,
          mcpServers: [minted.config],
          ...(p.model !== undefined ? { model: p.model } : {}),
          ...(p.effort !== undefined ? { effort: p.effort } : {}),
          ...(p.contextWindow !== undefined ? { contextWindow: p.contextWindow } : {}),
          ...(resume ? { resume } : {}),
          env: { [WORKER_MARKER_VAR]: marker },
        });
      // A refused part (#110) is logged and dropped or lowered, and the session started again:
      // a cost lever is not worth a failed attempt. A refused model has no fallback.
      for (;;) {
        try {
          handle = await launch(profile);
          break;
        } catch (err) {
          const field = refusedField(err);
          if (field === undefined || !this.#live(gen)) throw err;
          const message = redactSecrets((err as Error).message);
          this.#o.store.append(
            this.#env(
              subtaskId,
              'worker.profile',
              { sessionId, ...profile, refused: { field, message } },
              sessionId,
            ),
          );
          const next = afterRefusal(profile, field, tier.role, tier);
          if (!next) {
            profileRefused = `the adapter refused the ${field}: ${message}`;
            throw err;
          }
          profile = next;
          this.#o.store.append(
            this.#env(subtaskId, 'worker.profile', { sessionId, ...profile }, sessionId),
          );
        }
      }
    } catch (err) {
      revoke();
      // Whatever a failed start left running goes now, not at the next restart.
      this.#track(
        endMarkedProcesses([marker]).then(() => {
          if (this.#markers.delete(sessionId)) this.#saveMarkers();
        }),
      );
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
      // A resume that failed is not tried again (the next run starts afresh): drop its state.
      if (resume) await this.#discard(tier.adapter, resume.vendorSessionId, workspace.path);
      if (profileRefused !== undefined) {
        // The same profile would be refused every time: fail now instead of using up retries.
        this.#o.store.append(
          this.#env(subtaskId, 'task.status', {
            state: 'failed',
            message: `session profile refused: ${profileRefused}`,
          }),
        );
        this.#kick();
        return;
      }
      this.#afterFailure(subtaskId);
      return;
    }
    if (!this.#live(gen)) {
      // Stopped while the session started: give it back without registering it.
      revoke();
      await worker.adapter.close(handle).catch(() => {});
      if (this.#markers.delete(sessionId)) this.#saveMarkers();
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
      ...(baseCommit !== undefined ? { baseCommit } : {}),
      // Seeded now, also after a restart: the log's last event says nothing about this process.
      lastActivity: this.#now().getTime(),
      openTools: new Map(),
    };
    this.#runs.set(subtaskId, run);
    this.#noteVendorSession(run);
    this.#track(this.#consume(run, worker, gen));
    // Answers that came while no session was open go into the first message.
    const answers = this.#undelivered(subtaskId);
    try {
      // Composed inside the try: a prompt refused as unsafe ends the run like a failed send.
      const text = resume
        ? safePrompt([RESUME_PROMPT, ...answers.map(answerText)], '\n\n')
        : workerPrompt(view.task, this.#lastFeedback(subtaskId), [
            ...(history.length > 0 && v.progress.has(subtaskId)
              ? [`Progress reported before: ${v.progress.get(subtaskId)}`]
              : []),
            ...notes,
            ...answers.map(answerText),
          ]);
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
        run.lastActivity = this.#now().getTime();
        run.nudgedAt = undefined;
        if (e.t === 'tool.call') run.openTools.set(e.id, run.lastActivity);
        else if (e.t === 'tool.result') run.openTools.delete(e.id);
        else if (e.t === 'status' && e.state !== 'running') run.openTools.clear();
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
      // One round per check: the commands and the review of the same commit share it.
      const round = this.#verifyRounds(run);
      let verification: VerifyResult;
      try {
        verification = await this.#verify(run, view.task, round);
      } catch (err) {
        if (!(err instanceof WorktreeRefusedError)) throw err;
        ended = true;
        await this.#refused(run);
        return;
      }
      if (this.#runs.get(run.subtaskId) !== run || !this.#started) return;
      // Review only work whose commands did not fail: a reviewer cannot pass failing tests.
      if (verification.status !== 'failed') {
        const review = await this.#review(run, view.task, round);
        if (this.#runs.get(run.subtaskId) !== run || !this.#started) return;
        if (review) verification = withReview(verification, review);
      }
      if (verification.status === 'failed' && (await this.#sendFix(run, verification))) {
        // The same session fixes it: its next turn's end verifies again.
        return;
      }
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

  #summary(run: Run, outcome: 'completed' | 'failed', result: VerifyResult): SummaryPacket {
    // What goes up is the verification, never the feedback meant for the Worker (8 KB of output).
    const verification: Verification = {
      status: result.status,
      commands: result.commands,
      ...(result.notes !== undefined ? { notes: result.notes } : {}),
      ...(result.results !== undefined ? { results: result.results } : {}),
      ...(result.review !== undefined ? { review: result.review } : {}),
    };
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
      const result = await integrator.integrate(run.subtaskId, run.workspace, run.baseCommit);
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
        await this.#refused(run);
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

  /** The Worker's checkout failed its integrity checks: ask the user, end the run. */
  async #refused(run: Run): Promise<void> {
    // Paths stay out: escalations go up to the Conductor. The workspace is named by id.
    this.#raise(
      run.subtaskId,
      `The Worker's checkout ${run.workspace.id} for ${run.subtaskId} failed its integrity checks, so nothing was run in it. Inspect it; when you answer, the sub-task runs again in a fresh checkout.`,
      { urgency: 'high' },
    );
    await this.#end(run, 'canceled', 'checkout failed its integrity checks', {
      workspaceRefused: true,
    });
  }

  /**
   * Verify a finished turn (#19): with the process marker recorded first (a crash mid-run ends
   * what the commands started at the next start) and aborted if the session ends meanwhile.
   * Each command's result becomes a `worker.verification` event; the output never does.
   */
  async #verify(run: Run, task: Task, round: number): Promise<VerifyResult> {
    const commands = this.#o.config.verify ?? [];
    if (CODEX_ADAPTERS.has(run.adapterId) && !VERIFY_CODEX_WORKERS && commands.length > 0) {
      return { status: 'not_run', commands, notes: CODEX_NOT_VERIFIED };
    }
    const abort = new AbortController();
    run.verifyAbort = abort;
    const marker = newWorkerMarker();
    const key = `verify:${run.sessionId}`;
    this.#markers.set(key, marker);
    this.#saveMarkers();
    let ranCommand = false;
    try {
      const result = await (this.#o.verifier ?? this.#defaultVerifier()).verify(
        task,
        run.workspace,
        {
          ...(run.commit !== undefined ? { commit: run.commit } : {}),
          signal: AbortSignal.any([abort.signal, this.#abort.signal]),
          marker,
          onCommand: (r) => {
            ranCommand = true;
            this.#o.store.append(
              this.#env(
                run.subtaskId,
                'worker.verification',
                {
                  sessionId: run.sessionId,
                  round,
                  command: redactSecrets(r.command),
                  status: r.status,
                  ...(r.exitCode !== undefined ? { exitCode: r.exitCode } : {}),
                  ...(r.signal !== undefined ? { signal: r.signal } : {}),
                  durationMs: r.durationMs ?? 0,
                  ...(run.commit !== undefined ? { commit: run.commit } : {}),
                },
                run.sessionId,
              ),
            );
          },
        },
      );
      if (result.status === 'failed' && !ranCommand) {
        // Failed before any command (the checkout was not clean): still a round, so the fix
        // loop ends.
        this.#o.store.append(
          this.#env(
            run.subtaskId,
            'worker.verification',
            {
              sessionId: run.sessionId,
              round,
              command: CHECKOUT_CHECK,
              status: 'failed',
              durationMs: 0,
              ...(run.commit !== undefined ? { commit: run.commit } : {}),
            },
            run.sessionId,
          ),
        );
      }
      return result;
    } catch (err) {
      this.#errors.push(err);
      // The checkout failed its integrity checks: the caller handles it as integration does.
      if (err instanceof WorktreeRefusedError) throw err;
      // No message: it can name paths, which stay out of what goes up.
      return {
        status: 'failed',
        commands,
        notes: 'Verification could not run (see the Mini-conductor log).',
      };
    } finally {
      if (run.verifyAbort === abort) run.verifyAbort = undefined;
      if (this.#markers.get(key) === marker) {
        this.#markers.delete(key);
        this.#saveMarkers();
      }
    }
  }

  /**
   * Review a finished turn's integrated change (#19), when review is on: the reviewer's process
   * marker recorded first, aborted if the session ends. Undefined when there is nothing to
   * review: review off or no commit integrated (whatever the sub-task's kind: a commit is
   * reviewed). The verdict becomes a `worker.review` event (counts only) and its usage is
   * charged to the sub-task; a review that was stopped records only its usage, so it uses no
   * fix round.
   */
  async #review(run: Run, task: Task, round: number): Promise<ReviewResult | undefined> {
    const reviewer = this.#o.reviewer;
    if (!this.#o.config.review?.enabled || !reviewer || run.commit === undefined) return undefined;
    const tier = this.#o.config.tiers?.review;
    const commit = run.commit;
    const abort = new AbortController();
    run.verifyAbort = abort;
    const marker = newWorkerMarker();
    const key = `review:${run.sessionId}`;
    this.#markers.set(key, marker);
    this.#saveMarkers();
    const started = this.#now().getTime();
    const signal = AbortSignal.any([abort.signal, this.#abort.signal]);
    let result: ReviewResult;
    try {
      result = await reviewer.review(task, {
        commit,
        ...(run.baseCommit !== undefined ? { base: run.baseCommit } : {}),
        signal,
        marker,
      });
    } catch (err) {
      this.#errors.push(err);
      result = {
        status: 'error',
        adapter: tier?.adapter ?? 'unknown',
        findings: [],
        notes: 'the review could not run (see the Mini-conductor log)',
      };
    } finally {
      if (run.verifyAbort === abort) run.verifyAbort = undefined;
      // Whatever the reviewer's session left running goes with it.
      await endMarkedProcesses([marker]).catch(() => undefined);
      if (this.#markers.get(key) === marker) {
        this.#markers.delete(key);
        this.#saveMarkers();
      }
    }
    const usage = result.usage
      ? [
          this.#env(run.subtaskId, 'agent.usage', {
            t: 'usage',
            source: 'reported',
            ...result.usage,
          }),
        ]
      : [];
    if (signal.aborted) {
      // Stopped, not judged: the session ended or the Mini-conductor stopped. No round is used.
      if (usage.length > 0) this.#o.store.append(usage);
      return undefined;
    }
    const count = (sev: string) => result.findings.filter((f) => f.severity === sev).length;
    this.#o.store.append([
      this.#env(
        run.subtaskId,
        'worker.review',
        {
          sessionId: run.sessionId,
          ...(result.sessionId !== undefined ? { reviewerSessionId: result.sessionId } : {}),
          round,
          adapter: result.adapter,
          ...(result.model !== undefined ? { model: result.model } : {}),
          status: result.status,
          blockers: count('blocker'),
          majors: count('major'),
          minors: count('minor'),
          durationMs: Math.max(0, this.#now().getTime() - started),
          commit,
        },
        run.sessionId,
      ),
      ...usage,
    ]);
    return result;
  }

  /**
   * Verification rounds this attempt already had (each recorded its commands under one round):
   * those of every session started under the same attempt number, so a restart (which resumes
   * without counting as a failed attempt) does not buy fix rounds, while a retry after a failed
   * attempt starts afresh even in the same checkout.
   * A round a restart cut short (its commands `aborted`) counts too: the restart re-checks.
   */
  #verifyRounds(run: Run): number {
    const started = this.#o.store
      .query({ taskId: run.subtaskId, typePrefix: 'worker.started' })
      .map((e) => e.envelope.data as { sessionId?: string; attempt?: number });
    const attempt = started.find((d) => d.sessionId === run.sessionId)?.attempt;
    const sessions = new Set([run.sessionId]);
    for (const d of started) {
      if (d.sessionId && attempt !== undefined && d.attempt === attempt) sessions.add(d.sessionId);
    }
    const rounds = new Set<string>();
    // Commands and reviews alike: a repo without `verify` commands still has a cap on reviews.
    for (const e of this.#o.store.query({ taskId: run.subtaskId, typePrefix: 'worker' })) {
      if (e.envelope.type !== 'worker.verification' && e.envelope.type !== 'worker.review')
        continue;
      const d = e.envelope.data as { sessionId?: string; round?: number };
      if (d.sessionId && sessions.has(d.sessionId) && typeof d.round === 'number') {
        rounds.add(`${d.sessionId}:${d.round}`);
      }
    }
    return rounds.size;
  }

  /**
   * A failed verification goes back to the same session to fix, while fix rounds are left
   * (`workers.verify_fix_attempts`). False when it should fail the attempt instead.
   */
  async #sendFix(run: Run, verification: VerifyResult): Promise<boolean> {
    const allowed = this.#o.config.workers?.verify_fix_attempts ?? 2;
    // The round that just failed is recorded: rounds so far = fix rounds used + 1.
    if (!verification.feedback || this.#verifyRounds(run) > allowed) return false;
    const worker = this.#o.adapters[run.adapterId];
    if (!worker) return false;
    run.turnActive = true;
    run.settling = false;
    run.lastActivity = this.#now().getTime();
    run.nudgedAt = undefined;
    try {
      await worker.adapter.send(run.handle, { text: safePrompt([verification.feedback]) });
      return true;
    } catch (err) {
      run.turnActive = false;
      run.settling = true;
      this.#errors.push(err);
      return false;
    }
  }

  #defaultVerifier(): Verifier {
    const commands = this.#o.config.verify ?? [];
    return {
      // #19 runs the commands and a reviewer; until then nothing is claimed as verified.
      // Without a verifier (the entry point passes a `CommandVerifier`), nothing is claimed.
      verify: async () => ({ status: commands.length > 0 ? 'not_run' : 'passed', commands }),
    };
  }

  /** Feedback for a retry: the last failed result's summary. */
  #lastFeedback(subtaskId: string): string | undefined {
    const last = this.#o.store
      .query({ taskId: subtaskId, typePrefix: 'task.result' })
      .map((e) => e.envelope.data as SummaryPacket)
      .at(-1);
    if (!last || last.outcome === 'completed') return undefined;
    const notes = last.verification.status === 'failed' ? last.verification.notes : undefined;
    // Why the last attempt failed verification, so a fresh session does not repeat it (#19).
    return notes
      ? `${last.summary.slice(0, 1000)}\n\nVerification of that attempt: ${notes.slice(0, 2000)}`
      : last.summary.slice(0, 1000);
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
    // A verification still running for it stops (its result is not used).
    run.verifyAbort?.abort();
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
    // Closed by its adapter: nothing of it is left to end after a crash.
    if (this.#markers.delete(run.sessionId)) this.#saveMarkers();
    // Only a session stopped for a restart is ever resumed (#153).
    const vendor =
      run.handle.vendorSessionId ?? this.#state().sessions.get(run.sessionId)?.vendorSessionId;
    if (reason !== 'restart' && vendor) {
      await this.#discard(run.adapterId, vendor, run.workspace.path);
    }
  }

  /** Let the adapter drop what it keeps to resume a session that never will be. Best effort. */
  async #discard(adapterId: string, vendorSessionId: string, cwd: string): Promise<void> {
    const adapter = this.#o.adapters[adapterId]?.adapter;
    if (!adapter?.discard) return;
    await adapter.discard(vendorSessionId, cwd).catch((err: unknown) => this.#errors.push(err));
  }

  // ---- Worker processes (#127) -----------------------------------------------------------

  get #processFile(): string {
    return this.#o.processFile ?? `${this.#o.lockPath}.workers`;
  }

  #saveMarkers(): void {
    const file = this.#processFile;
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify([...this.#markers.values()])}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
      renameSync(tmp, file);
    } catch (err) {
      rmSync(tmp, { force: true });
      this.#errors.push(err);
    }
  }

  /**
   * End the processes of Worker sessions a predecessor recorded and never closed: every process
   * whose environment carries one of their markers, the vendor's tools included.
   */
  async #endStaleWorkers(): Promise<void> {
    const file = this.#processFile;
    // Temp files of a write a crash interrupted.
    try {
      const dir = dirname(file);
      const prefix = `${basename(file)}.`;
      for (const name of readdirSync(dir)) {
        if (name.startsWith(prefix) && name.endsWith('.tmp'))
          rmSync(join(dir, name), { force: true });
      }
    } catch {
      // No directory yet.
    }
    let markers: string[] = [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      markers = (Array.isArray(parsed) ? parsed : []).filter(isWorkerMarker);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.#errors.push(err);
    }
    if (markers.length > 0) {
      const { left } = await endMarkedProcesses(markers);
      if (left.length > 0) {
        this.#errors.push(
          new Error(`Worker processes still running after SIGKILL: ${left.join(' ')}`),
        );
      }
    }
    this.#markers.clear();
    this.#saveMarkers();
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
    // A new turn starts now: the hours spent waiting on the answer are not silence.
    run.lastActivity = this.#now().getTime();
    run.nudgedAt = undefined;
    try {
      await worker.adapter.send(run.handle, { text: safePrompt(answers.map(answerText)) });
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
    const indivisible = new Set<string>();
    const escalations = new Map<string, EscalationRecord>();
    const decisions = new Map<string, string>();
    const progress = new Map<string, string>();
    const progressAt = new Map<string, number>();
    for (const { envelope: e } of this.#o.store.query({})) {
      const d = (e.data ?? {}) as Record<string, unknown>;
      const str = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : undefined);
      if (e.type === 'worker.progress') {
        // Written by the MCP backend: the session is on the envelope, the report is the data.
        const summary = str('summary');
        if (summary && e.taskId) progress.set(e.taskId, summary);
        if (e.sessionId) progressAt.set(e.sessionId, Date.parse(e.ts));
      } else if (e.type.startsWith('worker.')) {
        const id = str('sessionId');
        if (!id || !e.taskId) continue;
        if (e.type === 'worker.started') {
          const adapter = str('adapter');
          const workspaceId = str('workspaceId');
          const baseCommit = str('baseCommit');
          sessions.set(id, {
            sessionId: id,
            taskId: e.taskId,
            ...(adapter ? { adapter } : {}),
            ...(workspaceId ? { workspaceId } : {}),
            ...(baseCommit ? { baseCommit } : {}),
          });
        } else {
          const s = sessions.get(id);
          if (!s) continue;
          const vendor = str('vendorSessionId');
          if (e.type === 'worker.vendor_session' && vendor) s.vendorSessionId = vendor;
          else if (e.type === 'worker.ended') {
            s.ended = str('reason') ?? 'failed';
            if (d.workspaceRefused === true) s.refused = true;
          }
        }
      } else if (e.type === 'task.planned') {
        const plan = TaskPlan.safeParse(e.data);
        if (plan.success) {
          for (const s of plan.data.subtasks) {
            kinds.set(s.id, s.kind);
            // Each plan is the full current one, so a replan can also clear the mark.
            if (s.indivisible) indivisible.add(s.id);
            else indivisible.delete(s.id);
          }
        }
      } else if (e.type === 'escalation.raised') {
        const id = str('id');
        if (id && e.taskId) {
          escalations.set(id, {
            id,
            taskId: e.taskId,
            ...(e.sessionId ? { sessionId: e.sessionId } : {}),
            ...(str('contextRef') ? { contextRef: str('contextRef') } : {}),
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
    this.#view = {
      count,
      tasks,
      sessions,
      kinds,
      indivisible,
      escalations,
      decisions,
      progress,
      progressAt,
    };
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

/** The part an adapter's `ProfileRefusedError` names; matched by name, as across package copies. */
function refusedField(err: unknown): ProfileField | undefined {
  if (!(err instanceof Error) || err.name !== 'ProfileRefusedError') return undefined;
  const field = (err as { field?: unknown }).field;
  return field === 'model' || field === 'effort' || field === 'contextWindow' ? field : undefined;
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

/** Conflicting files for a question: repo-relative, at most 20. */
function fileList(files: readonly string[]): string {
  if (files.length === 0) return 'no file named';
  // Names come from Worker commits: keep each one short.
  const name = (f: string) => (f.length > 120 ? `${f.slice(0, 117)}...` : f);
  const shown = files.slice(0, 20).map(name).join(', ');
  return files.length > 20 ? `${shown} and ${files.length - 20} more` : shown;
}
