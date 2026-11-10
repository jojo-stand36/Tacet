import type { AgentAdapter, McpServerConfig, Task, Verification } from '@tacet/core';
import type { WorkerBinding } from '@tacet/core/node';

/**
 * The Worker's checkout, one per sub-task. Matches the worktree manager's `create`/`remove`
 * (#16, PR #103), plus the base commit of #134, which that manager's `create` needs to take. Paths stay inside the Mini-conductor: events
 * name a workspace by `id` only.
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
  remove(id: string): Promise<void>;
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

/** Checks a finished Worker turn before its sub-task counts as `completed` (#19 replaces it). */
export interface Verifier {
  verify(subtask: Task, workspace: Workspace): Promise<Verification>;
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
