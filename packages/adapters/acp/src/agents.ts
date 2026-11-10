import type { AdapterCapabilities, EnvAllow } from '@tacet/core';

/**
 * How to launch one ACP agent and what it honestly supports. Built-in specs below; any other
 * ACP agent is added by config as `acp:<slug>` (`customAcpAgent`), after Omnigent's custom ACP
 * agents (ADR-001: the idea, not the code).
 */
export interface AcpAgentSpec {
  /** Registry id, e.g. `gemini` or `acp:my-agent`. */
  id: string;
  /** The command and arguments that start the agent speaking ACP on stdio. */
  command: string[];
  /** Fixed environment additions, e.g. to hide a subscription login. Never credentials. */
  env?: Record<string, string>;
  /**
   * The user's variables this agent needs beyond the common base set (#147). `apiKeyEnv` is
   * always passed too; everything else of the user's environment is left out.
   */
  envAllow?: EnvAllow;
  /** Arguments that select a model at launch, when the agent has no `model` config option. */
  modelArgs?: (model: string) => string[];
  /**
   * The environment variables that hold an API key for this agent (any one is enough). A Worker
   * only starts when one is set: the API key is the only route for unattended Workers (owner
   * decision 2026-11-09; #65 stays open). Empty for agents with no key of their own.
   */
  apiKeyEnv: readonly string[];
  /**
   * ACP auth method ids that use an API key from the environment. The adapter calls
   * `authenticate` only with one of these, and only if the agent offers it; never with a
   * subscription or browser login method.
   */
  apiKeyAuthMethods: readonly string[];
  /**
   * What this agent supports through this adapter. Declared, not negotiated: a declared resume
   * still fails at start if the agent's `initialize` offers neither `session/resume` nor
   * `session/load`.
   */
  capabilities: AdapterCapabilities;
  /** Version the spec was verified against, for the capability matrix. */
  verifiedVersion?: string;
}

/** Capabilities every ACP v1 agent can offer through this adapter. */
const ACP_BASE: AdapterCapabilities = {
  streaming: true,
  // A prompt turn is one request; input sent meanwhile is queued as the next turn.
  liveInput: false,
  approvals: 'roundtrip',
  interrupt: 'turn',
  resume: false,
  fork: 'none',
  usage: { live: false, context: false, cost: 'none' },
  modelSwitch: 'launch-only',
  injectContext: false,
};

/**
 * Gemini CLI, verified live on 0.67.0 against a local Gemini API mock (#13; spikes #61, #63):
 * `gemini --acp`, `-m <model>`, `authenticate` with `gemini-api-key` and `GEMINI_API_KEY`,
 * `loadSession: true` (resume by `session/load`), `usage_update` with `used` and `size` after
 * every model response (no cost), no `model` config option.
 */
export const GEMINI_AGENT: AcpAgentSpec = {
  id: 'gemini',
  command: ['gemini', '--acp'],
  modelArgs: (model) => ['--model', model],
  // Verified on 0.67.0 (capability matrix §5, "Worker environment"): the CLI's own `GEMINI_*`
  // settings, and the API-key route's base URL and API version. Not the rest of `GOOGLE_*`,
  // which selects the Vertex and Code Assist routes.
  envAllow: {
    prefixes: ['GEMINI_'],
    names: ['GOOGLE_GEMINI_BASE_URL', 'GOOGLE_GENAI_API_VERSION', 'NO_BROWSER'],
  },
  // Only the Gemini API key: `GOOGLE_API_KEY` is the Vertex AI route, not verified here.
  apiKeyEnv: ['GEMINI_API_KEY'],
  apiKeyAuthMethods: ['gemini-api-key'],
  capabilities: {
    ...ACP_BASE,
    resume: true,
    usage: { live: true, context: true, cost: 'none' },
  },
  verifiedVersion: '@google/gemini-cli 0.67.0',
};

