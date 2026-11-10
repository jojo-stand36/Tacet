/** Claude adapter built on the Claude Agent SDK (issue #11). */
export const packageName = '@tacet/adapter-claude-sdk' as const;

export {
  CLAUDE_SDK_CAPABILITIES,
  ClaudeSdkAdapter,
  type ClaudeSdkAdapterOptions,
  toPermissionResult,
} from './adapter.js';
export {
  AuthRoutingError,
  authEnv,
  type ClaudeAuthRoute,
  chooseAuthRoute,
  claudeEnvAllow,
} from './auth.js';
export {
  defaultMcpConfigDir,
  ownerDirName,
  ownOwnerDirName,
  removeMcpConfig,
  sweepStaleMcpConfigs,
  writeMcpConfig,
} from './mcp-config.js';
