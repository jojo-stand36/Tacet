import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { TacetConfig, Task } from '@tacet/core';
import {
  type ConductorLink,
  type ConductorLinkState,
  defaultRunDir,
  dialConductor,
  type EventStore,
  loadConfig,
  miniRuntimePath,
  openEventStore,
  type RepoStatePaths,
  type RpcServer,
  randomToken,
  removeRuntimeFile,
  repoStatePaths,
  resolveStateDir,
  WorkerTokens,
  writeRuntimeFile,
} from '@tacet/core/node';
import { AnswerCodes } from './control/answer-codes.js';
import { LINK_METHODS, startMiniControl, taskMethods } from './control/server.js';
import { MiniConductor } from './daemon/daemon.js';
import { AdapterPlanner, SingleStepPlanner } from './daemon/planner.js';
import type { Planner, PlanResult, Reviewer, WorkerAdapter, Workspaces } from './daemon/ports.js';
import { GitIntegrator } from './git/integrate.js';
import { EventLogBackend } from './mcp/backend.js';
import { MiniMcpServer } from './mcp/server.js';
import { AdapterReviewer } from './review/adapter-reviewer.js';
import { commandVerifierFromConfig } from './verify/command-verifier.js';
import { type BuildWorkerAdaptersOptions, buildWorkerAdapters } from './workers/build.js';
import { WorktreeManager } from './worktree.js';

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
  /** Told when a Worker starts with a risk to know about (#291). */
  onWarning?: (adapterId: string, message: string) => void;
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
  /**
   * Where the control port's runtime file goes (#201): `<runDir>/minis/<repo-hash>.json`. Default
   * `<home>/.tacet/run` when `home` is given, else `~/.tacet/run`.
   */
  runDir?: string;
  /**
   * Dial the Conductor (#23): on by default, so every live Mini-conductor, `tacet run`'s
   * included, shows in `tacet conductor status`. No Conductor running is the normal standalone
   * case and changes nothing. `false` for tests that must not reach a Conductor.
   */
  conductor?:
    | false
    | { onState?: (s: ConductorLinkState) => void; minDelayMs?: number; settleMs?: number };
}

/** A running standalone Mini-conductor and what it owns. */
export interface Standalone {
  mini: MiniConductor;
  store: EventStore;
  config: TacetConfig;
  paths: RepoStatePaths;
  /** The control port (#201) and its runtime file, which holds the port's token (mode 0600). */
  control: { port: number; runtimeFile: string };
  /**
   * The one-time codes the control port wants with an answer (#269). Only the run's own
   * terminal may show one (`issue`): never a log, a file or a Worker's environment.
   */
  answerCodes: AnswerCodes;
  /**
   * Remove the runtime file and close the control port, then stop the Mini-conductor (open
   * sessions recorded as `restart`), then the MCP server and log.
   */
  close(): Promise<void>;
}

