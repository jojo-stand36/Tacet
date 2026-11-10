import type { AdapterCapabilities } from '@tacet/core';

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
  /** What this agent supports; checked against its `initialize` answer at start. */
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
  apiKeyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
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
 * here). `--hide-claude-auth` hides the "Claude Subscription" login: Workers use
 * `ANTHROPIC_API_KEY` only (owner decision 2026-11-09). The native Agent SDK adapter stays first
 * choice.
 */
export const CLAUDE_ACP_AGENT: AcpAgentSpec = {
  id: 'claude-acp',
  command: ['claude-agent-acp', '--hide-claude-auth'],
  apiKeyEnv: ['ANTHROPIC_API_KEY'],
  apiKeyAuthMethods: [],
  capabilities: { ...ACP_BASE, usage: { live: true, context: true, cost: 'none' } },
};

/**
 * Codex through `@agentclientprotocol/codex-acp` (spike #62, 2.6.0; not run live here).
 * `NO_BROWSER=1` hides the ChatGPT login; the `api-key` method reads `CODEX_API_KEY` or
 * `OPENAI_API_KEY`. The native app-server adapter stays first choice.
 */
export const CODEX_ACP_AGENT: AcpAgentSpec = {
  id: 'codex-acp',
  command: ['codex-acp'],
  env: { NO_BROWSER: '1' },
  apiKeyEnv: ['CODEX_API_KEY', 'OPENAI_API_KEY'],
  apiKeyAuthMethods: ['api-key'],
  capabilities: { ...ACP_BASE, usage: { live: true, context: true, cost: 'none' } },
};

export const BUILTIN_ACP_AGENTS: Readonly<Record<string, AcpAgentSpec>> = {
  gemini: GEMINI_AGENT,
  'claude-acp': CLAUDE_ACP_AGENT,
  'codex-acp': CODEX_ACP_AGENT,
};

/** Config for an ACP agent that has no built-in spec. */
export interface CustomAcpAgentConfig {
  command: string[];
  env?: Record<string, string>;
  apiKeyEnv?: string[];
  apiKeyAuthMethods?: string[];
  /** Declared support beyond the ACP baseline; checked against `initialize` at start. */
  capabilities?: Partial<AdapterCapabilities>;
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
    capabilities: { ...ACP_BASE, ...cfg.capabilities },
  };
}
