import { spawn } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { readRuntimeFile } from '@tacet/core/node';
import { liveControl, liveStatus, runtimeFileFor } from '../control.js';
import type { Io } from '../io.js';
import { safeJson, terminalSafe } from '../render.js';
import {
  DONE_STATES,
  openLog,
  readState,
  repoRootFrom,
  rootTasks,
  sleep,
  statePaths,
} from '../state.js';
import type { RunOptions } from './run.js';

/** A background `tacet run` the CLI started (#201). */
export interface DetachedChild {
  pid: number;
  /** Settles when it exits: its exit code, or why it ended without one (a signal, no start). */
  exited: Promise<number | string>;
  /** Stop it as an interrupted run stops (SIGTERM): its open sessions resume with `--resume`. */
  stop(): void;
}

/**
 * Start `tacet <argv>` in the background: its own session, no terminal, standard output and error
 * to `logFd`, with exactly `env`. Replaced in tests.
 */
export type SpawnDetached = (
  argv: string[],
  env: Record<string, string | undefined>,
  logFd: number,
) => DetachedChild;

/** The internal flag the background run gets: it waits for answers instead of exiting. */
export const DETACHED_CHILD = '--detached-child';

/**
 * Whether `argv` (the command line after the script) is the background run `--detach` started:
 * exactly as `childArgs` makes it, the flag right after `run`, never a task or answer text.
 */
export function isDetachedChild(argv: readonly string[]): boolean {
  return argv[0] === 'run' && argv[1] === DETACHED_CHILD;
}

/** How long a background run may take to open its control port before the start fails. */
export const START_TIMEOUT_MS = 60_000;

/**
 * The background run's arguments, rebuilt from the parsed ones rather than copied, so nothing
 * the user typed (a `--`, a task text that looks like a flag) can move the internal flag.
 */
export function childArgs(goal: string | undefined, o: RunOptions): string[] {
  return [
    'run',
    DETACHED_CHILD,
    ...(o.repo !== undefined ? ['--repo', o.repo] : []),
    ...(o['user-dir'] !== undefined ? ['--user-dir', o['user-dir']] : []),
    ...(o.accept ?? []).flatMap((a) => ['--accept', a]),
    ...(o.single ? ['--single'] : []),
    ...(o.resume ? ['--resume'] : []),
    ...(o.answer ?? []).flatMap((a) => ['--answer', a]),
    ...(goal !== undefined ? ['--', goal] : []),
  ];
}

/**
 * Run `script` (by default this same `tacet`: the script Node is running now) with this Node
 * binary and its flags, in a session of its own.
 */
export function spawnDetachedWith(script = process.argv[1] ?? ''): SpawnDetached {
  return (argv, env, logFd) => {
    // Not the inspector flags: the child would fight this process for its port.
    const flags = process.execArgv.filter((a) => !/^--(inspect|debug)/.test(a));
    const child = spawn(process.execPath, [...flags, script, ...argv], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env,
    });
    const exited = new Promise<number | string>((resolve) => {
      child.once('exit', (code, signal) => resolve(code ?? `signal ${signal}`));
      child.once('error', (err) => resolve(`not started: ${err.message}`));
    });
    child.unref();
    return { pid: child.pid ?? -1, exited, stop: () => child.kill('SIGTERM') };
  };
}

/** The background run's log beside its runtime file: `~/.tacet/run/minis/<repo-hash>.log`. */
export function detachedLogFor(io: Io, repoRoot: string): string {
  return runtimeFileFor(io, repoRoot).replace(/\.json$/, '.log');
}

/**
 * `tacet run --detach` (#201): the same run in the background. A child `tacet run` with
 * `--detached-child` hosts the Mini-conductor, with no terminal: it ends when its tasks do, or,
 * as a run without a terminal, when only an answer can move them on (exit 3; no terminal shows
 * it the code an answer over its port needs, #269). Its output goes
 * to a log file (mode 0600, new for each run) beside its runtime file. This process returns once
 * the child's control port is up, with the task, the child's pid and the log's path. The child
 * gets the user's environment unchanged and makes its port's token itself: no secret is passed
 * to it, and none is printed here.
 */
