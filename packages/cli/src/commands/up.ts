import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { type EventEnvelope, newUlid, type RegistryState, registryProjection } from '@tacet/core';
import {
  conductorStatePaths,
  defaultRunDir,
  type EventStore,
  isProcessAlive,
  loadConfig,
  miniRuntimePath,
  openEventStore,
  processLockHolder,
  readRuntimeFile,
  repoStatePaths,
  resolveStateDir,
} from '@tacet/core/node';
import type { Io } from '../io.js';
import { safeJson, terminalSafe } from '../render.js';
import { isGitCheckout, repoRootFrom } from '../state.js';
import { spawnDetachedWith } from './detach.js';

export interface UpOptions {
  'user-dir'?: string;
  json?: boolean;
  add?: string;
  remove?: string;
}

/** The user layer's `events.state_dir`: the Conductor's state lives under it (#23). */
function conductorStateDir(io: Io, userDir?: string): string {
  const { config } = loadConfig(userDir ? { userDir } : {});
  return resolveStateDir(config.events?.state_dir, undefined, io.home);
}

/** An auto-started Mini-conductor's log: `~/.tacet/run/minis/<repo-hash>.mini.log`. */
export function miniLogFor(repoPath: string, run: string): string {
  return miniRuntimePath(repoPath, run).replace(/\.json$/, '.mini.log');
}

function runDir(io: Io): string {
  return io.home ? join(io.home, '.tacet', 'run') : defaultRunDir();
}

/**
 * `tacet up` (#23): run the Conductor in the foreground until interrupted. With `--add PATH` or
 * `--remove PATH`, register or unregister a repo instead: the user's own act, never a hello.
 */
