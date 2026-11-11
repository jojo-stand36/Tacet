import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import {
  type EventEnvelope,
  newUlid,
  type RegistryDisconnectReason,
  type RegistryState,
  registryProjection,
} from '@tacet/core';
import {
  CLOSE_CONFLICT,
  conductorRuntimePath,
  conductorStatePaths,
  defaultRunDir,
  type EventStore,
  openEventStore,
  type ProcessLockText,
  type RpcConnection,
  type RpcServer,
  randomToken,
  releaseProcessLock,
  removeRuntimeFile,
  repoStatePaths,
  startRpcServer,
  takeProcessLock,
  writeRuntimeFile,
} from '@tacet/core/node';

export interface StartConductorOptions {
  /** The user layer's resolved `events.state_dir`: the Conductor's log goes under it. */
  stateDir: string;
  /** Where `conductor.json` goes. Default `~/.tacet/run`. */
  runDir?: string;
  /** The version said in hellos. */
  version?: string;
  /** How often each Mini-conductor is pinged, in ms. Default 10000. */
  pingIntervalMs?: number;
  /** Pings in a row a Mini-conductor may miss before it is dropped. Default 2. */
  missedPongs?: number;
  /** How long a connected Mini-conductor has to answer when another hello claims its repo. */
  probeTimeoutMs?: number;
  now?: () => Date;
  /** Told about failures, by message only. */
  onError?: (message: string) => void;
  /** Start Mini-conductors for registered repos (`conductor.autostart`, off by default). */
  autostart?: AutostartOptions;
}

export { MINI_EXIT_UNFINISHED } from '@tacet/core/node';

import { MINI_EXIT_UNFINISHED } from '@tacet/core/node';

/** A Mini-conductor process the Conductor started. */
export interface SpawnedMini {
  pid: number;
  /** Its exit code, or why it ended without one (a signal, no start). */
  exited: Promise<number | string>;
}

export interface AutostartOptions {
  /** Start `tacet mini` for the repo at `repoPath`, in the background. */
  spawnMini(repoPath: string): SpawnedMini;
  /**
   * Whether a Mini-conductor already runs for the repo (its runtime file names a live pid): a
   * `tacet run` in progress, or one about to dial in. None is started beside it.
   */
  isMiniLive(repoPath: string): boolean;
  /** How often registered repos are checked, in ms. Default 30000; the first check is at start. */
  intervalMs?: number;
  /** First wait before starting a repo's Mini-conductor again after it ended (ms), doubled up to `maxBackoffMs`. Default 30000. */
  backoffMs?: number;
  /** Default 600000. */
  maxBackoffMs?: number;
  /** Told what auto-start did, by message. */
  onNotice?: (message: string) => void;
}

/** A running Conductor (#23). */
export interface Conductor {
  port: number;
  /** The registry as its log has it: registered repos and connected Mini-conductors. */
  registry(): RegistryState;
  /** Stop: drop the connections (recorded as closed), remove the runtime file, free the lock. */
  close(): Promise<void>;
}

const LOCK_TEXT: ProcessLockText = {
  heldHere: 'a Conductor is already running in this process',
  heldBy: (pid) => `a Conductor (pid ${pid}) is already running`,
  failed: 'could not take the Conductor lock',
};

interface Live {
  repoId: string;
  conn: RpcConnection;
  missed: number;
  /** Why it is being dropped, when the Conductor drops it. */
  ending?: RegistryDisconnectReason;
}

/**
 * The Conductor daemon (#23, ADR-003 §3 and §4): one per user, holding its lock, on 127.0.0.1 and
 * ::1 with a token new for every start in `~/.tacet/run/conductor.json`. Mini-conductors dial in
 * and say a `mini` hello; the Conductor records each connection in its log (`registry.*`) and
 * pings them, dropping one that stops answering. Registering a repo is the user's own act
 * (`registry.repo_added`, written by `tacet up --add`), never a hello.
 */
