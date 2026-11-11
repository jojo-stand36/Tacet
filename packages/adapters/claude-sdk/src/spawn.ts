import { type ChildProcessByStdio, spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

/**
 * What the Agent SDK passes its `spawnClaudeCodeProcess` option (SDK 0.3.319 `SpawnOptions`):
 * declared here, not imported, so this module has no dependencies and a test can load it in a
 * plain child process.
 */
export interface ClaudeSpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  /** The SDK's forwarded signal: aborts only after its stdin-EOF and ~2 s grace. */
  signal: AbortSignal;
}

/**
 * Starts Claude Code for the Agent SDK in a session of its own (#308), as Tacet's other Workers
 * run: with no controlling terminal, so nothing it or its children run can read or write the
 * terminal of `tacet run`, which shows escalations' one-time answer codes (#269). Otherwise it
 * does what the SDK's own spawn does (SDK 0.3.319 `ProcessTransport.spawnLocalProcess`): the
 * same command, arguments, working directory and environment, piped stdin and stdout, the SDK's
 * abort signal, and no console window on Windows. Stderr is not read: the SDK reads a custom
 * spawner's stdin and stdout only, and without its `stderr` option (which Tacet does not set) it
 * drops Claude Code's stderr as well.
 *
 * On POSIX Claude Code leads its own process group; when it exits, what is left of the group gets
 * SIGTERM, as Tacet's other Workers' groups do. Windows has no sessions: there it is a plain
 * child, as the SDK starts it.
 */
export function spawnInOwnSession(
  o: ClaudeSpawnOptions,
): ChildProcessByStdio<Writable, Readable, null> {
  const posix = process.platform !== 'win32';
  const child = spawn(o.command, o.args, {
    ...(o.cwd !== undefined ? { cwd: o.cwd } : {}),
    env: o.env,
    stdio: ['pipe', 'pipe', 'ignore'] as const,
    signal: o.signal,
    windowsHide: true,
    detached: posix,
  });
  if (posix) {
    child.once('exit', () => {
      if (child.pid !== undefined) signalGroup(child.pid, 'SIGTERM');
    });
  }
  return child;
}

/** Signals process group `pgid`; one already gone is fine. */
export function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // ESRCH: nothing left to signal.
  }
}
