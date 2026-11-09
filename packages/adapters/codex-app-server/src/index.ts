/** Codex adapter over the Codex app-server JSON-RPC protocol (issue #12). */
export const packageName = '@tacet/adapter-codex-app-server' as const;

export {
  CODEX_CAPABILITIES,
  CODEX_VERSION,
  type CodexAdapterOptions,
  CodexAppServerAdapter,
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