/**
 * Standalone mode (#21): one Mini-conductor for one repo, without a Conductor, hosted by the
 * process that calls this (`tacet run`). Wires the existing pieces from the effective config:
 * Worker adapters (`buildWorkerAdapters`), the planner (`AdapterPlanner` on `tiers.mini`, else
 * one sub-task per task), `verify` commands, the reviewer when `review.enabled`, git integration,
 * Worker worktrees (`WorktreeManager`, #16), and the Mini-conductor MCP server on loopback. Everything
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
      ...(o.onWarning ? { onWarning: o.onWarning } : {}),
      codex: { ...o.workers?.codex, stateDir },
      acp: { ...o.workers?.acp, stateDir },
      claude: { ...o.workers?.claude, stateDir },
    });
  const tiers = config.tiers ?? {};
  // First: the worktree registry lives in the log (#126). The manager writes to it only once
  // `mini.start()` holds the lock.
  const store = openEventStore(paths.events);
  let workspaces: WorktreeManager;
  let planner: Planner = new SingleStepPlanner();
  let reviewer: Reviewer | undefined;
  try {
    workspaces = new WorktreeManager(o.repoRoot, paths.worktrees, {
      env: baseEnv,
      log: { store, repo: paths.repoId, miniId: 'standalone' },
    });
    const mini = tiers.mini;
    if (!o.singleStep && mini) {
      const worker = adapters[mini.adapter];
      if (!worker) throw new Error(`tiers.mini.adapter ${mini.adapter} was not built`);
      // Never in the user's checkout: some adapters write without asking (Codex's sandbox).
      planner = new CheckoutPlanner(
        workspaces,
        (cwd) =>
          new AdapterPlanner({
            worker,
            adapterId: mini.adapter,
            ...(mini.model !== undefined ? { model: mini.model } : {}),
            ...(mini.effort !== undefined ? { effort: mini.effort } : {}),
            cwd,
          }),
      );
    }
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
  } catch (err) {
    store.close();
    throw err;
  }

  let server: MiniMcpServer | undefined;
  let control: RpcServer | undefined;
  let runtimeFile: string | undefined;
  let started: MiniConductor | undefined;
  const token = randomToken();
  const answerCodes = new AnswerCodes();
  try {
    server = await MiniMcpServer.start({
      backend: new EventLogBackend({
        store,
        repo: paths.repoId,
        miniId: 'standalone',
        // A Worker's handoff (#129): the Mini-conductor, made below, decides and reseeds.
        canHandoff: (b) =>
          started ? started.handoffRefusal(b.workerSessionId) : 'not running yet',
        onHandoff: (b) => started?.handoff(b.workerSessionId),
      }),
      tokens: new WorkerTokens(),
      ...(o.onError ? { onError: o.onError } : {}),
    });
    const mini = new MiniConductor({
      store,
      config,
      adapters,
      workspaces,
      planner,
      verifier: commandVerifierFromConfig(config, { repoRoot: o.repoRoot, baseEnv }),
      ...(reviewer ? { reviewer } : {}),
      integrator: new GitIntegrator(o.repoRoot, baseEnv),
      mcp: server,
      lockPath: paths.lock,
      repo: paths.repoId,
      miniId: 'standalone',
      redactPaths: redactPathsFor([
        [paths.worktrees, '<worktrees>'],
        [paths.dir, '<state>'],
        [o.repoRoot, '<repo>'],
        [o.home ?? homedir(), '~'],
      ]),
    });
    await mini.start();
    started = mini;
    // The control port (#201), only once the Mini-conductor holds its lock: the runtime file
    // tells a CLI which process to talk to, and its token rotates with every run.
    control = await startMiniControl({
      mini,
      store,
      contextId: paths.repoId,
      token,
      answerCodes,
      ...(o.onError ? { onError: (m) => o.onError?.(`control: ${m}`) } : {}),
    });
    runtimeFile = miniRuntimePath(
      o.repoRoot,
      o.runDir ?? (o.home ? join(o.home, '.tacet', 'run') : defaultRunDir()),
    );
    writeRuntimeFile({ path: runtimeFile, port: control.port, protocolVersions: [1], token });
    // Last: the Conductor sees a Mini-conductor only once it holds its lock and serves its port.
    let link: ConductorLink | undefined;
    if (o.conductor !== false) {
      const repoPath = realpathSync(o.repoRoot);
      link = dialConductor({
        card: {
          repoId: repoStatePaths(repoPath).repoId,
          repoPath,
          adapters: Object.keys(adapters).sort(),
          miniVersion: MINI_VERSION,
        },
        clientInfo: { name: 'tacet-mini', version: MINI_VERSION },
        // Reading and cancelling only (#24): new tasks and answers stay with `tacet run` and its
        // terminal until the Conductor can be authenticated to the Mini-conductor (#53).
        handlers: taskMethods({ mini, store, contextId: paths.repoId }).handlers,
        capabilities: { serves: [...LINK_METHODS] },
        ...(o.onError ? { onError: (m: string) => o.onError?.(`conductor link: ${m}`) } : {}),
        runDir: o.runDir ?? (o.home ? join(o.home, '.tacet', 'run') : defaultRunDir()),
        ...(o.conductor?.minDelayMs !== undefined ? { minDelayMs: o.conductor.minDelayMs } : {}),
        ...(o.conductor?.settleMs !== undefined ? { settleMs: o.conductor.settleMs } : {}),
        ...(o.conductor?.onState ? { onState: o.conductor.onState } : {}),
      });
    }
    const mcp = server;
    const port = control;
    const file = runtimeFile;
    let closed: Promise<void> | undefined;
    return {
      mini,
      store,
      config,
      paths,
      control: { port: port.port, runtimeFile: file },
      answerCodes,
      close: () => {
        closed ??= (async () => {
          try {
            await link?.close();
            try {
              removeRuntimeFile(file, token);
            } catch (err) {
              // Changed under us (mode, owner): left in place, and the run still stops cleanly.
              o.onError?.(`control: ${(err as Error).message}`);
            }
            await port.close();
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
    if (runtimeFile) {
      try {
        removeRuntimeFile(runtimeFile, token);
      } catch {}
    }
    await control?.close();
    // Started but not handed back: nobody else would stop it or release its lock.
    await started?.stop().catch(() => {});
    await server?.close();
    store.close();
    throw err;
  }
}

/** The version a Mini-conductor gives in its hello and Agent Card. */
export const MINI_VERSION = '0.0.0';

/**
 * Plans each task in a throwaway detached checkout of the repo's HEAD, removed afterwards. The
 * planner is read-only by instruction and its approval requests are refused, but an adapter may
 * write without asking (Codex's `workspace-write` sandbox), and the user's own checkout must never
 * be changed by Tacet.
 */
export class CheckoutPlanner implements Planner {
  constructor(
    private readonly workspaces: Workspaces,
    private readonly make: (cwd: string) => Planner,
  ) {}

  async plan(task: Task, opts: { signal?: AbortSignal; base?: string } = {}): Promise<PlanResult> {
    // At the task's pinned target, where its Workers start (#219), not where the user is now.
    const ws = await this.workspaces.create(
      `plan-${task.id.replace(/\//g, '_')}-${randomUUID().slice(0, 8)}`,
      opts.base,
      // A crash mid-plan leaves it registered: the next start removes it (#238).
      { scratch: true },
    );
    try {
      return await this.make(ws.path).plan(task, opts);
    } finally {
      // A planner may have written to it; nothing in it is kept.
      await this.workspaces.remove(ws.id, { force: true }).catch(() => {});
    }
  }
}

/**
 * Directories to replace in maintenance problems (#254), as given and as resolved (git reports the
 * resolved path: on macOS /var is /private/var), longest first so the most specific wins.
 */
export function redactPathsFor(
  dirs: ReadonlyArray<readonly [string, string]>,
): Array<readonly [string, string]> {
  const all = new Map<string, string>();
  for (const [dir, label] of dirs) {
    if (dir.length <= 1) continue;
    if (!all.has(dir)) all.set(dir, label);
    try {
      const real = realpathSync(dir);
      if (!all.has(real)) all.set(real, label);
    } catch {
      // Not there yet: only as given.
    }
  }
  return [...all].sort(([a], [b]) => b.length - a.length);
}
