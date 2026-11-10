import {
  AcpAdapter,
  type AcpAdapterOptions,
  type AcpAgentSpec,
  BUILTIN_ACP_AGENTS,
  claudeAcpWorkerSpec,
  customAcpAgent,
} from '@tacet/adapter-acp';
import { ClaudeSdkAdapter, type ClaudeSdkAdapterOptions } from '@tacet/adapter-claude-sdk';
import { type CodexAdapterOptions, CodexAppServerAdapter } from '@tacet/adapter-codex-app-server';
import {
  PtyAdapter,
  type PtyAdapterOptions,
  PtyCliAdapter,
  type PtyCliAdapterOptions,
} from '@tacet/adapter-pty';
import { type AgentAdapter, type TacetConfig, workerEnvPolicy } from '@tacet/core';
import { type KeychainOptions, resolveSecretRef, SecretRefError } from '@tacet/core/node';
import type { WorkerAdapter } from '../daemon/ports.js';
import { reviewConfigProblem } from '../review/config.js';

/** The config cannot be turned into Workers. Names the config path, never a secret value. */
export class WorkerConfigError extends Error {
  override name = 'WorkerConfigError';
}

export interface BuildWorkerAdaptersOptions {
  /**
   * The repo the Workers work on: keys per-repo adapter state (Claude PTY sessions, #153; ACP
   * agent homes, #150; Codex's `CODEX_HOME`, #186). Codex Workers in a git checkout need it.
   */
  repoRoot?: string;
  /**
   * The user's environment: what Workers get an allowlist of, and where `{ env }` secret
   * references are read. One snapshot for both. Default `process.env`.
   */
  baseEnv?: Record<string, string | undefined>;
  /**
   * Told the names (never values) of the variables left out of a session's environment. Called
   * on every session start, so a caller that logs it should log each adapter's names once.
   */
  onEnvDropped?: (adapterId: string, names: string[]) => void;
  /** How `{ keychain }` secret references are read (#160); replaced in tests. */
  keychain?: KeychainOptions;
  /** Passed through to the adapters as they are built; for tests and the entry point. */
  claude?: Pick<ClaudeSdkAdapterOptions, 'query' | 'mcpConfigDir' | 'onSweep' | 'sdkOptions'>;
  codex?: Pick<CodexAdapterOptions, 'apiBaseUrl' | 'codexPath' | 'killTimeoutMs' | 'stateDir'>;
  acp?: Pick<AcpAdapterOptions, 'executable' | 'killTimeoutMs' | 'stderr' | 'stateDir'>;
  /** For the built-in `pty:claude` (Claude Code in a terminal), e.g. the resolved `events.state_dir`. */
  claudePty?: Pick<PtyAdapterOptions, 'command' | 'repoRoot' | 'stateDir' | 'spawn'>;
  /** For `pty:<slug>` presets. */
  ptyCli?: Pick<PtyCliAdapterOptions, 'spawn' | 'quietMs' | 'startTimeoutMs' | 'killTimeoutMs'>;
  /**
   * Also build the planner's adapter (`tiers.mini`, #21), with the same checks, when that tier is
   * set. It is keyed by its id like the others; the standalone entry point hands it to the
   * `AdapterPlanner`.
   */
  withPlanner?: boolean;
}

/**
 * The ACP agent spec a Worker runs on: a Claude Worker over ACP gets the file tools only, no
 * shell, every read and search asked about, and verbatim prompts, as the SDK adapter's
 * `fileToolsOnly` does (#206, #214, `claudeAcpWorkerSpec`).
 */
function workerSpec(spec: AcpAgentSpec): AcpAgentSpec {
  return spec.id === 'claude-acp' ? claudeAcpWorkerSpec(spec) : spec;
}

/** PTY presets built in, by slug; `agents.<slug>` may not reuse these names. */
const BUILTIN_PTY = ['claude'];
const ACP_ID = /^acp:([a-z0-9][a-z0-9-]*)$/;
const PTY_ID = /^pty:([a-z0-9][a-z0-9-]*)$/;

/** The tiers whose adapters the Mini-conductor runs Workers on; `tiers.mini` is the planner's. */
const WORKER_TIERS = ['worker', 'review'] as const;

