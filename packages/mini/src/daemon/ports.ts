import type { AgentAdapter, McpServerConfig, Task, Verification } from '@tacet/core';
import type { WorkerBinding } from '@tacet/core/node';

/**
 * The Worker's checkout, one per sub-task. Matches the worktree manager's `create`/`remove`
 * (#16, PR #103) so it can be plugged in as is. Paths stay inside the Mini-conductor: events
 * name a workspace by `id` only.
 */
export interface Workspace {
  id: string;
  path: string;
}

export interface Workspaces {
  /** A fresh checkout for `workerId` (the sub-task id). */
  create(workerId: string): Promise<Workspace>;
  /** An existing checkout, or undefined if it is gone. */
  get(id: string): Promise<Workspace | undefined>;
  remove(id: string): Promise<void>;
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
}

export interface Planner {
  plan(task: Task): Promise<{
    subtasks: ProposedSubtask[];
    rationale?: string;
    planner?: { sessionId?: string; adapter?: string; model?: string };
  }>;
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
