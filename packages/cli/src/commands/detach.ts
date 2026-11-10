import { spawn } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readRuntimeFile } from '@tacet/core/node';
import { liveControl, liveStatus, runtimeFileFor } from '../control.js';
import type { Io } from '../io.js';
import { safeJson, terminalSafe } from '../render.js';
import { openLog, readState, repoRootFrom, rootTasks, sleep, statePaths } from '../state.js';

/** A background `tacet run` the CLI started (#201). */
export interface DetachedChild {
  pid: number;
  /** Settles with its exit code when it exits (null for a signal or a failed start). */
  exited: Promise<number | null>;
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

/** How long a background run may take to open its control port before the start fails. */
const START_TIMEOUT_MS = 60_000;

/**
 * Run `script` (by default this same `tacet`: the script Node is running now) with this Node
 * binary and its flags, in a session of its own.
 */
export function spawnDetachedWith(script = process.argv[1] ?? ''): SpawnDetached {
  return (argv, env, logFd) => {
    const child = spawn(process.execPath, [...process.execArgv, script, ...argv], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env,
    });
    const exited = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => resolve(code));
      child.once('error', () => resolve(null));
    });
    child.unref();
    return { pid: child.pid ?? -1, exited };
  };
}

/** The background run's log beside its runtime file: `~/.tacet/run/minis/<repo-hash>.log`. */
export function detachedLogFor(io: Io, repoRoot: string): string {
  return runtimeFileFor(io, repoRoot).replace(/\.json$/, '.log');
}

/**
 * `tacet run --detach` (#201): the same run in the background. A child `tacet run` with
 * `--detached-child` hosts the Mini-conductor, with no terminal: it waits for answers given with
 * `tacet answer` instead of stopping at an escalation, and ends when its tasks do. Its output goes
 * to a log file (mode 0600, new for each run) beside its runtime file. This process returns once
 * the child's control port is up, with the task, the child's pid and the log's path. The child
 * gets the user's environment unchanged and makes its port's token itself: no secret is passed
 * to it, and none is printed here.
 */
export async function detach(
  io: Io,
  /** The `run` arguments as given, without `--detach`. */
  argv: string[],
  o: { repo?: string; 'user-dir'?: string; json?: boolean },
): Promise<number> {
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
  const before = new Set(store ? rootTasks(readState(store)).map((t) => t.task.id) : []);
  store?.close();

  const runtimeFile = runtimeFileFor(io, repoRoot);
  const log = detachedLogFor(io, repoRoot);
  mkdirSync(dirname(log), { recursive: true, mode: 0o700 });
  const fd = openSync(log, 'w', 0o600);
  let child: DetachedChild;
  try {
    // An older log may have another mode: this run's is the user's only.
    chmodSync(log, 0o600);
    child = (io.spawnDetached ?? spawnDetachedWith())(
      ['run', ...argv, DETACHED_CHILD],
      io.env ?? process.env,
      fd,
    );
  } finally {
    closeSync(fd);
  }
  let exit: number | null | undefined;
  void child.exited.then((code) => {
    exit = code;
  });

  // Up once the runtime file names the child: its port is open and it holds the repo's lock.
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    try {
      if (readRuntimeFile(runtimeFile).pid === child.pid) break;
    } catch {
      // Not written yet.
    }
    if (exit !== undefined) {
      io.err(`the background run ended at once (exit ${exit ?? 'signal'}):`);
      io.err(tail(log));
      return 1;
    }
    if (Date.now() > deadline) {
      io.err(
        `the background run (pid ${child.pid}) did not start within ${START_TIMEOUT_MS / 1000}s; its log: ${terminalSafe(log)}`,
      );
      return 1;
    }
    await sleep(io.pollMs ?? 100, io.signal);
    if (io.signal?.aborted) return 130;
  }

  const client = await liveControl(io, repoRoot, paths, 'cannot read its tasks');
  let tasks: string[] = [];
  try {
    if (client) tasks = (await liveStatus(client)).map((t) => t.id).filter((id) => !before.has(id));
  } finally {
    await client?.close();
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

/** The last lines of the background run's log, safe for a terminal. */
function tail(log: string): string {
  try {
    const text = readFileSync(log, 'utf8').trimEnd();
    return terminalSafe(text.split('\n').slice(-20).join('\n'));
  } catch {
    return '(no log)';
  }
}
