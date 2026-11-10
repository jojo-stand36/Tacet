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
  /**
   * Fixed environment additions, e.g. to hide a subscription login. A credential here only comes
   * from a secret reference resolved at startup (#149), and its value is then also passed as
   * `AcpAdapterOptions.secrets` so it is scrubbed; never write one into code or config.
   */
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
  /**
   * A home of the agent's own that Tacet prepares (#150): the directory, private to the user and
   * kept per repo so sessions resume, is passed in `env`, and `files` (paths relative to it) are
   * written there before every session. Used to give the agent settings without the user's.
   */
  home?: { env: string; files: Readonly<Record<string, string>> };
  /** Variables never passed to the agent, whatever the allowlist or the user's passthrough. */
  envDeny?: readonly string[];
  /**
   * The ACP session mode every session is put in right after it opens (#145), for agents whose
   * default runs tools without asking. Set by the `mode` config option, or `session/set_mode` when
   * the agent has none; a session the agent can't put in this mode fails to start. The mode
   * holds for the session: "always" approvals are answered once, and if the agent reports another
   * mode the turn is cancelled and the mode set back. Only the config option's answer shows the
   * switch; `session/set_mode` answers nothing, so there the agent is trusted.
   */
  sessionMode?: string;
  /**
   * `_meta` sent with `session/new`, `session/load` and `session/resume`, for agent-specific
   * session options (e.g. claude-agent-acp's `claudeCode.options`, #181).
   */
  sessionMeta?: Readonly<Record<string, unknown>>;
  /**
   * Why unattended Workers may not run on this agent, if they may not: `buildWorkerAdapters`
   * refuses a Worker tier that names it. Direct (interactive) use of the adapter is unaffected.
   */
  workerRefused?: string;
}

/**
 * Gemini CLI settings for Workers (#150), verified live on 0.67.0 over ACP: with them, a shell
 * command the Worker runs gets no `GEMINI_API_KEY` (redaction drops secret-looking names, and
 * never lets one back in through `allowed`), and no `.env` of the checkout or its parents is
 * loaded (`ignoreLocalEnv`). The user's `~/.env` stays out because Gemini looks for it in its
 * home, which is `GEMINI_CLI_HOME`. They only take effect as user settings: the system settings
 * and system defaults paths had no effect in ACP mode, and `--ignore-env` is refused by the
 * argument parser.
 */
export const GEMINI_WORKER_SETTINGS = {
  security: {
    environmentVariableRedaction: { enabled: true },
    // Already the default on 0.67.0, stated so a changed default cannot trust a checkout: an
    // untrusted folder loads none of its `.gemini/settings.json` (MCP servers, hooks), GEMINI.md,
    // skills, agents or `.gemini/.env` (#181, verified live).
    folderTrust: { enabled: true },
  },
  advanced: { ignoreLocalEnv: true },
};

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
  // Its own `.gemini` root with the Worker settings, never the user's `~/.gemini` (#150).
  home: {
    env: 'GEMINI_CLI_HOME',
    files: { '.gemini/settings.json': `${JSON.stringify(GEMINI_WORKER_SETTINGS, null, 2)}\n` },
  },
  // It would trust the checkout, and a trusted folder's `.gemini/.env` loads whatever
  // `ignoreLocalEnv` says (bundle `findEnvFile`).
  envDeny: ['GEMINI_CLI_TRUST_WORKSPACE'],
};

/**
 * Claude Code through `@agentclientprotocol/claude-agent-acp`, verified live on 0.101.0 (Agent SDK
 * 0.3.318) against the mock Messages API with a subscription login already in the user's
 * `~/.claude` (#145): every request carried `ANTHROPIC_API_KEY`, and the stored login was neither
 * used nor changed. Run with the user's own config dir it writes there (`~/.claude.json`, a
 * backup of it, transcripts, a plugin store), so it gets a config dir of its own
 * (`CLAUDE_CONFIG_DIR`, under the repo's state dir). `--hide-claude-auth` hides the "Claude
 * Subscription" login: Workers use `ANTHROPIC_API_KEY` only (owner decision 2026-11-09). Its Bash
 * tool sees the key until the scrub is decided (#150). The native Agent SDK adapter stays first
 * choice.
 */
export const CLAUDE_ACP_AGENT: AcpAgentSpec = {
  id: 'claude-acp',
  command: ['claude-agent-acp', '--hide-claude-auth'],
  envAllow: { prefixes: ['ANTHROPIC_', 'CLAUDE_'] },
  apiKeyEnv: ['ANTHROPIC_API_KEY'],
  apiKeyAuthMethods: [],
  capabilities: { ...ACP_BASE, usage: { live: true, context: true, cost: 'none' } },
  verifiedVersion: '@agentclientprotocol/claude-agent-acp 0.101.0',
  home: { env: 'CLAUDE_CONFIG_DIR', files: {} },
  // Never a subscription or gateway token, whatever the user passes through (#145).
  envDeny: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'],
  // It starts in `auto` ("Claude handles permission decisions") and runs tools unasked; `default`
  // ("Manual: always ask before making changes") sends `session/request_permission` (verified).
  sessionMode: 'default',
  // It loads the user's, the project's and the local settings by default: the checkout's hooks,
  // permissions, env, CLAUDE.md and `.mcp.json`, all files a Worker can write. Client options in
  // `_meta.claudeCode.options` override that (0.101.0 `acp-agent.js`; #181, verified live).
  sessionMeta: { claudeCode: { options: { settingSources: [], strictMcpConfig: true } } },
};

