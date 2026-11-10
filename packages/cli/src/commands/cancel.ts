import { existsSync } from 'node:fs';
import { openEventStore } from '@tacet/core/node';
import type { Io } from '../io.js';
import { safeJson, terminalSafe } from '../render.js';
import { repoRootFrom, statePaths } from '../state.js';

export interface CancelOptions {
  repo?: string;
  'user-dir'?: string;
  json?: boolean;
}

/**
 * `tacet cancel <task>` (#202): cancel a task and its unfinished sub-tasks while no `tacet run` is
 * live for the repo (the log has one writer). It ends Worker processes a crashed run left behind,
 * records each as canceled, and `tacet run --resume` no longer picks the task up. During a run,
 * interrupt it first (Ctrl-C); the run's own control port (#201) will make that step unneeded.
 */
export async function cancel(io: Io, taskId: string, o: CancelOptions): Promise<number> {
  const repoRoot = repoRootFrom(o.repo ?? io.cwd);
  const paths = statePaths(repoRoot, o['user-dir'], io.home);
  if (!existsSync(paths.events)) {
    io.err(`no Tacet state for ${terminalSafe(repoRoot)}: nothing to cancel`);
    return 1;
  }
  const { cancelStopped, miniLockHolder } = await import('@tacet/mini');
  const pid = miniLockHolder(paths.lock);
  if (pid !== undefined) {
    io.err(
      `a run is live for this repo (pid ${pid}): interrupt it (Ctrl-C), then tacet cancel ${terminalSafe(taskId)}`,
    );
    return 1;
  }
  const store = openEventStore(paths.events);
  try {
    const { canceled, errors } = await cancelStopped(taskId, {
      store,
      lockPath: paths.lock,
      repo: paths.repoId,
      miniId: 'standalone',
    });
    for (const e of errors) {
      io.err(`note: ${terminalSafe(e instanceof Error ? e.message : String(e))}`);
    }
    if (o.json) io.out(safeJson({ canceled }));
    else for (const id of canceled) io.out(`${terminalSafe(id)} canceled`);
    return 0;
  } catch (err) {
    io.err(terminalSafe(err instanceof Error ? err.message : String(err)));
    return 1;
  } finally {
    store.close();
  }
}