export async function up(io: Io, o: UpOptions): Promise<number> {
  const stateDir = conductorStateDir(io, o['user-dir']);
  if (o.add !== undefined || o.remove !== undefined) {
    if (o.add !== undefined && o.remove !== undefined) {
      io.err('give --add or --remove, not both');
      return 2;
    }
    return register(io, stateDir, (o.add ?? o.remove) as string, o.add !== undefined, o.json);
  }
  const { startConductor } = await import('@tacet/conductor');
  const run = runDir(io);
  const { config } = loadConfig(o['user-dir'] ? { userDir: o['user-dir'] } : {});
  const conductor = await startConductor({
    stateDir,
    runDir: run,
    onError: (m) => io.err(`conductor: ${terminalSafe(m)}`),
    ...(config.conductor?.autostart
      ? {
          autostart: {
            spawnMini: (repoPath: string) => spawnMini(io, repoPath, run, o['user-dir']),
            isMiniLive: (repoPath: string) => {
              try {
                return isProcessAlive(readRuntimeFile(miniRuntimePath(repoPath, run)).pid);
              } catch {
                return false;
              }
            },
            onNotice: (m: string) => io.err(terminalSafe(m)),
          },
        }
      : {}),
  });
  try {
    if (o.json) io.out(safeJson({ port: conductor.port, pid: process.pid }));
    else
      io.out(
        `Conductor running on 127.0.0.1:${conductor.port} (pid ${process.pid}); Ctrl-C stops it`,
      );
    await new Promise<void>((resolve) => {
      if (!io.signal || io.signal.aborted) return resolve();
      io.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    return 0;
  } finally {
    await conductor.close();
  }
}

/**
 * `tacet mini --repo <path>` in the background (#23): a session of its own, output to its log
 * (0600, new for each start), the user's environment unchanged. No secret is passed: it reads its own config
 * and makes its port's token itself.
 */
function spawnMini(io: Io, repoPath: string, run: string, userDir?: string) {
  const log = miniLogFor(repoPath, run);
  mkdirSync(dirname(log), { recursive: true, mode: 0o700 });
  // New for each start; readable, so the Mini-conductor keeps its newest lines under a cap (#273).
  const fd = openSync(
    log,
    constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC | constants.O_APPEND,
    0o600,
  );
  try {
    chmodSync(log, 0o600);
    return (io.spawnDetached ?? spawnDetachedWith())(
      ['mini', '--repo', repoPath, ...(userDir !== undefined ? ['--user-dir', userDir] : [])],
      io.env ?? process.env,
      fd,
    );
  } finally {
    closeSync(fd);
  }
}

/** Register or unregister the repo at `path` in the Conductor's log; a repeat changes nothing. */
async function register(
  io: Io,
  stateDir: string,
  path: string,
  add: boolean,
  json?: boolean,
): Promise<number> {
  const given = isAbsolute(path) ? path : join(io.cwd, path);
  // A mistyped path must not register the repo around it.
  if (!existsSync(given)) {
    io.err(`no such path: ${terminalSafe(path)}`);
    return 1;
  }
  const root = repoRootFrom(given);
  if (!isGitCheckout(root)) {
    io.err(`not a git repository: ${terminalSafe(path)}`);
    return 1;
  }
  const repoPath = realpathSync(root);
  const { repoId } = repoStatePaths(repoPath);
  const paths = conductorStatePaths(stateDir);
  const store = openEventStore(paths.events);
  try {
    const registered = repoId in project(store).repos;
    let changed = false;
    if (add && !registered) {
      append(store, 'registry.repo_added', repoId, { repoId, repoPath });
      changed = true;
    } else if (!add && registered) {
      append(store, 'registry.repo_removed', repoId, { repoId });
      changed = true;
    }
    // Its forwarded events go with it (#24): a running Conductor deletes the replica on its next
    // look at the registry; with none running, it is deleted here.
    if (!add && processLockHolder(paths.lock) === undefined) {
      const { replicaDir } = await import('@tacet/conductor');
      rmSync(replicaDir(stateDir, repoId), { recursive: true, force: true });
    }
    if (json) io.out(safeJson({ repoId, repoPath, registered: add, changed }));
    else {
      const what = add ? 'registered' : 'not registered';
      io.out(`${terminalSafe(repoPath)} ${changed ? `is now ${what}` : `was already ${what}`}`);
      if (realpathSync(given) !== repoPath) {
        io.out(`(the repo containing ${terminalSafe(path)})`);
      }
    }
    return 0;
  } finally {
    store.close();
  }
}

function append(store: EventStore, type: string, repoId: string, data: unknown): void {
  const at = new Date();
  store.append({
    v: 1,
    id: newUlid(at.getTime()),
    ts: at.toISOString(),
    // Written by the user's own command, into the Conductor's log.
    source: { kind: 'conductor', id: 'cli' },
    repo: repoId,
    type,
    data,
  } as EventEnvelope);
}

function project(store: EventStore): RegistryState {
  return store.replay(registryProjection);
}

/**
 * `tacet conductor status` (#23): the registered repos and the connected Mini-conductors, read
 * from the Conductor's log read-only. Connections count only while the Conductor is running: a
 * log left by one that crashed still shows its last ones.
 */
export function conductorStatus(io: Io, o: { 'user-dir'?: string; json?: boolean }): number {
  const paths = conductorStatePaths(conductorStateDir(io, o['user-dir']));
  const pid = processLockHolder(paths.lock);
  let state: RegistryState = registryProjection.initial();
  if (existsSync(paths.events)) {
    const store = openEventStore(paths.events, { readonly: true });
    try {
      state = project(store);
    } finally {
      store.close();
    }
  }
  const connected = pid === undefined ? {} : state.connected;
  const repos = Object.values(state.repos).map((r) => ({
    ...r,
    connected: connected[r.repoId] !== undefined,
    ...(connected[r.repoId] ? { since: connected[r.repoId]?.since } : {}),
  }));
  const unregistered = Object.values(connected).filter((c) => !(c.repoId in state.repos));
  if (o.json) {
    io.out(safeJson({ running: pid ?? null, repos, unregistered }));
    return 0;
  }
  io.out(pid ? `Conductor running (pid ${pid})` : 'Conductor not running');
  if (repos.length === 0) io.out('no registered repos (tacet up --add <path>)');
  for (const r of repos) {
    io.out(
      `  ${terminalSafe(r.repoPath)}: ${r.connected ? `connected since ${r.since}` : 'not connected'}`,
    );
  }
  for (const c of unregistered) {
    io.out(`  ${terminalSafe(c.repoPath)}: connected, not registered`);
  }
  return 0;
}