/**
 * Builds the Worker adapters the effective config asks for (#149): one per adapter id that a
 * Worker tier (`tiers.worker`, `tiers.review`) names (`claude-sdk`, `codex-app-server`,
 * `acp:<agent>`, `pty:claude`, `pty:<preset>`), keyed by that id, each on the `api_key`
 * route (owner decision, #65) and with the Worker environment policy (`workers.env.pass`, #147).
 * Secret references of the agents used are resolved here, from `baseEnv`, and handed to the
 * adapter to scrub; agents no tier uses are not resolved, so their references cannot block start.
 * Every problem is a `WorkerConfigError` naming the tier or config path.
 */
export function buildWorkerAdapters(
  config: TacetConfig,
  opts: BuildWorkerAdaptersOptions = {},
): Record<string, WorkerAdapter> {
  // A keychain item two agents reference is read once: each read may block (it is synchronous,
  // up to its timeout) or wait on a prompt.
  const fromKeychain = new Map<string, string>();

  const tiers = config.tiers ?? {};
  if (!tiers.worker) throw new WorkerConfigError('config has no tiers.worker');
  // Cross-vendor review (#19) is checked before anything is built or any secret is read.
  const reviewProblem = reviewConfigProblem(config);
  if (reviewProblem) throw new WorkerConfigError(reviewProblem);
  const baseEnv = opts.baseEnv ?? process.env;
  const envPolicy = workerEnvPolicy(config);
  const out: Record<string, WorkerAdapter> = {};
  for (const name of opts.withPlanner ? [...WORKER_TIERS, 'mini' as const] : WORKER_TIERS) {
    const tier = tiers[name];
    if (!tier) continue;
    const id = tier.adapter;
    const where = `tiers.${name}.adapter`;
    const adapter = out[id]?.adapter ?? build(id, where);
    const caps = adapter.capabilities();
    if (tier.model === undefined && (id === 'claude-sdk' || id === 'codex-app-server')) {
      throw new WorkerConfigError(`tiers.${name}.model: ${id} needs a model`);
    }
    // A generic CLI's command fixes its model (#158): a tier model would be refused at every start.
    if (tier.model !== undefined && adapter instanceof PtyCliAdapter) {
      throw new WorkerConfigError(
        `tiers.${name}.model: ${id} cannot choose a model (its command fixes it); remove it from the tier`,
      );
    }
    if (tier.effort !== undefined && caps.effortSwitch === undefined) {
      throw new WorkerConfigError(
        `tiers.${name}.effort: ${id} does not set a reasoning effort; remove it from the tier`,
      );
    }
    out[id] = { adapter, authRoute: 'api_key' };
  }
  for (const id of Object.keys(config.workers?.per_adapter ?? {})) {
    // Capping an adapter that can never be built would silently cap nothing.
    if (!out[id]) buildable(id, `workers.per_adapter.${id}`);
  }
  return out;

  function build(id: string, where: string): AgentAdapter {
    const dropped = (names: string[]) => opts.onEnvDropped?.(id, names);
    const common = { baseEnv, envPolicy, onEnvDropped: dropped };
    if (id === 'claude-sdk') {
      // Unattended: file tools only, no shell, reads asked about too (#206; policy #200).
      return new ClaudeSdkAdapter({
        ...opts.claude,
        ...common,
        authRoute: 'api_key',
        fileToolsOnly: true,
      });
    }
    if (id === 'codex-app-server') {
      return new CodexAppServerAdapter({
        // An unattended Codex Worker in a git checkout needs it: its own CODEX_HOME is keyed by
        // the repo, and its worktree is checked against it before git runs (#116, #186).
        ...(opts.repoRoot !== undefined ? { repoRoot: opts.repoRoot } : {}),
        ...opts.codex,
        ...common,
        authRoute: 'api_key',
      });
    }
    const slug = ACP_ID.exec(id)?.[1];
    if (slug !== undefined) {
      const { agent, secrets } = acpAgent(slug, where);
      // Its sessions' files are kept as long as the event log keeps transcripts (#232).
      const days = config.events?.retention?.transcript_days;
      return new AcpAdapter({
        ...(days !== undefined ? { retentionDays: days } : {}),
        ...(opts.repoRoot !== undefined ? { repoRoot: opts.repoRoot } : {}),
        ...opts.acp,
        ...common,
        agent,
        secrets,
      });
    }
    const ptySlug = PTY_ID.exec(id)?.[1];
    if (ptySlug === 'claude') {
      noShadow(ptySlug, true, 'pty', 'PTY preset');
      // Its sessions' transcripts are kept as long as the event log keeps transcripts (#153).
      const days = config.events?.retention?.transcript_days;
      return new PtyAdapter({
        ...(days !== undefined ? { retentionDays: days } : {}),
        ...(opts.repoRoot !== undefined ? { repoRoot: opts.repoRoot } : {}),
        ...opts.claudePty,
        ...common,
      });
    }
    if (ptySlug !== undefined) {
      const preset = config.agents?.[ptySlug];
      if (!preset) {
        throw new WorkerConfigError(
          `${where}: no PTY preset "${ptySlug}" (built in: ${BUILTIN_PTY.join(', ')}; or add agents.${ptySlug} with kind: pty)`,
        );
      }
      if (preset.kind !== 'pty') {
        throw new WorkerConfigError(
          `${where}: agents.${ptySlug} is of kind ${preset.kind}; use ${preset.kind}:${ptySlug}`,
        );
      }
      refusePtyForWorkers(ptySlug, where);
      const env = resolveEnv(ptySlug, preset.env);
      return new PtyCliAdapter({
        ...opts.ptyCli,
        ...common,
        slug: ptySlug,
        preset: {
          command: preset.command,
          env,
          secrets: Object.values(env),
          ...(preset.ready_prompt !== undefined ? { readyPrompt: preset.ready_prompt } : {}),
          ...(preset.resume_flag !== undefined ? { resumeArgs: [preset.resume_flag].flat() } : {}),
          // Gemini CLI reads an `@path` in a prompt unasked, or after a Yes-by-default question
          // (#245): its prompts are typed with every `@` escaped.
          ...(runs(preset.command, runsGemini) ? { escapeAt: true } : {}),
        },
      });
    }
    buildable(id, where);
    throw new WorkerConfigError(`${where}: ${id} cannot be built`);
  }

  /** A preset of the same kind under a built-in name would be ambiguous: refuse it. */
  function noShadow(slug: string, builtin: boolean, kind: 'acp' | 'pty', what: string): void {
    if (builtin && config.agents?.[slug]?.kind === kind) {
      throw new WorkerConfigError(
        `agents.${slug}: "${slug}" is a built-in ${what}; give your agent another name`,
      );
    }
  }

  /** The agent's secret references, resolved from `baseEnv` or the keychain. */
  function resolveEnv(
    slug: string,
    refs: NonNullable<TacetConfig['agents']>[string]['env'],
  ): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [name, ref] of Object.entries(refs ?? {})) {
      try {
        const known = 'keychain' in ref ? fromKeychain.get(ref.keychain) : undefined;
        env[name] =
          known ??
          resolveSecretRef(ref, `agents.${slug}.env.${name}`, baseEnv, {
            ...(opts.keychain ? { keychain: opts.keychain } : {}),
          }).reveal();
        if ('keychain' in ref) fromKeychain.set(ref.keychain, env[name]);
      } catch (err) {
        if (err instanceof SecretRefError) throw new WorkerConfigError(err.message, { cause: err });
        throw err;
      }
    }
    return env;
  }

  function acpAgent(slug: string, where: string): { agent: AcpAgentSpec; secrets: string[] } {
    const preset = config.agents?.[slug];
    const builtin = BUILTIN_ACP_AGENTS[slug];
    noShadow(slug, builtin !== undefined, 'acp', 'ACP agent');
    refuseForWorkers(slug, where);
    if (builtin) return { agent: workerSpec(builtin), secrets: [] };
    if (!preset) {
      throw new WorkerConfigError(
        `${where}: no ACP agent "${slug}" (built in: ${Object.keys(BUILTIN_ACP_AGENTS).join(', ')}; or add agents.${slug} with kind: acp)`,
      );
    }
    if (preset.kind !== 'acp') {
      throw new WorkerConfigError(
        `${where}: agents.${slug} is of kind ${preset.kind}; use ${preset.kind}:${slug}`,
      );
    }
    const env = resolveEnv(slug, preset.env);
    return {
      agent: customAcpAgent(slug, { command: preset.command, env }),
      secrets: Object.values(env),
    };
  }

  /**
   * Throws for an ACP agent unattended Workers may not use (`AcpAgentSpec.workerRefused`): a
   * built-in one, or a custom `agents.<slug>` whose command runs it (e.g. codex-acp through `npx`,
   * #183). A wrapper script can still hide the command; the reason is documented.
   */
  function refuseForWorkers(slug: string, where: string): void {
    const builtin = BUILTIN_ACP_AGENTS[slug];
    const preset = builtin ? undefined : config.agents?.[slug];
    const runs =
      preset?.kind === 'acp'
        ? Object.values(BUILTIN_ACP_AGENTS).find(
            (a) =>
              a.workerRefused &&
              // Each word of each argument, so `sh -c "exec codex-acp"` is caught too.
              preset.command
                .flatMap((arg) => arg.split(/\s+/))
                .some((w) => runsAgent(w, a.command[0] ?? '', a.id)),
          )
        : undefined;
    const refused = builtin?.workerRefused ?? runs?.workerRefused;
    if (refused) {
      throw new WorkerConfigError(`${where}: acp:${slug} is refused for Workers: ${refused}`);
    }
    // A custom preset running claude-agent-acp would get none of the built-in's Worker hardening
    // (no settings isolation, no pinned mode, a shell, unasked reads; #214): use the built-in.
    if (
      preset?.kind === 'acp' &&
      preset.command.flatMap((arg) => arg.split(/[\s;&|"'`()<>]+/)).some(runsClaudeAcp)
    ) {
      throw new WorkerConfigError(
        `${where}: agents.${slug} runs claude-agent-acp; use acp:claude-acp for Workers, which runs it with the Worker hardening (#214)`,
      );
    }
  }

  /**
   * Throws for a custom PTY preset that runs interactive Claude Code: it would get none of
   * `pty:claude`'s Worker hardening (hooks asking Tacet about every tool, isolated settings, and
   * no `@path` read into a prompt unasked, #226), so Workers use the built-in (#245).
   */
  function refusePtyForWorkers(slug: string, where: string): void {
    const preset = config.agents?.[slug];
    if (preset?.kind === 'pty' && runs(preset.command, runsClaudeCode)) {
      throw new WorkerConfigError(
        `${where}: agents.${slug} runs Claude Code; use pty:claude for Workers, which runs it with the Worker hardening (#245)`,
      );
    }
  }

  /** Throws unless `id` names an adapter this function can build. */
  function buildable(id: string, where: string): void {
    if (id === 'claude-sdk' || id === 'codex-app-server') return;
    const acp = ACP_ID.exec(id)?.[1];
    if (acp !== undefined && (BUILTIN_ACP_AGENTS[acp] || config.agents?.[acp]?.kind === 'acp')) {
      // A cap on an agent Workers may not use would silently cap nothing, too.
      refuseForWorkers(acp, where);
      return;
    }
    if (acp !== undefined) {
      throw new WorkerConfigError(`${where}: no ACP agent "${acp}"`);
    }
    const pty = PTY_ID.exec(id)?.[1];
    if (pty !== undefined && (BUILTIN_PTY.includes(pty) || config.agents?.[pty]?.kind === 'pty')) {
      if (!BUILTIN_PTY.includes(pty)) refusePtyForWorkers(pty, where);
      return;
    }
    if (pty !== undefined) {
      throw new WorkerConfigError(`${where}: no PTY preset "${pty}"`);
    }
    throw new WorkerConfigError(
      `${where}: no Worker adapter "${id}" yet (available: claude-sdk, codex-app-server, acp:<agent>, pty:<preset>)`,
    );
  }
}

/**
 * Whether a command word runs claude-agent-acp: its bin, its npm package (current, or the old
 * `@zed-industries/claude-code-acp`, renamed to it), or a path into its package directory
 * (`node .../claude-agent-acp/dist/index.js`). A wrapper script that hides it is not caught.
 */
function runsClaudeAcp(word: string): boolean {
  const base =
    word
      .split('/')
      .pop()
      ?.replace(/@[^@/]*$/, '') ?? '';
  return (
    ['claude-agent-acp', 'claude-code-acp'].includes(base) ||
    /(^|\/)(claude-agent-acp|claude-code-acp)(\/|@|$)/.test(word)
  );
}

/**
 * Whether `command` may run what `test` recognises, failing closed (#245 review): a word that
 * names what it runs (`commandWords`), or any other word of it that is not an option's value, so a
 * launcher `commandWords` does not model (`timeout 60 claude`, `env -u X claude`, `mise exec --
 * gemini`) is still caught. `aider --model claude` is not; `sh -c 'cd ~/claude && aider'` is (a
 * loud false positive is the safe direction).
 */
export function runs(command: string[], test: (word: string) => boolean): boolean {
  if (commandWords(command).some(test)) return true;
  const words = command.flatMap((arg) => arg.split(/[\s;&|"'`()<>=]+/)).filter(Boolean);
  return words.some((w, i) => {
    const prev = words[i - 1];
    return test(w) && (prev === undefined || prev === '--' || !prev.startsWith('-'));
  });
}

const LAUNCHERS = new Set(['env', 'npx', 'bunx', 'pnpx', 'node', 'deno', 'exec', 'nohup']);
const RUNNERS = new Set(['npm', 'pnpm', 'yarn']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);

/**
 * The words of a command line that name what it runs (#245 review): the executable, what a
 * launcher runs (`env`, `npx`, `node`, `exec`, `pnpm dlx`: the first word that is not an option
 * or a `NAME=value`), and each command of a `sh -c` script. Arguments are not, so
 * `aider --model claude` runs aider. A wrapper script that hides the CLI is not seen through.
 */
export function commandWords(argv: string[], depth = 0): string[] {
  const [head, ...rest] = argv;
  if (head === undefined || depth > 5) return [];
  const base = head.split('/').pop() ?? head;
  if (SHELLS.has(base)) {
    // `-c`, or combined short options that include it (`-lc`, `-ec`).
    const c = rest.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
    const script = c < 0 ? undefined : rest[c + 1];
    if (script === undefined) return [head];
    return [
      head,
      ...script.split(/[;&|()\n]+/).flatMap((cmd) =>
        commandWords(
          cmd
            .trim()
            .split(/\s+/)
            .map((w) => w.replace(/^["'`]+|["'`]+$/g, ''))
            .filter(Boolean),
          depth + 1,
        ),
      ),
    ];
  }
  let args = rest;
  if (RUNNERS.has(base)) {
    const sub = args.findIndex((a) => !a.startsWith('-'));
    if (sub < 0 || !['dlx', 'exec', 'x'].includes(args[sub] ?? '')) return [head];
    args = args.slice(sub + 1);
  } else if (!LAUNCHERS.has(base)) {
    return [head];
  }
  const next = args.findIndex((a) => !a.startsWith('-') && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(a));
  return next < 0 ? [head] : [head, ...commandWords(args.slice(next), depth + 1)];
}

/**
 * Whether a command word runs Claude Code: the `claude` bin (by name or path), its npm package
 * `@anthropic-ai/claude-code`, or the binary the Agent SDK bundles
 * (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude`). A wrapper script that hides it is
 * not caught.
 */
function runsClaudeCode(word: string): boolean {
  const base =
    word
      .split('/')
      .pop()
      ?.replace(/@[^@/]*$/, '') ?? '';
  return (
    base === 'claude' ||
    /(^|\/)@anthropic-ai\/claude-code(\/|@|$)/.test(word) ||
    /(^|\/)@anthropic-ai\/claude-agent-sdk-[^/]+\/claude$/.test(word)
  );
}

/**
 * Whether a command word runs Gemini CLI: the `gemini` bin (by name or path) or its npm package
 * `@google/gemini-cli` (`npx @google/gemini-cli`, `node .../@google/gemini-cli/bundle/gemini.js`).
 * A wrapper script that hides it is not caught.
 */
export function runsGemini(word: string): boolean {
  const base =
    word
      .split('/')
      .pop()
      ?.replace(/@[^@/]*$/, '') ?? '';
  return base === 'gemini' || /(^|\/)@google\/gemini-cli(\/|@|$)/.test(word);
}

/** Whether one word of a command runs `bin` (by name, path or npm package). */
function runsAgent(word: string, bin: string, id: string): boolean {
  const base =
    word
      .split('/')
      .pop()
      ?.replace(/@[^@/]*$/, '') ?? '';
  return base === bin || word.includes(`/${id}`) || base === id;
}
