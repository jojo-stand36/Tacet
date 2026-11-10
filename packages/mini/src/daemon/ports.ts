import type {
  AgentAdapter,
  McpServerConfig,
  Task,
  Verification,
  VerifyCommandResult,
} from '@tacet/core';
import type { WorkerBinding } from '@tacet/core/node';

/**
 * The Worker's checkout, one per sub-task; `WorktreeManager` (#16) implements the port. Paths
 * stay inside the Mini-conductor: events name a workspace by `id` only.
 */
export interface Workspace {
  id: string;
  path: string;
  /** The local branch it started from, when it started from one: its task's target (#210). */
  baseBranch?: string;
}

export interface Workspaces {
  /**
   * A fresh checkout for the Worker session `workerId`; never an existing one. It starts at
   * `base`, a commit in the repo (#134: its dependencies' work; #219: the task's pinned target),
   * or, without one, where the main checkout is now. `scratch` marks a throwaway checkout (the
   * planner's, #238): one a crash leaves registered is force-removed by the next `reconcile`.
   */
  create(workerId: string, base?: string, options?: { scratch?: boolean }): Promise<Workspace>;
  /**
   * Bring the checkout registry up to date with the disk (#126): called once at start, while the
   * Mini-conductor holds its lock, before any checkout is looked up.
   */
  reconcile?(): Promise<void>;
  /**
   * Remove checkouts not used for `olderThanMs` (#238): judged by the newest of their creation and
   * `lastActivity` (by id), skipping `activeWorktreeIds`. Never loses work: a checkout with local
   * files or unintegrated commits is kept.
   */
  gc?(options: {
    olderThanMs: number;
    activeWorktreeIds?: readonly string[];
    lastActivity?: ReadonlyMap<string, number>;
  }): Promise<{ removed: string[] }>;
  /**
   * The repo's checked-out branch (absent when its HEAD is detached) and commit right now: where a
   * new task's sub-tasks start (#219). Without it, each sub-task starts at the main branch as it is
   * when the sub-task starts.
   */
  head?(): Promise<{ branch?: string; commit: string }>;
  /**
   * Hold `commit` with a ref of the task's (`refs/tacet/<task>/target`), so git gc never prunes
   * the commit a task's sub-tasks start from (#236).
   */
  pin?(taskId: string, commit: string): Promise<void>;
  /**
   * Delete each task's pin ref that still holds its `commit` (#247): once a task is finished, no
   * new checkout starts there. Refs gone or holding another commit are left; throws when the refs
   * cannot be read, so the caller tries again.
   */
  unpin?(pins: ReadonlyArray<{ taskId: string; commit: string }>): Promise<void>;
  /** An existing checkout, or undefined if it is gone. */
  get(id: string): Promise<Workspace | undefined>;
  /**
   * Delete a checkout; a no-op for an id that is gone. Refuses (throws) rather than lose work
   * nothing else has, such as local files or commits no other branch contains, unless `force`.
   * `landed` names commits that landed in their target (#210); work they contain counts as kept.
   */
  remove(id: string, options?: { force?: boolean; landed?: readonly string[] }): Promise<void>;
}

/** The Worker's checkout failed its integrity checks: nothing was run in it. */
export class WorktreeRefusedError extends Error {
  override name = 'WorktreeRefusedError';
}

/**
 * Brings a sub-task's Worker commits into the repo (#119). Returns undefined when there is
 * nothing to integrate; throws `WorktreeRefusedError` when the checkout fails its integrity
 * checks (nothing was run in it).
 */
export interface Integrator {
  /** `base` is the commit the checkout started at: a HEAD still there is no work of its own. */
  integrate(
    subtaskId: string,
    workspace: Workspace,
    base?: string,
  ): Promise<{ commit: string; ref: string } | undefined>;
  /**
   * One commit with the work of every commit given, already in the repo (#134): undefined for
   * none, the commit itself when the others are in it, otherwise a merge made without a checkout.
   * Throws `MergeConflictError` when they conflict.
   */
  combine(commits: readonly string[]): Promise<string | undefined>;
  /**
   * What the checkout has that `commit` (a commit already in the repo; without one, the
   * checkout's HEAD, if the repo has it) does not: changed, deleted or new files (#261).
   * Undefined when it cannot tell; throws `WorktreeRefusedError` for a checkout that fails its
   * integrity checks, and an error when the check itself fails.
   */
  uncommitted?(
    workspace: Workspace,
    commit?: string,
  ): Promise<{ path: string; untracked: boolean }[] | undefined>;
  /** Point the branch holding a task's combined result at `commit`; returns the ref. */
  publish(taskId: string, commit: string): Promise<string>;
  /**
   * Whether `commit` landed in `target` (`refs/heads/<branch>`), merged or squash-merged, from
   * the repo's own refs only (#210). Undefined when it has not (or cannot tell).
   */
  landed?(
    commit: string,
    target: string,
  ): Promise<{ how: 'merge' | 'squash'; landedAs?: string } | undefined>;
  /**
   * Whether `later` is an amend of `earlier` in `workspace` (#210): the same first parent, and the
   * Worker's own reflog made `later` by amending or squashing, not by a commit after a reset.
   * Without it, no integrated commit counts as superseded.
   */
  replaces?(earlier: string, later: string, workspace: Workspace): Promise<boolean>;
}

