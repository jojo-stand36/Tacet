/** Per-repo Mini-conductor daemon (#17) and its MCP server for Workers (#18). */

export type {
  CreateWorktreeOptions,
  MergeResult,
  MergeStrategy,
  WorktreeGcOptions,
  WorktreeGcResult,
  WorktreeInfo,
  WorktreeSetup,
} from './worktree.js';
export {
  targetRef,
  WorktreeKeptError,
  type WorktreeLog,
  WorktreeManager,
} from './worktree.js';

export const packageName = '@tacet/mini' as const;

export {
  type CancelStoppedOptions,
  cancelStopped,
  isOwnMcpTool,
  MiniConductor,
  type MiniConductorOptions,
  miniLockHolder,
  VERIFY_CODEX_WORKERS,
  withStoppedMini,
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
export {
  type Aside,
  type EscalationGateOptions,
  escalationGate,
} from './gate/escalation-gate.js';
export {
  alwaysAskMatch,
  type DeterministicGateOptions,
  deterministicGate,
  effectiveAutonomy,
  findPrecedent,
  forUser,
  normalizeQuestion,
  type Precedent,
  precedentKey,
  rootTasks,
} from './gate/gate.js';
export {
  AdapterReasoner,
  type AdapterReasonerOptions,
  type Candidate,
  checkReply,
  REASONER_SYSTEM_PROMPT,
  type ReasonedVerdict,
  type ReasonRequest,
  type ReasonResult,
  reasonerPrompt,
  reasoningCandidates,
} from './gate/reasoning.js';
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
  type GateAnswer,
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
