import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { MINI_EXIT_UNFINISHED } from '@tacet/core/node';
import type { Io } from '../io.js';
import { terminalSafe } from '../render.js';
import { DONE_STATES, openLog, readState, repoRootFrom, rootTasks, statePaths } from '../state.js';

export interface MiniOptions {
  repo?: string;
  'user-dir'?: string;
}

/**
 * Exit codes of `tacet mini`. `unfinished` tells the Conductor's auto-start not to try again:
 * the repo has tasks only the user may resume (`tacet run --resume`), never an auto-started
 * Mini-conductor (owner decision on #23, until #24 and #26).
 */
export const MINI_EXIT = {
  stopped: 0,
  failed: 1,
  usage: 2,
  unfinished: MINI_EXIT_UNFINISHED,
} as const;

/**
 * `tacet mini` (#23): a Mini-conductor for one repo that takes no task of its own. It holds the
 * repo's lock, serves its control port and dials the Conductor, until interrupted. It is what
 * `tacet up` starts for a registered repo when `conductor.autostart` is on. It never resumes
 * unfinished tasks: with any in the repo's log it refuses to start (exit 4).
 */
export async function mini(io: Io, o: MiniOptions): Promise<number> {
  const repoRoot = repoRootFrom(o.repo ?? io.cwd);
  if (!existsSync(join(repoRoot, '.git'))) {
    io.err(`${terminalSafe(repoRoot)} is not in a git repository: Tacet works on a git repo`);
    return MINI_EXIT.failed;
  }
  let paths: ReturnType<typeof statePaths>;
  try {
    paths = statePaths(repoRoot, o['user-dir'], io.home);
  } catch (err) {
    io.err(terminalSafe((err as Error).message));
    return MINI_EXIT.failed;
  }
  // Checked before the start, which would resume them.
  const store = openLog(paths);
  const unfinished = store
    ? rootTasks(readState(store))
        .filter((t) => !DONE_STATES.has(t.state))
        .map((t) => t.task.id)
    : [];
  store?.close();
  if (unfinished.length > 0) {
    io.err(
      `unfinished tasks ${unfinished.join(', ')}: resume them with tacet run --resume, or drop them with tacet cancel <task>`,
    );
    return MINI_EXIT.unfinished;
  }

  const { startStandalone } = await import('@tacet/mini/standalone');
  let sa: Awaited<ReturnType<typeof startStandalone>>;
  try {
    sa = await startStandalone({
      repoRoot,
      ...(o['user-dir'] ? { userDir: o['user-dir'] } : {}),
      ...(io.env ? { baseEnv: io.env } : {}),
      ...(io.home ? { home: io.home } : {}),
      onError: (m) => io.err(`mini: ${terminalSafe(m)}`),
      ...io.standalone,
      // Tests may tune the link; its states are reported here either way.
      conductor:
        io.standalone?.conductor === false
          ? false
          : {
              ...io.standalone?.conductor,
              onState: (s) => {
                if (s.state === 'connected') io.err('connected to the Conductor');
                else if (s.state === 'refused')
                  io.err('the Conductor has another Mini-conductor for this repo');
                else if (s.state === 'disconnected') io.err('lost the Conductor; dialing again');
              },
            },
    });
  } catch (err) {
    io.err(terminalSafe(err instanceof Error ? err.message : String(err)));
    return MINI_EXIT.failed;
  }
  try {
    io.err(`Mini-conductor running for ${terminalSafe(repoRoot)} (pid ${process.pid})`);
    await new Promise<void>((resolve) => {
      if (!io.signal || io.signal.aborted) return resolve();
      io.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    return MINI_EXIT.stopped;
  } finally {
    await sa.close();
  }
}