export async function startConductor(o: StartConductorOptions): Promise<Conductor> {
  const paths = conductorStatePaths(o.stateDir);
  // One per user: a lock beside the runtime file every Mini-conductor reads, whatever state dir a
  // Conductor uses, and one beside its log.
  const runLock = join(o.runDir ?? defaultRunDir(), 'conductor.lock');
  mkdirSync(dirname(runLock), { recursive: true, mode: 0o700 });
  takeProcessLock(runLock, LOCK_TEXT);
  try {
    takeProcessLock(paths.lock, LOCK_TEXT);
  } catch (err) {
    releaseProcessLock(runLock);
    throw err;
  }
  const releaseLocks = () => {
    try {
      releaseProcessLock(paths.lock);
    } finally {
      releaseProcessLock(runLock);
    }
  };
  let store: EventStore | undefined;
  let server: RpcServer | undefined;
  try {
    store = openEventStore(paths.events);
    const log = store;
    const now = () => o.now?.() ?? new Date();
    const report = (err: unknown) => o.onError?.(err instanceof Error ? err.message : String(err));
    const recordOrThrow = (type: string, repoId: string, data: unknown) => {
      const at = now();
      log.append({
        v: 1,
        id: newUlid(at.getTime()),
        ts: at.toISOString(),
        source: { kind: 'conductor', id: 'conductor' },
        repo: repoId,
        type,
        data,
      } as EventEnvelope);
    };
    /** Recorded, or reported: a failed write (a busy or full disk) never takes the daemon down. */
    const record = (type: string, repoId: string, data: unknown) => {
      try {
        recordOrThrow(type, repoId, data);
      } catch (err) {
        report(err);
      }
    };
    let view = { seq: 0, state: registryProjection.initial() };
    const registry = (): RegistryState => {
      const fresh = log.query({ typePrefix: 'registry', afterSeq: view.seq });
      if (fresh.length > 0) {
        let state = view.state;
        for (const e of fresh) state = registryProjection.apply(state, e.envelope);
        view = { seq: fresh.at(-1)?.seq ?? view.seq, state };
      }
      return view.state;
    };
    // Whatever the log still shows as connected belonged to a Conductor that is gone.
    for (const c of Object.values(registry().connected)) {
      recordOrThrow('registry.disconnected', c.repoId, {
        repoId: c.repoId,
        sessionId: c.sessionId,
        reason: 'conductor_restart',
      });
    }

    const live = new Map<string, Live>();
    let auto: ReturnType<typeof autostarter> | undefined;
    /** One decision at a time per repo, so two hellos at once cannot both be accepted. */
    const deciding = new Map<string, Promise<void>>();

    const accept = (conn: RpcConnection, repoId: string, repoPath: string) => {
      const hello = conn.hello as Extract<typeof conn.hello, { role: 'mini' }>;
      auto?.connected(repoId);
      const entry: Live = { repoId, conn, missed: 0 };
      live.set(repoId, entry);
      record('registry.connected', repoId, {
        repoId,
        repoPath,
        sessionId: conn.sessionId,
        miniVersion: hello.miniVersion,
        adapters: hello.adapters,
      });
      void conn.closed.then(() => {
        if (live.get(repoId) === entry) live.delete(repoId);
        if (closing) return;
        record('registry.disconnected', repoId, {
          repoId,
          sessionId: conn.sessionId,
          reason: entry.ending ?? 'closed',
        });
      });
    };

    const onMini = async (conn: RpcConnection) => {
      const hello = conn.hello;
      if (hello.role !== 'mini') return;
      // Its card is what it says: only a real repo whose id matches its path is taken.
      const repoPath = canonicalRepo(hello.repoPath);
      if (!repoPath || repoStatePaths(repoPath).repoId !== hello.repoId) {
        conn.close(1008, 'repo id and path do not match a repo');
        return;
      }
      const old = live.get(hello.repoId);
      if (old) {
        // Still there: the newcomer is refused. Gone: it takes over (ADR-003 addendum, #23).
        if (await old.conn.ping(o.probeTimeoutMs ?? 2000)) {
          conn.close(CLOSE_CONFLICT, 'repo already connected');
          return;
        }
        old.ending = 'replaced';
        old.conn.terminate();
        // Recorded as ended before the new one starts.
        await old.conn.closed;
      }
      if (closing) {
        conn.close(1001, 'server closing');
        return;
      }
      accept(conn, hello.repoId, repoPath);
    };

    let closing = false;
    // One token for the port and the runtime file, new for every start (ADR-003 §3.2).
    const token = randomToken(32);
    server = await startRpcServer({
      token,
      handlers: {},
      serverInfo: { name: 'tacet-conductor', version: o.version ?? '0.0.0' },
      roles: ['mini', 'cli'],
      ...(o.onError ? { onError: o.onError } : {}),
      onConnection: (conn) => {
        if (conn.hello.role !== 'mini') return;
        const repoId = conn.hello.repoId;
        const turn = (deciding.get(repoId) ?? Promise.resolve())
          .then(() => onMini(conn))
          .catch(report);
        deciding.set(repoId, turn);
        void turn.then(() => {
          if (deciding.get(repoId) === turn) deciding.delete(repoId);
        });
      },
    });
    const rpc = server;
    const runtime = writeRuntimeFile({
      path: conductorRuntimePath(o.runDir),
      port: rpc.port,
      protocolVersions: [1],
      token,
    });

    // Liveness (#23): WebSocket pings, never a JSON-RPC method.
    const interval = o.pingIntervalMs ?? 10_000;
    const beat = setInterval(() => {
      for (const entry of live.values()) {
        // Answered within half the interval, so pings never overlap.
        void entry.conn.ping(Math.max(1, Math.floor(interval / 2))).then((ok) => {
          if (ok) {
            entry.missed = 0;
            return;
          }
          entry.missed += 1;
          if (entry.missed >= (o.missedPongs ?? 2)) {
            entry.ending = 'silent';
            entry.conn.terminate();
          }
        });
      }
    }, interval);
    beat.unref();

    if (o.autostart) auto = autostarter(o.autostart, registry, live, report);

    let closed: Promise<void> | undefined;
    return {
      port: rpc.port,
      registry,
      close: () => {
        closed ??= (async () => {
          clearInterval(beat);
          auto?.stop();
          closing = true;
          try {
            // Recorded as closed here, once, before the store goes.
            for (const entry of live.values()) {
              record('registry.disconnected', entry.repoId, {
                repoId: entry.repoId,
                sessionId: entry.conn.sessionId,
                reason: 'closed',
              });
            }
            live.clear();
            await rpc.close();
          } finally {
            try {
              removeRuntimeFile(conductorRuntimePath(o.runDir), runtime.token);
            } finally {
              try {
                log.close();
              } finally {
                releaseLocks();
              }
            }
          }
        })();
        return closed;
      },
    };
  } catch (err) {
    await server?.close();
    store?.close();
    releaseLocks();
    throw err;
  }
}

