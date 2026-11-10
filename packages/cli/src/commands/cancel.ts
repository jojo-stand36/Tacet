import { existsSync } from 'node:fs';
import { A2ATask, STATUS_EXT_URI, StatusExt } from '@tacet/core';
import { openEventStore, type RpcClient } from '@tacet/core/node';
import { liveControl } from '../control.js';
import type { Io } from '../io.js';
import { safeJson, terminalSafe } from '../render.js';
import { repoRootFrom, statePaths } from '../state.js';

export interface CancelOptions {
  repo?: string;
  'user-dir'?: string;
  json?: boolean;
}

/**
 * `tacet cancel <task>` (#202): cancel a task and its unfinished sub-tasks. During a run, the run
 * does it, asked over its control port (#201), so the log keeps one writer. With no run live, this
 * process takes the Mini-conductor's lock, ends Worker processes a crashed run left behind and
 * records each as canceled. Either way `tacet run --resume` no longer picks the task up.
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
    const client = await liveControl(io, repoRoot, paths, 'cannot cancel through it');
    if (client) return cancelLive(io, client, taskId, o);
    io.err(
      `a run is live for this repo (pid ${pid}) but its control port did not answer: interrupt it (Ctrl-C), then tacet cancel ${terminalSafe(taskId)}`,
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

/** A task and its sub-tasks' states, from an A2A task's status extension. */
function parts(value: unknown): Map<string, string> {
  const task = A2ATask.parse(value);
  const ext = StatusExt.parse(task.metadata?.[STATUS_EXT_URI]);
  return new Map([[task.id, ext.state], ...ext.subtasks.map((x) => [x.id, x.state] as const)]);
}

const ENDED = new Set(['completed', 'failed', 'canceled', 'rejected']);

/** Cancel through the live run (`CancelTask`); prints what it canceled, as the offline path does. */
async function cancelLive(
  io: Io,
  client: RpcClient,
  taskId: string,
  o: CancelOptions,
): Promise<number> {
  try {
    const before = parts(await client.call('GetTask', { id: taskId, historyLength: 0 }));
    // Ending the task's Worker sessions can take a while. The answer is the task as canceled: a
    // run whose last task this was ends and closes its port right after, so nothing more is asked.
    const after = parts(await client.call('CancelTask', { id: taskId }, { timeoutMs: 120_000 }));
    const canceled = [...before]
      .filter(([id, state]) => !ENDED.has(state) && after.get(id) === 'canceled')
      .map(([id]) => id);
    if (o.json) io.out(safeJson({ canceled }));
    else for (const id of canceled) io.out(`${terminalSafe(id)} canceled`);
    return 0;
  } catch (err) {
    io.err(terminalSafe(err instanceof Error ? err.message : String(err)));
    return 1;
  } finally {
    await client.close();
  }
}
