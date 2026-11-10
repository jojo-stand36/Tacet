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
 * Start time and zombie state of each of `pids` that exists. Linux: `/proc/<pid>/stat` (state,
 * and start time in clock ticks since boot). macOS: one `ps -o pid=,stat=,lstart=` for all of
 * them, in a fixed locale and time zone, so a round costs one process spawn however many pids.
 */
function identities(pids: readonly number[]): Map<number, ProcessIdentity> {
  const out = new Map<number, ProcessIdentity>();
  const valid = pids.filter((pid) => Number.isInteger(pid) && pid > 1);
  if (valid.length === 0) return out;
  if (process.platform === 'linux') {
    for (const pid of valid) {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const start = fields[19];
        if (start) out.set(pid, { start, zombie: fields[0] === 'Z' });
      } catch {
        // Gone.
      }
    }
    return out;
  }
  let text = '';
  try {
    text = execFileSync('/bin/ps', ['-o', 'pid=,stat=,lstart=', '-p', valid.join(',')], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC0' },
    });
  } catch (err) {
    // ps exits 1 when none of them exists, and still prints the ones that do.
    text = String((err as { stdout?: unknown }).stdout ?? '');
  }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/);
    if (m) out.set(Number(m[1]), { start: m[3] ?? '', zombie: (m[2] ?? '').startsWith('Z') });
  }
  return out;
}

/** Whether `pid` is running: it exists and is not a zombie waiting to be reaped. */
export function isProcessRunning(pid: number): boolean {
  const id = identities([pid]).get(pid);
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
  opts: {
    graceMs?: number;
    /** @internal Tests only: replaces the marker scan. */
    find?: (markers: readonly string[]) => Map<string, number[]>;
  } = {},
): Promise<{ found: number[]; left: number[] }> {
  const find = opts.find ?? markedProcesses;
  const tracked = new Map<number, string>();
  const found: number[] = [];
  /** Newly marked processes, which are now tracked. */
  const scan = (): number[] => {
    const pids = [...find(markers).values()].flat().filter((pid) => !tracked.has(pid));
    const ids = identities(pids);
    const fresh: number[] = [];
    for (const pid of pids) {
      const id = ids.get(pid);
      if (!id || id.zombie) continue;
      tracked.set(pid, id.start);
      found.push(pid);
      fresh.push(pid);
    }
    return fresh;
  };
  /** Tracked processes still running as the same process; the others stop being tracked. */
  const running = (): number[] => {
    const ids = identities([...tracked.keys()]);
    return [...tracked].flatMap(([pid, start]) => {
      const id = ids.get(pid);
      if (id && !id.zombie && id.start === start) return [pid];
      tracked.delete(pid);
      return [];
    });
  };
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