/**
 * Claude Code through `@agentclientprotocol/claude-agent-acp` (spike #62, 0.101.1; not run live
 * here). Not in `BUILTIN_ACP_AGENTS`: that it uses `ANTHROPIC_API_KEY` over a subscription login
 * already in `~/.claude` is not verified yet (#145). `--hide-claude-auth` hides the "Claude Subscription" login: Workers use
 * `ANTHROPIC_API_KEY` only (owner decision 2026-11-09). The native Agent SDK adapter stays first
 * choice.
 */
export const CLAUDE_ACP_AGENT: AcpAgentSpec = {
  id: 'claude-acp',
  command: ['claude-agent-acp', '--hide-claude-auth'],
  envAllow: { prefixes: ['ANTHROPIC_', 'CLAUDE_'] },
  apiKeyEnv: ['ANTHROPIC_API_KEY'],
  apiKeyAuthMethods: [],
  capabilities: { ...ACP_BASE, usage: { live: true, context: true, cost: 'none' } },
};

/**
 * Codex through `@agentclientprotocol/codex-acp` (spike #62, 2.6.0; not run live here). Not in
 * `BUILTIN_ACP_AGENTS`: what its `api-key` method does to the user's `~/.codex` login is not
 * verified yet (#145; Codex app-server needs its own `CODEX_HOME` for a key, capability matrix §2).
 * `NO_BROWSER=1` hides the ChatGPT login; the `api-key` method reads `CODEX_API_KEY` or
 * `OPENAI_API_KEY`. The native app-server adapter stays first choice.
 */
export const CODEX_ACP_AGENT: AcpAgentSpec = {
  id: 'codex-acp',
  command: ['codex-acp'],
  env: { NO_BROWSER: '1' },
  envAllow: { prefixes: ['CODEX_', 'OPENAI_'] },
  apiKeyEnv: ['CODEX_API_KEY', 'OPENAI_API_KEY'],
  apiKeyAuthMethods: ['api-key'],
  capabilities: { ...ACP_BASE, usage: { live: true, context: true, cost: 'none' } },
};

/**
 * The agents a Worker can be configured with by id: only those whose API-key-only auth was
 * verified live. Claude and Codex have native adapters; their ACP specs join once verified.
 */
export const BUILTIN_ACP_AGENTS: Readonly<Record<string, AcpAgentSpec>> = {
  gemini: GEMINI_AGENT,
};

/** Config for an ACP agent that has no built-in spec. */
export interface CustomAcpAgentConfig {
  command: string[];
  env?: Record<string, string>;
  apiKeyEnv?: string[];
  apiKeyAuthMethods?: string[];
  /**
   * Declared support beyond the ACP baseline. Only what this adapter can deliver for any agent:
   * resume (by `session/resume` or `session/load`) and usage reporting.
   */
  capabilities?: Partial<Pick<AdapterCapabilities, 'resume' | 'usage'>>;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** `acp:<slug>`: any ACP agent, added by config. Declares only the ACP baseline by default. */
export function customAcpAgent(slug: string, cfg: CustomAcpAgentConfig): AcpAgentSpec {
  if (!SLUG.test(slug)) throw new Error(`invalid ACP agent slug ${JSON.stringify(slug)}`);
  if (cfg.command.length === 0 || cfg.command.some((a) => typeof a !== 'string' || a === '')) {
    throw new Error(`acp:${slug}: command must be a non-empty list of strings`);
  }
  return {
    id: `acp:${slug}`,
    command: [...cfg.command],
    ...(cfg.env ? { env: { ...cfg.env } } : {}),
    apiKeyEnv: [...(cfg.apiKeyEnv ?? [])],
    apiKeyAuthMethods: [...(cfg.apiKeyAuthMethods ?? [])],
    capabilities: {
      ...ACP_BASE,
      ...(cfg.capabilities?.resume !== undefined ? { resume: cfg.capabilities.resume } : {}),
      ...(cfg.capabilities?.usage ? { usage: { ...cfg.capabilities.usage } } : {}),
    },
  };
}
