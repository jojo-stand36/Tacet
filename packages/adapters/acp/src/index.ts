/** Generic Agent Client Protocol (ACP) adapter (#13). */
export const packageName = '@tacet/adapter-acp' as const;

export {
  ACP_PROTOCOL_VERSION,
  ACP_SDK_VERSION,
  AcpAdapter,
  type AcpAdapterOptions,
  AuthRoutingError,
} from './adapter.js';
export {
  type AcpAgentSpec,
  BUILTIN_ACP_AGENTS,
  CLAUDE_ACP_AGENT,
  CLAUDE_ACP_WORKER_OPTIONS,
  CODEX_ACP_AGENT,
  CODEX_ACP_PROVIDER,
  type CustomAcpAgentConfig,
  claudeAcpWorkerSpec,
  codexAcpConfig,
  customAcpAgent,
  GEMINI_AGENT,
  GEMINI_WORKER_SETTINGS,
} from './agents.js';
