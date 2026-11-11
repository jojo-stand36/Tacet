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
 * abort signal, and no console window on Windows. The SDK reads a custom spawner's stdin and
 * stdout only, so the tail of Claude Code's stderr, which its own spawn adds to exit errors, is
 * kept in `stderr` for the adapter to add instead. (With a custom spawner the SDK also no longer
 * adds `--debug-file` when its debug log is on.)
 *
 * On POSIX Claude Code leads its own process group; when it exits, what is left of the group gets
 * SIGTERM, as Tacet's other Workers' groups do. Windows has no sessions: there it is a plain
 * child, as the SDK starts it.
 */
export function spawnInOwnSession(
  o: ClaudeSpawnOptions,
  stderr?: StderrTail,
): ChildProcessByStdio<Writable, Readable, Readable> {
  const posix = process.platform !== 'win32';
  const child = spawn(o.command, o.args, {
    ...(o.cwd !== undefined ? { cwd: o.cwd } : {}),
    env: o.env,
    stdio: ['pipe', 'pipe', 'pipe'] as const,
    signal: o.signal,
    windowsHide: true,
    detached: posix,
  });
  // Always read, so a full pipe never stalls Claude Code.
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d: string) => stderr?.add(d));
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

/** The last `max` characters of a process's stderr (the SDK keeps about 2 KB for its errors). */
export class StderrTail {
  #text = '';
  readonly #max: number;
  // A plain field, not a parameter property: tests load this file through Node's type stripping.
  constructor(max = 2048) {
    this.#max = max;
  }
  add(chunk: string): void {
    this.#text = (this.#text + chunk).slice(-this.#max);
  }
  get text(): string {
    return this.#text.trim();
  }
}
