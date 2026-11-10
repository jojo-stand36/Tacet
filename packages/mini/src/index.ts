/** Per-repo Mini-conductor daemon (#17) and its MCP server for Workers (#18). */
export const packageName = '@tacet/mini' as const;

export {
  isOwnMcpTool,
  MiniConductor,
  type MiniConductorOptions,
  VERIFY_CODEX_WORKERS,
} from './daemon/daemon.js';
export {
  AdapterPlanner,
  type AdapterPlannerOptions,
  parseProposal,
  SingleStepPlanner,
} from './daemon/planner.js';
export type {
  Integrator,
  Planner,
  ProposedSubtask,
  ReviewContext,
  Reviewer,
  ReviewFinding,
  ReviewResult,
  Verifier,
  VerifyContext,
  VerifyResult,
  WorkerAdapter,
  WorkerMcp,
  Workspace,
  Workspaces,
} from './daemon/ports.js';
export { WorktreeRefusedError } from './daemon/ports.js';
export {
  blockedByFailure,
  type CapacityLimits,
  pickReady,
  type SchedulableSubtask,
} from './daemon/scheduler.js';
export { type ReviewDiff, type ReviewDiffOptions, reviewDiff } from './git/diff.js';
export {
  GitIntegrator,
  type Integration,
  integrateWorktree,
  taskBranch,
} from './git/integrate.js';
export {
  type EscalationGate,
  EventLogBackend,
  type EventLogBackendOptions,
  type MiniBackend,
  ToolError,
} from './mcp/backend.js';
export {
  buildToolServer,
  MiniMcpServer,
  type MiniMcpServerOptions,
  type ToolPolicy,
} from './mcp/server.js';
export {
  type DecisionSummary,
  TOOL_NAMES,
  type ToolInput,
  type ToolName,
  type ToolOutput,
  ToolSchemas,
} from './mcp/tools.js';
export {
  AdapterReviewer,
  type AdapterReviewerOptions,
  parseReview,
  REVIEWER_SYSTEM_PROMPT,
  reviewerPrompt,
  reviewFeedback,
} from './review/adapter-reviewer.js';
export { REVIEW_WITH_CODEX, reviewConfigProblem } from './review/config.js';
export {
  CommandVerifier,
  type CommandVerifierOptions,
  commandVerifierFromConfig,
} from './verify/command-verifier.js';
