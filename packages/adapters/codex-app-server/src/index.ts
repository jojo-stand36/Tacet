/** Codex adapter over the Codex app-server JSON-RPC protocol (issue #12). */
export const packageName = '@tacet/adapter-codex-app-server' as const;

// Safe worktree handling now lives in @tacet/core/node (shared with the Mini-conductor, #119).
export {
  SAFE_GIT_ARGS,
  trustedGitEnv,
  type WorkerWorktree,
  workerGitEnv,
  workerWorktree,
} from '@tacet/core/node';
export {
  CODEX_CAPABILITIES,
  CODEX_VERSION,
  type CodexAdapterOptions,
  CodexAppServerAdapter,
  configArgs,
  grantSubset,
  toCodexDecision,
} from './adapter.js';
export {
  API_KEY_PROVIDER_ID,
  AuthRoutingError,
  type CodexAuthRoute,
  type CodexLaunch,
  chooseAuthRoute,
  codexLaunch,
  OPENAI_API_BASE_URL,
} from './auth.js';