/** Commits that cannot be combined without a person: `files` conflict. */
export class MergeConflictError extends Error {
  override name = 'MergeConflictError';
  constructor(
    message: string,
    readonly files: string[],
  ) {
    super(message);
  }
}

/** What the Mini-conductor gives a verification run (#19). */
export interface VerifyContext {
  /** The integrated commit the checkout must be at, when the Worker's work was integrated. */
  commit?: string;
  /** Aborted when the session ends or the Mini-conductor stops: the run ends as `not_run`. */
  signal: AbortSignal;
  /**
   * The process marker (#127) for what the commands start, recorded by the Mini-conductor before
   * the run, so a crash mid-run still ends them at the next start.
   */
  marker: string;
  /** Told each command's result as it finishes (for `worker.verification`). */
  onCommand?(result: VerifyCommandResult): void;
}

/** A verification, and on failure what to tell the Worker so it can fix it. */
export type VerifyResult = Verification & {
  /** Sent to the Worker as its next turn when a fix round is left. Redacted, bounded. */
  feedback?: string;
};

/** Checks a finished Worker turn before its sub-task counts as `completed` (#19). */
export interface Verifier {
  verify(subtask: Task, workspace: Workspace, ctx: VerifyContext): Promise<VerifyResult>;
}

/** What a reviewer agent gets for one check (#19). */
export interface ReviewContext {
  /** The integrated commit to review. */
  commit: string;
  /** The commit the Worker's checkout started at (#134); undefined: the main branch. */
  base?: string;
  /** Aborts when the author's session ends or the Mini-conductor stops. */
  signal: AbortSignal;
  /** Process marker for the reviewer's session (#127). */
  marker: string;
}

export interface ReviewFinding {
  severity: 'blocker' | 'major' | 'minor';
  file?: string;
  line?: number;
  message: string;
}

/**
 * A reviewer's verdict. `failed` means blocking findings (blocker or major); `error` means no
 * verdict (the reviewer failed, timed out or gave no valid reply).
 */
export interface ReviewResult {
  status: 'passed' | 'failed' | 'error';
  adapter: string;
  model?: string;
  sessionId?: string;
  findings: ReviewFinding[];
  /** Why there is no verdict (`error`): no paths, no reply text. */
  notes?: string;
  usage?: PlanResult['usage'];
}

/** Reviews a Worker's integrated change before its sub-task completes (#19). */
export interface Reviewer {
  review(subtask: Task, ctx: ReviewContext): Promise<ReviewResult>;
}

/** A sub-task as the planner proposes it; the Mini-conductor assigns ids. */
export interface ProposedSubtask {
  key: string;
  goal: string;
  acceptanceCriteria: string[];
  kind?: 'implement' | 'review' | 'explore';
  dependsOn?: string[];
  /** Cannot be handed off cleanly part-way, so it may get a larger context window (#110). */
  indivisible?: boolean;
}

export interface PlanResult {
  subtasks: ProposedSubtask[];
  rationale?: string;
  planner?: { sessionId?: string; adapter?: string; model?: string };
  /** Tokens and cost the planning used, charged to the planned task. */
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number; model?: string };
}

export interface Planner {
  /**
   * `signal` aborts when the Mini-conductor stops; the planner should end its session. `base` is
   * the commit the task's sub-tasks start from (#219): a planner that reads the code reads it there.
   */
  plan(task: Task, opts?: { signal?: AbortSignal; base?: string }): Promise<PlanResult>;
}

/**
 * A Worker adapter together with the auth route it was built with. The pool runs Workers
 * unattended and in parallel, so it only takes adapters on the `api_key` route (owner decision
 * on #65, ARCHITECTURE.md §6); anything else is refused.
 */
export interface WorkerAdapter {
  adapter: AgentAdapter;
  authRoute: 'api_key';
}

/** Mints per-Worker MCP configs (the Mini-conductor MCP server, #18). */
export interface WorkerMcp {
  workerConfig(binding: WorkerBinding): { config: McpServerConfig; revoke: () => void };
}

/**
 * Why an adapter may not run unattended sessions (an ACP agent's `workerRefused`, e.g. codex-acp
 * until #183 is decided), or `undefined`. Read by duck typing, so any adapter can declare it.
 */
export function workerRefusal(w: WorkerAdapter): string | undefined {
  const r = (w.adapter as { workerRefused?: unknown }).workerRefused;
  return typeof r === 'string' && r.length > 0 ? r : undefined;
}
