/** Per-repo Mini-conductor daemon (#17) and its MCP server for Workers (#18). */
export const packageName = '@tacet/mini' as const;

export { isOwnMcpTool, MiniConductor, type MiniConductorOptions } from './daemon/daemon.js';
export {
  AdapterPlanner,
  type AdapterPlannerOptions,
  parseProposal,
  SingleStepPlanner,
} from './daemon/planner.js';
export type {
  Planner,
  ProposedSubtask,
  Verifier,
  WorkerAdapter,
  WorkerMcp,
  Workspace,
  Workspaces,
} from './daemon/ports.js';
export {
  blockedByFailure,
  type CapacityLimits,
  pickReady,
  type SchedulableSubtask,
} from './daemon/scheduler.js';
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
