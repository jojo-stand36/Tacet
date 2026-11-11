import { join } from 'node:path';
import { A2AListTasksResponse, STATUS_EXT_URI, StatusExt, type TaskStatusEntry } from '@tacet/core';
import {
  connectPty,
  connectRpc,
  defaultRunDir,
  miniRuntimePath,
  type PtyConnection,
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
  const info = await liveRuntime(io, repoRoot, paths, fallback);
  if (!info) return undefined;
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

/** The live run's runtime file, if the process it names holds the repo's lock. */
async function liveRuntime(
  io: Io,
  repoRoot: string,
  paths: RepoStatePaths,
  fallback: string,
): Promise<ReturnType<typeof readRuntimeFile> | undefined> {
  let info: ReturnType<typeof readRuntimeFile>;
  try {
    info = readRuntimeFile(runtimeFileFor(io, repoRoot));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      io.err(`note: ${terminalSafe((err as Error).message)}; ${fallback}`);
    }
    return undefined;
  }
  const { miniLockHolder } = await import('@tacet/mini');
  // A file a crashed run left: its process no longer holds the lock.
  return miniLockHolder(paths.lock) === info.pid ? info : undefined;
}

/**
 * The live terminal of Worker session `sessionId` in the live run (#201, ADR-003 §5): its bytes
 * go to `onData` as they come. Undefined when no run is live, or the session has no terminal
 * there (not a PTY Worker, or no longer running), so the caller follows the log instead.
 */
export async function livePty(
  io: Io,
  repoRoot: string,
  paths: RepoStatePaths,
  sessionId: string,
  onData: (chunk: Uint8Array) => void,
): Promise<PtyConnection | undefined> {
  const info = await liveRuntime(io, repoRoot, paths, 'following the log instead');
  if (!info) return undefined;
  try {
    return await connectPty({
      port: info.port,
      token: info.token,
      sessionId,
      onData,
      timeoutMs: 5000,
    });
  } catch (err) {
    if ((err as { httpStatus?: number }).httpStatus !== 404) {
      io.err(
        `note: the live run's terminal did not answer (${terminalSafe((err as Error).message)}); following the log instead`,
      );
    }
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
