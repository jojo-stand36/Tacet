import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';

/**
 * Finding and ending the processes of Worker sessions a crashed Mini-conductor left running
 * (#127). Each session's vendor process is started with `TACET_WORKER_MARKER=<uuid>` in its
 * environment, and the processes it starts inherit it (Claude Code's Bash tools included, which
 * run in sessions of their own, so no process group reaches them). A process is ended only if its
 * environment has that exact entry: a pid reused by an unrelated process cannot carry a random id
 * it never saw, so pid reuse needs no further guard.
 */
export const WORKER_MARKER_VAR = 'TACET_WORKER_MARKER';

const MARKER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A new marker for one Worker session. */
export function newWorkerMarker(): string {
  return randomUUID();
}

export function isWorkerMarker(value: unknown): value is string {
  return typeof value === 'string' && MARKER.test(value);
}

/**
 * Pids of this user's processes that carry one of `markers`, by marker. Linux reads
 * `/proc/<pid>/environ` (only readable for the user's own processes); macOS asks `/bin/ps -E`.
 * This process is never listed.
 */
export function markedProcesses(markers: readonly string[]): Map<string, number[]> {
  const wanted = new Map<string, string>();
  for (const m of markers) if (isWorkerMarker(m)) wanted.set(`${WORKER_MARKER_VAR}=${m}`, m);
  const found = new Map<string, number[]>();
  if (wanted.size === 0) return found;
  const add = (pid: number, entries: Iterable<string>) => {
    if (pid === process.pid) return;
    for (const e of entries) {
      const m = wanted.get(e);
      if (m !== undefined) {
        found.set(m, [...(found.get(m) ?? []), pid]);
        return;
      }
    }
  };
  if (process.platform === 'linux') {
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      let environ: string;
      try {
        environ = readFileSync(`/proc/${name}/environ`, 'latin1');
      } catch {
        // Gone, or not ours.
        continue;
      }
      add(Number(name), environ.split('\0'));
    }
    return found;
  }
  // macOS: the environment follows the command, as space-separated `NAME=value` words. An exact
  // word match is enough: the marker is a random id.
  const out = execFileSync(
    '/bin/ps',
    ['-E', '-ww', '-x', '-U', String(process.getuid?.() ?? ''), '-o', 'pid=,command='],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (m) add(Number(m[1]), (m[2] ?? '').split(/\s+/));
  }
  return found;
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    // Gone already, or not ours.
  }
}

/**
 * End every process carrying one of `markers`: SIGTERM (Claude Code ends its own tools on
 * SIGTERM), then SIGKILL for whatever is still there after `graceMs`. Each round looks the
 * processes up again, so only processes that carry a marker at that moment are signalled.
 * Returns how many were found.
 */
export async function endMarkedProcesses(
  markers: readonly string[],
  opts: { graceMs?: number } = {},
): Promise<number> {
  const pids = () => [...markedProcesses(markers).values()].flat();
  const first = pids();
  if (first.length === 0) return 0;
  for (const pid of first) signal(pid, 'SIGTERM');
  const deadline = Date.now() + (opts.graceMs ?? 5000);
  let left = pids();
  while (left.length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    left = pids();
  }
  for (const pid of left) signal(pid, 'SIGKILL');
  const killDeadline = Date.now() + 2000;
  while (pids().length > 0 && Date.now() < killDeadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return first.length;
}