/**
 * The canonical path of the checkout a hello names (a main checkout, or a linked worktree, whose
 * `.git` is a file, as `tacet up --add` takes it), or undefined if it is not one.
 */
function canonicalRepo(path: string): string | undefined {
  if (!isAbsolute(path)) return undefined;
  try {
    const real = realpathSync(path);
    // A git repo by its shape only: the Conductor never runs git on a path a hello gave it.
    if (!statSync(real).isDirectory() || !existsSync(`${real}/.git`)) return undefined;
    return real;
  } catch {
    return undefined;
  }
}

interface RepoStart {
  /** The process this Conductor started, while it runs. */
  child?: SpawnedMini | undefined;
  /** Not before this time (ms), after one ended. */
  nextAt: number;
  delay: number;
  /**
   * It refused for unfinished tasks (#23): not started again until a Mini-conductor of the repo
   * connects, which is the user resuming them (`tacet run --resume` dials in too). If tasks are
   * still unfinished then, the next start refuses again.
   */
  gaveUp: boolean;
}

/**
 * Auto-start (#23): every `intervalMs`, and at once, a Mini-conductor is started for each
 * registered repo that has no connection, no live Mini-conductor of its own and no start of
 * this Conductor's running. One that ends is started again after a backoff that doubles per
 * repo; one that refuses for unfinished tasks is not, so an auto-started Mini-conductor never
 * resumes them. Only registered repos, by the path the user registered, still a repo.
 */
function autostarter(
  a: AutostartOptions,
  registry: () => RegistryState,
  live: ReadonlyMap<string, Live>,
  report: (err: unknown) => void,
) {
  const base = a.backoffMs ?? 30_000;
  const starts = new Map<string, RepoStart>();
  let stopped = false;
  const notice = (m: string) => a.onNotice?.(m);

  const tick = () => {
    if (stopped) return;
    const { repos } = registry();
    for (const id of starts.keys()) if (!(id in repos)) starts.delete(id);
    for (const repo of Object.values(repos)) {
      try {
        const s = starts.get(repo.repoId) ?? { nextAt: 0, delay: base, gaveUp: false };
        starts.set(repo.repoId, s);
        if (s.gaveUp || s.child || live.has(repo.repoId) || Date.now() < s.nextAt) continue;
        if (canonicalRepo(repo.repoPath) !== repo.repoPath) continue;
        if (a.isMiniLive(repo.repoPath)) continue;
        const child = a.spawnMini(repo.repoPath);
        s.child = child;
        notice(`started a Mini-conductor for ${repo.repoPath} (pid ${child.pid})`);
        void child.exited.then((code) => {
          s.child = undefined;
          if (stopped) return;
          if (code === MINI_EXIT_UNFINISHED) {
            s.gaveUp = true;
            notice(
              `${repo.repoPath} has unfinished tasks: not started again until they are resumed with tacet run --resume`,
            );
            return;
          }
          s.nextAt = Date.now() + s.delay;
          notice(
            `the Mini-conductor for ${repo.repoPath} ended (${typeof code === 'number' ? `exit ${code}` : code}); starting it again in ${Math.round(s.delay / 1000)}s`,
          );
          s.delay = Math.min(a.maxBackoffMs ?? 600_000, s.delay * 2);
        });
      } catch (err) {
        report(err);
      }
    }
  };
  const timer = setInterval(tick, a.intervalMs ?? 30_000);
  timer.unref();
  queueMicrotask(tick);
  return {
    /**
     * A Mini-conductor of the repo is connected: its next restart starts from the first backoff,
     * and one that refused for unfinished tasks may be tried again once this one is gone.
     */
    connected(repoId: string) {
      const s = starts.get(repoId);
      if (!s) return;
      s.delay = base;
      s.gaveUp = false;
    },
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
