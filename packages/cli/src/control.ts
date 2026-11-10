import { join } from 'node:path';
import { A2AListTasksResponse, STATUS_EXT_URI, StatusExt, type TaskStatusEntry } from '@tacet/core';
import {
  connectRpc,
  defaultRunDir,
  miniRuntimePath,
  type RepoStatePaths,
  type RpcClient,
  readRuntimeFile,
} from '@tacet/core/node';
import type { Io } from './io.js';
import { terminalSafe } from './render.js';

/** The runtime file of the repo's standalone Mini-conductor (#201), as `tacet run` writes it. */
export function runtimeFileFor(io: Io, repoRoot: string): string {
  return miniRuntimePath(repoRoot, io.home ? join(io.home, '.tacet', 'run') : defaultRunDir());
}

/**
 * The live run's control port (#201), if a run is live and answering: its runtime file names the
 * process holding the repo's Mini-conductor lock, and hello succeeds. Otherwise undefined, with a
 * note on stderr when a file is there but cannot be used, so callers fall back to the log. The
 * token is read from the file and sent in the upgrade header only: never an argument or a log line.
 */
export async function liveControl(
  io: Io,
  repoRoot: string,
  paths: RepoStatePaths,
  /** What the caller does without the port, for the note. */
  fallback = 'reading the log instead',
): Promise<RpcClient | undefined> {
  const file = runtimeFileFor(io, repoRoot);
  let info: ReturnType<typeof readRuntimeFile>;
  try {
    info = readRuntimeFile(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      io.err(`note: ${terminalSafe((err as Error).message)}; ${fallback}`);
    }
    return undefined;
  }
  const { miniLockHolder } = await import('@tacet/mini');
  // A file a crashed run left: its process no longer holds the lock.
  if (miniLockHolder(paths.lock) !== info.pid) return undefined;
  try {
    return await connectRpc({
      port: info.port,
      token: info.token,
      clientInfo: { name: 'tacet-cli', version: '0.0.0' },
      timeoutMs: 5000,
    });
  } catch (err) {
    io.err(
      `note: the live run's control port did not answer (${terminalSafe((err as Error).message)}); ${fallback}`,
    );
    return undefined;
  }
}

/** Every task as the live run shows it: `ListTasks`, page by page, with the status extension. */
export async function liveStatus(client: RpcClient): Promise<TaskStatusEntry[]> {
  const out: TaskStatusEntry[] = [];
  let pageToken: string | undefined;
  do {
    const page = A2AListTasksResponse.parse(
      await client.call('ListTasks', {
        historyLength: 0,
        pageSize: 100,
        ...(pageToken ? { pageToken } : {}),
      }),
    );
    for (const t of page.tasks) {
      out.push({ id: t.id, ...StatusExt.parse(t.metadata?.[STATUS_EXT_URI]) });
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}
