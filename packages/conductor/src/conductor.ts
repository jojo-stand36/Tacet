import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import {
  type A2AListTasksRequest,
  A2AListTasksResponse,
  A2ATask,
  type EventEnvelope,
  EventResumeResult,
  newUlid,
  type RegistryDisconnectReason,
  type RegistryState,
  registryProjection,
  TACET_EVENT,
  TACET_EVENT_RESUME,
  type TasksState,
} from '@tacet/core';
import {
  CLOSE_CONFLICT,
  conductorRuntimePath,
  conductorStatePaths,
  defaultRunDir,
  type EventStore,
  openEventStore,
  type ProcessLockText,
  RpcCallError,
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
import { replicas } from './replicas.js';

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
  /** How often registration changes are acted on (resume, unregister), in ms. Default 2000. */
  syncIntervalMs?: number;
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
  /**
   * The live Mini-conductor of a repo, to call over its link (#24): reading and cancelling its
   * tasks. Undefined when none is connected.
   */
  mini(repoId: string): MiniLink | undefined;
  /** A registered repo's tasks as its forwarded events have them (#24), or undefined. */
  tasks(repoId: string): TasksState | undefined;
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
  /** The Mini-conductor log its events come from, once `tacet/event.resume` has answered (#24). */
  resumed?: { logId: string } | undefined;
  /** A resume is under way. */
  resuming?: boolean;
  /** Resume was asked on this connection (once per connection). */
  asked?: boolean;
  /** The registration (`registry.repo_added` id) it was resumed under. */
  registration?: string | undefined;
  /** Batches that came while the resume's answer was being read: taken right after it, in order. */
  early?: unknown[] | undefined;
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
    // Forwarded events (#24): a replica per registered repo.
    const copies = replicas(o.stateDir);
    const bySession = new Map<string, Live>();
    /** Drop a resumed (or resuming) connection: its Mini-conductor redials and resumes afresh. */
    const drop = (entry: Live, code: number, reason: string) => {
      entry.resumed = undefined;
      entry.early = undefined;
      entry.conn.close(code, reason);
    };
    /**
     * Ask a registered repo's Mini-conductor for its events, from where its replica stands: once
     * per connection (ADR-003 addendum on forwarding events, item 3). Anything that goes wrong, or
     * changes meanwhile, closes the connection instead of retrying on it, so a batch can never be
     * taken out of order: the next connection resumes from the stored cursor.
     */
    const resume = async (entry: Live) => {
      if (entry.resumed || entry.resuming || entry.asked || closing) return;
      const reg = registry().repos[entry.repoId];
      if (!reg) return;
      const caps = (entry.conn.hello as { capabilities?: { events?: unknown } }).capabilities;
      if (!Array.isArray(caps?.events) || !caps.events.includes('resume')) return;
      entry.asked = true;
      entry.resuming = true;
      entry.registration = reg.registration;
      const early: unknown[] = [];
      entry.early = early;
      try {
        copies.adopt(entry.repoId, reg.registration);
        const at = copies.cursor(entry.repoId);
        let raw: unknown;
        try {
          raw = await entry.conn.call(
            TACET_EVENT_RESUME,
            at ? { logId: at.logId, afterSeq: at.seq } : {},
          );
        } catch (err) {
          report(err);
          drop(entry, 1011, 'resume failed');
          return;
        }
        const answer = EventResumeResult.safeParse(raw);
        // Without a cursor, it can only start from the beginning.
        if (!answer.success || (!at && answer.data.afterSeq !== 0)) {
          drop(entry, 1008, 'invalid resume answer');
          return;
        }
        // Unregistered, registered anew, or the replica changed while the answer was on its way.
        const now = registry().repos[entry.repoId];
        const still = copies.cursor(entry.repoId);
        if (
          closing ||
          now?.registration !== reg.registration ||
          still?.logId !== at?.logId ||
          still?.seq !== at?.seq
        ) {
          drop(entry, 1000, 'registration changed');
          return;
        }
        // Another log, or the same one from the start (it was made again, or the cursor was not
        // its own): the replica is begun again, so no task of a log that is gone stays in view.
        if (at && (answer.data.logId !== at.logId || answer.data.afterSeq !== at.seq)) {
          copies.remove(entry.repoId);
          copies.adopt(entry.repoId, reg.registration);
        }
        entry.resumed = { logId: answer.data.logId };
        entry.resuming = false;
        entry.early = undefined;
        for (const p of early) onEvents(p, entry.conn.sessionId);
      } catch (err) {
        report(err);
        drop(entry, 1011, 'resume failed');
      } finally {
        entry.resuming = false;
        entry.early = undefined;
      }
    };
    /**
     * Registration as it is now (#24): a registered repo's connection is resumed; one whose repo
     * is unregistered, or registered anew (removed and added again), is closed (its Mini-conductor
     * redials) and its replica deleted, as is any replica of a repo not registered as it was.
     */
    const sync = () => {
      const { repos } = registry();
      for (const entry of live.values()) {
        const reg = repos[entry.repoId];
        if ((entry.resumed || entry.resuming) && reg?.registration !== entry.registration) {
          drop(entry, 1000, 'repo unregistered');
        } else if (reg) void resume(entry).catch(report);
      }
      for (const repoId of copies.list()) {
        try {
          const reg = repos[repoId];
          if (!reg || copies.registration(repoId) !== reg.registration) copies.remove(repoId);
        } catch (err) {
          report(err);
        }
      }
    };
    const onEvents = (params: unknown, sessionId: string) => {
      const entry = bySession.get(sessionId);
      if (!entry) return;
      // In the same read as the resume's answer: kept until it is handled.
      if (entry.resuming && entry.early) {
        if (entry.early.length >= 256) drop(entry, 1008, 'events before the resume');
        else entry.early.push(params);
        return;
      }
      // Not resumed: not asked for, so not taken (an unregistered repo, or never resumed).
      if (!entry.resumed) return;
      let result: ReturnType<typeof copies.take>;
      try {
        result = copies.take(entry.repoId, entry.resumed.logId, params);
      } catch (err) {
        // Not stored (a busy or full disk): the cursor must not move past it, so the connection
        // goes and the next one resends from the stored cursor.
        report(err);
        drop(entry, 1011, 'events not stored');
        return;
      }
      if (!result.ok) drop(entry, 1008, result.violation);
    };
    let auto: ReturnType<typeof autostarter> | undefined;
    /** One decision at a time per repo, so two hellos at once cannot both be accepted. */
    const deciding = new Map<string, Promise<void>>();

    const accept = (conn: RpcConnection, repoId: string, repoPath: string) => {
      const hello = conn.hello as Extract<typeof conn.hello, { role: 'mini' }>;
      auto?.connected(repoId);
      const entry: Live = { repoId, conn, missed: 0 };
      live.set(repoId, entry);
      bySession.set(conn.sessionId, entry);
      record('registry.connected', repoId, {
        repoId,
        repoPath,
        sessionId: conn.sessionId,
        miniVersion: hello.miniVersion,
        adapters: hello.adapters,
      });
      // Events only once accepted, and only for a registered repo.
      void resume(entry).catch(report);
      void conn.closed.then(() => {
        if (live.get(repoId) === entry) live.delete(repoId);
        bySession.delete(conn.sessionId);
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
      handlers: {
        // A notification: never answered.
        [TACET_EVENT]: (p, ctx) => {
          if (ctx.hello.role === 'mini') onEvents(p, ctx.sessionId);
        },
      },
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
    const syncing = setInterval(() => {
      try {
        sync();
      } catch (err) {
        report(err);
      }
    }, o.syncIntervalMs ?? 2000);
    syncing.unref();
    sync();

    if (o.autostart) auto = autostarter(o.autostart, registry, live, report);

    let closed: Promise<void> | undefined;
    return {
      port: rpc.port,
      registry,
      tasks: (repoId) => copies.tasks(repoId),
      mini: (repoId) => {
        const entry = live.get(repoId);
        return entry ? miniLink(entry.conn) : undefined;
      },
      close: () => {
        closed ??= (async () => {
          clearInterval(beat);
          clearInterval(syncing);
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
                copies.close();
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

/**
 * A connected Mini-conductor, as the Conductor calls it (#24, ADR-003 §4: the Conductor is the A2A
 * client). Answers are checked against the A2A schemas: a Mini-conductor is a peer, not trusted to
 * answer in shape. A JSON-RPC error rejects with an `RpcCallError` carrying its code (A2A's
 * `-32001` for an unknown task, `-32002` for one that cannot be cancelled).
 */
export interface MiniLink {
  readonly sessionId: string;
  /** What the Mini-conductor says it serves (its hello's `capabilities.serves`). */
  readonly serves: readonly string[];
  listTasks(req?: A2AListTasksRequest): Promise<A2AListTasksResponse>;
  getTask(id: string, historyLength?: number): Promise<A2ATask>;
  cancelTask(id: string): Promise<A2ATask>;
}

function miniLink(conn: RpcConnection): MiniLink {
  // Any schema of `@tacet/core` (zod), typed by shape so this package needs no zod of its own.
  type Schema<T> = {
    safeParse(v: unknown): { success: true; data: T } | { success: false };
  };
  const parse = <T>(schema: Schema<T>, value: unknown, method: string): T => {
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      throw new RpcCallError(`${method}: the Mini-conductor answered out of shape`);
    return parsed.data;
  };
  const listed = (conn.hello as { capabilities?: { serves?: unknown } }).capabilities?.serves;
  const serves = Array.isArray(listed)
    ? listed.filter((m): m is string => typeof m === 'string')
    : [];
  // Only what the Mini-conductor says it serves: an older one gets no call it cannot answer.
  const served = (method: string, params: unknown, opts?: { timeoutMs?: number }) =>
    serves.includes(method)
      ? conn.call(method, params, opts)
      : Promise.reject(new RpcCallError(`${method} is not served by this Mini-conductor`, -32601));
  return {
    sessionId: conn.sessionId,
    serves,
    listTasks: async (req = {}) =>
      parse(A2AListTasksResponse, await served('ListTasks', req), 'ListTasks'),
    getTask: async (id, historyLength) =>
      parse(
        A2ATask,
        await served('GetTask', {
          id,
          ...(historyLength !== undefined ? { historyLength } : {}),
        }),
        'GetTask',
      ),
    // A cancel ends the task's Worker sessions first, which can take a while.
    cancelTask: async (id) =>
      parse(A2ATask, await served('CancelTask', { id }, { timeoutMs: 60_000 }), 'CancelTask'),
  };
}
