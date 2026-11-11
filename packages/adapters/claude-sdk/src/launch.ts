/**
 * `@tacet/adapter-claude-sdk/launch`: what launching a Claude Code Worker needs, without the
 * Agent SDK. The PTY adapter (#15) runs the same binary interactively and uses these too.
 */
export {
  AuthRoutingError,
  authEnv,
  type ClaudeAuthRoute,
  claudeEnvAllow,
  SubprocessScrubError,
  withSubprocessScrub,
} from './auth.js';
export { removeClaudeConfigDir, repoOf, sweepClaudeConfigDirs } from './config-dirs.js';
export { removeMcpConfig, writeMcpConfig } from './mcp-config.js';
export {
  HOME_PLACEHOLDERS,
  placeholderSnapshot,
  removeSandboxPlaceholders,
  removeSandboxResidue,
  residueSnapshot,
  SANDBOX_ENV,
  SANDBOX_PLACEHOLDERS,
  type SandboxResidue,
} from './placeholders.js';