/**
 * claude-agent-acp session options for an unattended Worker (#206), merged into
 * `_meta.claudeCode.options` (passed to the SDK's `query()`, 0.101.0 `acp-agent.js`): the file
 * tools only and no shell. Not `Glob` or `Grep`: the SDK runs them without asking, and over ACP
 * there is no hook to ask with. Verified against the mock API by the vendor conformance test.
 */
export const CLAUDE_ACP_WORKER_OPTIONS = {
  tools: ['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep'],
  disallowedTools: ['Bash', 'PowerShell', 'Monitor'],
  // Ask rules come before a tool's own approval of a read inside its working directory, so every
  // read and search reaches `canUseTool`, which claude-agent-acp turns into
  // `session/request_permission` (#214). Inline: the flag layer, which `settingSources: []` does
  // not drop; never a path, which would resolve inside the Worker's checkout.
  settings: { permissions: { ask: ['Read', 'Glob', 'Grep'] } },
} as const;

/** `spec` with `CLAUDE_ACP_WORKER_OPTIONS` merged into its `_meta.claudeCode.options`. */
export function claudeAcpWorkerSpec(spec: AcpAgentSpec): AcpAgentSpec {
  const meta = (spec.sessionMeta ?? {}) as { claudeCode?: { options?: Record<string, unknown> } };
  return {
    ...spec,
    sessionMeta: {
      ...meta,
      claudeCode: {
        ...meta.claudeCode,
        options: {
          ...meta.claudeCode?.options,
          tools: [...CLAUDE_ACP_WORKER_OPTIONS.tools],
          disallowedTools: [...CLAUDE_ACP_WORKER_OPTIONS.disallowedTools],
          settings: {
            permissions: { ask: [...CLAUDE_ACP_WORKER_OPTIONS.settings.permissions.ask] },
          },
        },
      },
    },
  };
}

/** The model provider codex-acp's Codex uses for Workers: the key comes from the environment. */
export const CODEX_ACP_PROVIDER = 'tacet-openai-api-key';

/** `config.toml` for codex-acp's own `CODEX_HOME` (#145); `baseUrl` is for tests. */
export function codexAcpConfig(baseUrl = 'https://api.openai.com/v1'): string {
  return [
    `model_provider = "${CODEX_ACP_PROVIDER}"`,
    '',
    `[model_providers.${CODEX_ACP_PROVIDER}]`,
    'name = "OpenAI (API key, via Tacet)"',
    `base_url = ${JSON.stringify(baseUrl)}`,
    'env_key = "OPENAI_API_KEY"',
    'wire_api = "responses"',
    '',
    '# No plugin sync from GitHub when a Worker starts (as the native adapter, #116).',
    '[features]',
    'plugins = false',
    '',
    '# The commands the Worker runs never see the key (as the native adapter, #150).',
    '[shell_environment_policy]',
    'exclude = ["OPENAI_API_KEY", "CODEX_API_KEY"]',
    '',
  ].join('\n');
}

/**
 * Codex through `@agentclientprotocol/codex-acp`, verified live on 2.6.0 (Codex 0.166.0) against
 * the mock Responses API with a ChatGPT login already in the user's `~/.codex` (#145). Its
 * `api-key` auth method is never used: it runs Codex's `account/login/start`, which replaced the
 * user's ChatGPT login in `~/.codex/auth.json` with the key, on disk; and in `~/.codex` it also
 * synced a plugin marketplace from GitHub. So it gets a `CODEX_HOME` of its own (under the repo's
 * state dir) whose config routes through a model provider with `env_key`, as the native adapter
 * does: verified, it starts sessions without any login, every request carried the key, no
 * `auth.json` is written, the user's `~/.codex` is untouched, and the commands Codex runs see no
 * key. `NO_BROWSER=1` hides the ChatGPT login. The native app-server adapter stays first choice.
 */
export const CODEX_ACP_AGENT: AcpAgentSpec = {
  id: 'codex-acp',
  command: ['codex-acp'],
  // Interim default while the owner decides #183: verified live (#181), it marks every session
  // root trusted after any config Tacet can pass, so a Worker-written checkout's
  // `.codex/config.toml` (an MCP server command ran) and AGENTS.md apply.
  workerRefused:
    'it trusts every session directory itself, so a checkout a Worker or anyone else wrote can run commands through its .codex/config.toml; Tacet cannot turn that off (interim default until #183 is decided; use codex-app-server)',
  env: { NO_BROWSER: '1' },
  envAllow: { prefixes: ['CODEX_', 'OPENAI_'] },
  apiKeyEnv: ['OPENAI_API_KEY'],
  apiKeyAuthMethods: [],
  capabilities: { ...ACP_BASE, usage: { live: true, context: true, cost: 'none' } },
  verifiedVersion: '@agentclientprotocol/codex-acp 2.6.0',
  home: { env: 'CODEX_HOME', files: { 'config.toml': codexAcpConfig() } },
  // `CODEX_API_KEY` would be a second key route besides the provider's `env_key` (#145).
  envDeny: ['CODEX_API_KEY'],
  // It starts in `agent` ("Auto review: only ask for actions detected as potentially unsafe").
  // `workspace-write` is the native adapter's default (`on-request`): edits in the checkout run in
  // the sandbox, and leaving it (other files, the network) asks. `read-only` asks for every edit.
  sessionMode: 'workspace-write',
};

/**
 * The agents a Worker can be configured with by id: only those whose API-key-only auth was
 * verified live, each with a home of its own so the user's login is never used or changed.
 */
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
