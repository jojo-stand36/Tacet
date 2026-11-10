import {
  AcpAdapter,
  type AcpAdapterOptions,
  type AcpAgentSpec,
  BUILTIN_ACP_AGENTS,
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
import { resolveSecretRef, SecretRefError } from '@tacet/core/node';
import type { WorkerAdapter } from '../daemon/ports.js';

/** The config cannot be turned into Workers. Names the config path, never a secret value. */
export class WorkerConfigError extends Error {
  override name = 'WorkerConfigError';
}

export interface BuildWorkerAdaptersOptions {
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
  /** Passed through to the adapters as they are built; for tests and the entry point. */
  claude?: Pick<ClaudeSdkAdapterOptions, 'query' | 'mcpConfigDir' | 'onSweep' | 'sdkOptions'>;
  codex?: Pick<CodexAdapterOptions, 'apiBaseUrl' | 'codexPath' | 'killTimeoutMs'>;
  acp?: Pick<AcpAdapterOptions, 'executable' | 'killTimeoutMs' | 'stderr'>;
  /** For the built-in `pty:claude` (Claude Code in a terminal). */
  claudePty?: Pick<PtyAdapterOptions, 'command' | 'repoRoot' | 'stateDir' | 'spawn'>;
  /** For `pty:<slug>` presets. */
  ptyCli?: Pick<PtyCliAdapterOptions, 'spawn' | 'quietMs' | 'startTimeoutMs' | 'killTimeoutMs'>;
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
  const tiers = config.tiers ?? {};
  if (!tiers.worker) throw new WorkerConfigError('config has no tiers.worker');
  const baseEnv = opts.baseEnv ?? process.env;
  const envPolicy = workerEnvPolicy(config);
  const out: Record<string, WorkerAdapter> = {};
  for (const name of WORKER_TIERS) {
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
      return new ClaudeSdkAdapter({ ...opts.claude, ...common, authRoute: 'api_key' });
    }
    if (id === 'codex-app-server') {
      return new CodexAppServerAdapter({ ...opts.codex, ...common, authRoute: 'api_key' });
    }
    const slug = ACP_ID.exec(id)?.[1];
    if (slug !== undefined) {
      const { agent, secrets } = acpAgent(slug, where);
      return new AcpAdapter({ ...opts.acp, ...common, agent, secrets });
    }
    const ptySlug = PTY_ID.exec(id)?.[1];
    if (ptySlug === 'claude') {
      noShadow(ptySlug, true, 'PTY preset');
      return new PtyAdapter({ ...opts.claudePty, ...common });
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
        },
      });
    }
    buildable(id, where);
    throw new WorkerConfigError(`${where}: ${id} cannot be built`);
  }

  /** A preset under a built-in name would be ambiguous: refuse it. */
  function noShadow(slug: string, builtin: boolean, what: string): void {
    if (builtin && config.agents?.[slug]) {
      throw new WorkerConfigError(
        `agents.${slug}: "${slug}" is a built-in ${what}; give your agent another name`,
      );
    }
  }

  /** The agent's secret references, resolved from `baseEnv`. */
  function resolveEnv(
    slug: string,
    refs: NonNullable<TacetConfig['agents']>[string]['env'],
  ): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [name, ref] of Object.entries(refs ?? {})) {
      try {
        env[name] = resolveSecretRef(ref, `agents.${slug}.env.${name}`, baseEnv).reveal();
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
    noShadow(slug, builtin !== undefined, 'ACP agent');
    if (builtin) return { agent: builtin, secrets: [] };
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

  /** Throws unless `id` names an adapter this function can build. */
  function buildable(id: string, where: string): void {
    if (id === 'claude-sdk' || id === 'codex-app-server') return;
    const acp = ACP_ID.exec(id)?.[1];
    if (acp !== undefined && (BUILTIN_ACP_AGENTS[acp] || config.agents?.[acp]?.kind === 'acp')) {
      return;
    }
    if (acp !== undefined) {
      throw new WorkerConfigError(`${where}: no ACP agent "${acp}"`);
    }
    const pty = PTY_ID.exec(id)?.[1];
    if (pty !== undefined && (BUILTIN_PTY.includes(pty) || config.agents?.[pty]?.kind === 'pty')) {
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