export async function detach(io: Io, goal: string | undefined, o: RunOptions): Promise<number> {
  const repoRoot = repoRootFrom(o.repo ?? io.cwd);
  if (!existsSync(join(repoRoot, '.git'))) {
    io.err(`${terminalSafe(repoRoot)} is not in a git repository: Tacet works on a git repo`);
    return 1;
  }
  const paths = statePaths(repoRoot, o['user-dir'], io.home);
  const { miniLockHolder } = await import('@tacet/mini');
  const holder = miniLockHolder(paths.lock);
  if (holder !== undefined) {
    io.err(
      `a run is already live for this repo (pid ${holder}): see tacet status, or tacet cancel <task>`,
    );
    return 1;
  }
  // The tasks there were before, so the new one can be told apart.
  const store = openLog(paths);
  const roots = store ? rootTasks(readState(store)) : [];
  store?.close();
  const before = new Set(roots.map((t) => t.task.id));
  if (goal === undefined && roots.every((t) => DONE_STATES.has(t.state))) {
    io.err('nothing to resume');
    return 0;
  }

  const runtimeFile = runtimeFileFor(io, repoRoot);
  const log = detachedLogFor(io, repoRoot);
  mkdirSync(dirname(log), { recursive: true, mode: 0o700 });
  // Appending: should two starts race past the lock check, neither writes over the other. Readable
  // too: the background run keeps its log's newest lines under a cap (#273).
  const fd = openSync(
    log,
    constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC | constants.O_APPEND,
    0o600,
  );
  let child: DetachedChild;
  try {
    // An older log may have another mode: this run's is the user's only.
    chmodSync(log, 0o600);
    child = (io.spawnDetached ?? spawnDetachedWith())(
      childArgs(goal, o),
      io.env ?? process.env,
      fd,
    );
  } finally {
    closeSync(fd);
  }
  let exit: number | string | undefined;
  void child.exited.then((code) => {
    exit = code;
  });
  /** Stop a background run that will not be followed, and say so. */
  const abandon = (why: string): number => {
    child.stop();
    io.err(
      `${why}: the background run (pid ${child.pid}) is stopped; its log: ${terminalSafe(log)}`,
    );
    io.err('its open Worker sessions resume with tacet run --resume');
    return 1;
  };

  // Up once the runtime file names the child: its port is open and it holds the repo's lock.
  const timeoutMs = io.detachStartTimeoutMs ?? START_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let up = false;
  while (!up) {
    try {
      up = readRuntimeFile(runtimeFile).pid === child.pid;
    } catch {
      // Not written yet.
    }
    if (up) break;
    if (exit !== undefined) return ended(io, exit, log, o.json);
    if (io.signal?.aborted) {
      abandon('interrupted while it started');
      return 130;
    }
    if (Date.now() > deadline) return abandon(`it did not start within ${timeoutMs / 1000}s`);
    await sleep(io.pollMs ?? 100, io.signal);
  }

  // The new task, read from the run itself: submitted just after its port opened.
  let tasks: string[] = [];
  const client = await liveControl(io, repoRoot, paths, 'cannot read its tasks');
  try {
    for (let i = 0; client && i < 50; i++) {
      tasks = (await liveStatus(client)).map((t) => t.id).filter((id) => !before.has(id));
      if (goal === undefined || tasks.length > 0) break;
      await sleep(io.pollMs ?? 100, io.signal);
    }
  } catch {
    // Gone meanwhile: what its exit says is reported below.
  } finally {
    await client?.close();
  }
  if (!client || (goal !== undefined && tasks.length === 0)) {
    if (exit !== undefined) return ended(io, exit, log, o.json);
    io.err(`the background run (pid ${child.pid}) started, but its task could not be read`);
  }
  if (o.json) {
    io.out(safeJson({ tasks, pid: child.pid, log }));
  } else {
    io.err(
      tasks.length > 0
        ? `task ${tasks.join(', ')} running in the background (pid ${child.pid})`
        : `resuming in the background (pid ${child.pid})`,
    );
    io.err(`its log: ${terminalSafe(log)}`);
    io.err('follow it with tacet status, tacet attach <task>/<n> or tacet logs --follow <task>');
  }
  return 0;
}

/** The background run ended before it was followed: done (exit 0) or not, with its log's end. */
function ended(io: Io, exit: number | string, log: string, json?: boolean): number {
  if (exit === 0) {
    io.err('the background run is already done:');
    io.err(tail(log));
    if (json) io.out(safeJson({ tasks: [], exit: 0, log }));
    return 0;
  }
  io.err(`the background run ended at once (${typeof exit === 'number' ? `exit ${exit}` : exit}):`);
  io.err(tail(log));
  return 1;
}

/** The last lines of the background run's log, safe for a terminal. */
function tail(log: string): string {
  try {
    const text = readFileSync(log, 'utf8').trimEnd();
    return terminalSafe(text.split('\n').slice(-20).join('\n'));
  } catch {
    return '(no log)';
  }
}
