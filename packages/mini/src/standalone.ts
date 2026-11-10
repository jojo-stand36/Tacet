import type { TacetConfig } from '@tacet/core';
import {
  type EventStore,
  loadConfig,
  openEventStore,
  type RepoStatePaths,
  repoStatePaths,
  resolveStateDir,
  WorkerTokens,
} from '@tacet/core/node';
import { MiniConductor } from './daemon/daemon.js';
import { AdapterPlanner, SingleStepPlanner } from './daemon/planner.js';
import type { Planner, Reviewer, WorkerAdapter } from './daemon/ports.js';
import { GitIntegrator } from './git/integrate.js';
import { GitWorktrees } from './git/worktrees.js';
import { EventLogBackend } from './mcp/backend.js';
import { MiniMcpServer } from './mcp/server.js';
import { AdapterReviewer } from './review/adapter-reviewer.js';
import { commandVerifierFromConfig } from './verify/command-verifier.js';
import { type BuildWorkerAdaptersOptions, buildWorkerAdapters } from './workers/build.js';

export interface StandaloneOptions {
  /** The repo's main checkout. */
  repoRoot: string;
  /** User config directory. Default `~/.tacet`. */
  userDir?: string;
  /** The user's environment: Workers get an allowlist of it. Default `process.env`. */
  baseEnv?: Record<string, string | undefined>;
  /** The home directory `~` in `events.state_dir` means. Default `os.homedir()`. */
  home?: string;
  /** Told the names (never values) of variables a Worker's environment left out. */
  onEnvDropped?: (adapterId: string, names: string[]) => void;
  /** Plan every task as one sub-task, even when `tiers.mini` is set. */
  singleStep?: boolean;
  /** Told about MCP server failures (message only). */
  onError?: (message: string) => void;
  /**
   * Passed through to `buildWorkerAdapters` (adapter executables, kill timeouts): for tests.
   * Never reachable from the command line.
   */
  workers?: Pick<BuildWorkerAdaptersOptions, 'acp' | 'codex' | 'claude' | 'ptyCli' | 'keychain'>;
  /** Tests only: these adapters instead of building them from config. */
  adapters?: Record<string, WorkerAdapter>;
}

/** A running standalone Mini-conductor and what it owns. */
export interface Standalone {
  mini: MiniConductor;
  store: EventStore;
  config: TacetConfig;
  paths: RepoStatePaths;
  /** Stop the Mini-conductor (open sessions recorded as `restart`), then the MCP server and log. */
  close(): Promise<void>;
}

/**
 * Standalone mode (#21): one Mini-conductor for one repo, without a Conductor, hosted by the
 * process that calls this (`tacet run`). Wires the existing pieces from the effective config:
 * Worker adapters (`buildWorkerAdapters`), the planner (`AdapterPlanner` on `tiers.mini`, else
 * one sub-task per task), `verify` commands, the reviewer when `review.enabled`, git integration,
 * interim git worktrees (until #16), and the Mini-conductor MCP server on loopback. Everything
 * lives in the repo's state directory, outside the repo. Throws `ConfigError`, `WorkerConfigError`
 * or the lock error before anything is left running.
 */
export async function startStandalone(o: StandaloneOptions): Promise<Standalone> {
  const loaded = loadConfig({ repoRoot: o.repoRoot, ...(o.userDir ? { userDir: o.userDir } : {}) });
  const config = loaded.config;
  const stateDir = resolveStateDir(config.events?.state_dir, o.repoRoot, o.home);
  const paths = repoStatePaths(o.repoRoot, stateDir);
  const baseEnv = o.baseEnv ?? process.env;
  const adapters =
    o.adapters ??
    buildWorkerAdapters(config, {
      ...o.workers,
      repoRoot: o.repoRoot,
      baseEnv,
      withPlanner: !o.singleStep,
      ...(o.onEnvDropped ? { onEnvDropped: o.onEnvDropped } : {}),
      codex: { ...o.workers?.codex, stateDir },
      acp: { ...o.workers?.acp, stateDir },
    });
  const tiers = config.tiers ?? {};
  let planner: Planner = new SingleStepPlanner();
  if (!o.singleStep && tiers.mini) {
    const worker = adapters[tiers.mini.adapter];
    if (!worker) throw new Error(`tiers.mini.adapter ${tiers.mini.adapter} was not built`);
    planner = new AdapterPlanner({
      worker,
      adapterId: tiers.mini.adapter,
      ...(tiers.mini.model !== undefined ? { model: tiers.mini.model } : {}),
      ...(tiers.mini.effort !== undefined ? { effort: tiers.mini.effort } : {}),
      cwd: o.repoRoot,
    });
  }
  let reviewer: Reviewer | undefined;
  if (config.review?.enabled && tiers.review) {
    const worker = adapters[tiers.review.adapter];
    if (!worker) throw new Error(`tiers.review.adapter ${tiers.review.adapter} was not built`);
    reviewer = new AdapterReviewer({
      worker,
      adapterId: tiers.review.adapter,
      ...(tiers.review.model !== undefined ? { model: tiers.review.model } : {}),
      ...(tiers.review.effort !== undefined ? { effort: tiers.review.effort } : {}),
      diff: { repoRoot: o.repoRoot, env: baseEnv },
    });
  }

  const store = openEventStore(paths.events);
  let server: MiniMcpServer | undefined;
  try {
    server = await MiniMcpServer.start({
      backend: new EventLogBackend({ store, repo: paths.repoId, miniId: 'standalone' }),
      tokens: new WorkerTokens(),
      ...(o.onError ? { onError: o.onError } : {}),
    });
    const mini = new MiniConductor({
      store,
      config,
      adapters,
      workspaces: new GitWorktrees({ repoRoot: o.repoRoot, root: paths.worktrees, env: baseEnv }),
      planner,
      verifier: commandVerifierFromConfig(config, { repoRoot: o.repoRoot, baseEnv }),
      ...(reviewer ? { reviewer } : {}),
      integrator: new GitIntegrator(o.repoRoot, baseEnv),
      mcp: server,
      lockPath: paths.lock,
      repo: paths.repoId,
      miniId: 'standalone',
    });
    await mini.start();
    const mcp = server;
    let closed: Promise<void> | undefined;
    return {
      mini,
      store,
      config,
      paths,
      close: () => {
        closed ??= (async () => {
          try {
            await mini.stop();
          } finally {
            await mcp.close();
            store.close();
          }
        })();
        return closed;
      },
    };
  } catch (err) {
    await server?.close();
    store.close();
    throw err;
  }
}
