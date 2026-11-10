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
  // word match is enough: the marker is a random id (a process whose arguments hold the very same
  // word, such as a `grep` for it, would match too).
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

interface ProcessIdentity {
  /** When it started: tells it apart from a later process with the same pid. */
  start: string;
  zombie: boolean;
}

/**
 * A process's start time and whether it is a zombie, or undefined when there is no such process.
 * Linux: `/proc/<pid>/stat` (state, and start time in clock ticks since boot). macOS: `ps -o
 * stat=,lstart=` in a fixed locale and time zone.
 */
function identity(pid: number): ProcessIdentity | undefined {
  if (!Number.isInteger(pid) || pid <= 1) return undefined;
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const start = fields[19];
      return start ? { start, zombie: fields[0] === 'Z' } : undefined;
    }
    const out = execFileSync('/bin/ps', ['-o', 'stat=,lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC0' },
    }).trim();
    const m = out.match(/^(\S+)\s+(.+)$/);
    return m ? { start: m[2] ?? '', zombie: (m[1] ?? '').startsWith('Z') } : undefined;
  } catch {
    // No such process (ps exits 1), or gone between the lookup and the read.
    return undefined;
  }
}

/** Whether `pid` is running: it exists and is not a zombie waiting to be reaped. */
export function isProcessRunning(pid: number): boolean {
  const id = identity(pid);
  return id !== undefined && !id.zombie;
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
 * SIGTERM), then SIGKILL for whatever is still running after `graceMs`.
 *
 * A process found by its marker is then followed by pid until it is gone, not looked up by its
 * marker again, so it is never taken for gone only because its environment can no longer be read
 * (macOS reads it from the process's memory). Its start time is
 * checked before every signal, so a pid reused meanwhile is never signalled. Each round also
 * looks for marked processes forked meanwhile. Returns the pids found, and those still running
 * after SIGKILL (normally none).
 */
export async function endMarkedProcesses(
  markers: readonly string[],
  opts: { graceMs?: number } = {},
): Promise<{ found: number[]; left: number[] }> {
  const tracked = new Map<number, string>();
  const found: number[] = [];
  /** Newly marked processes, which are now tracked. */
  const scan = (): number[] => {
    const fresh: number[] = [];
    for (const pid of [...markedProcesses(markers).values()].flat()) {
      if (tracked.has(pid)) continue;
      const id = identity(pid);
      if (!id || id.zombie) continue;
      tracked.set(pid, id.start);
      found.push(pid);
      fresh.push(pid);
    }
    return fresh;
  };
  /** Tracked processes still running as the same process; the others stop being tracked. */
  const running = (): number[] =>
    [...tracked].flatMap(([pid, start]) => {
      const id = identity(pid);
      if (id && !id.zombie && id.start === start) return [pid];
      tracked.delete(pid);
      return [];
    });
  scan();
  if (tracked.size === 0) return { found: [], left: [] };
  for (const pid of running()) signal(pid, 'SIGTERM');
  const deadline = Date.now() + (opts.graceMs ?? 5000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    for (const pid of scan()) signal(pid, 'SIGTERM');
    if (running().length === 0) return { found, left: [] };
  }
  const killDeadline = Date.now() + 2000;
  for (;;) {
    scan();
    const left = running();
    if (left.length === 0 || Date.now() >= killDeadline) return { found, left };
    for (const pid of left) signal(pid, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 100));
  }
}
