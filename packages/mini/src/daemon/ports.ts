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
}

export interface Workspaces {
  /**
   * A fresh checkout for the Worker session `workerId`; never an existing one. It starts at
   * `base`, a commit in the repo (#134: its dependencies' work), or at the main branch.
   */
  create(workerId: string, base?: string): Promise<Workspace>;
  /** An existing checkout, or undefined if it is gone. */
  get(id: string): Promise<Workspace | undefined>;
  /**
   * Delete a checkout; a no-op for an id that is gone. Refuses (throws) rather than lose work
   * nothing else has, such as local files or commits no other branch contains, unless `force`.
   */
  remove(id: string, options?: { force?: boolean }): Promise<void>;
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
  /** Point the branch holding a task's combined result at `commit`; returns the ref. */
  publish(taskId: string, commit: string): Promise<string>;
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
  /** `signal` aborts when the Mini-conductor stops; the planner should end its session. */
  plan(task: Task, opts?: { signal?: AbortSignal }): Promise<PlanResult>;
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
