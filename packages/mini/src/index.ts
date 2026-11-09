/** Per-repo Mini-conductor daemon and its MCP server for Workers (#18). */
export const packageName = '@tacet/mini' as const;

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
