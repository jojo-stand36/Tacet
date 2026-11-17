import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';

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
 * Pids of this user's processes that carry one of `markers`, by marker, and each one's process
 * tree (#367): its descendants (by parent pid), and the members of a process group (or, on Linux,
 * a session) that one of them leads, which inherited the marker even when their environment cannot
 * be read (macOS hides a platform binary's from `ps -E` while SIP is on). Linux reads
 * `/proc/<pid>/environ` (only readable for the user's own processes); macOS asks `/bin/ps -E`.
 * This process is never listed.
 */
export function markedProcesses(
  markers: readonly string[],
  /** @internal Tests only: replaces the process table the trees are read from. */
  table?: () => readonly ProcessInfo[],
): Map<string, number[]> {
  const byEnv = markedByEnvironment(markers);
  if (byEnv.size === 0) return byEnv;
  return withTrees(byEnv, (table ?? processTable)());
}

/** One process of the user, as the process table shows it. */
export interface ProcessInfo {
  pid: number;
  ppid: number;
  /** Its process group. */
  pgid: number;
  /** Its session, where the platform tells it (Linux; macOS `ps` prints 0). */
  sid?: number;
  zombie: boolean;
}

/**
 * Add to each marker's pids the processes of their trees (see `markedProcesses`), until nothing
 * more is added. Only the user's own processes are in `table`; this process never is added.
 */
export function withTrees(
  found: ReadonlyMap<string, readonly number[]>,
  table: readonly ProcessInfo[],
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const [marker, pids] of found) {
    const tree = new Set(pids);
    for (let grew = true; grew; ) {
      grew = false;
      for (const p of table) {
        if (tree.has(p.pid) || p.pid === process.pid || p.zombie) continue;
        const led = (id: number | undefined) => id !== undefined && id > 1 && tree.has(id);
        if (led(p.ppid) || led(p.pgid) || led(p.sid)) {
          tree.add(p.pid);
          grew = true;
        }
      }
    }
    out.set(marker, [...tree]);
  }
  return out;
}

/**
 * The user's processes. Linux: `/proc/<pid>/stat` (parent, group, session, state) of each process
 * the user owns. macOS: one `ps` of the user's processes.
 */
export function processTable(): ProcessInfo[] {
  const me = process.getuid?.();
  const out: ProcessInfo[] = [];
  if (process.platform === 'linux') {
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        if (me !== undefined && statSync(`/proc/${name}`).uid !== me) continue;
        const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
        const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        out.push({
          pid: Number(name),
          ppid: Number(f[1]),
          pgid: Number(f[2]),
          sid: Number(f[3]),
          zombie: f[0] === 'Z',
        });
      } catch {
        // Gone.
      }
    }
    return out;
  }
  for (const row of psRows(['pid=', 'ppid=', 'pgid=', 'stat='])) {
    const [pid, ppid, pgid, stat] = row;
    if (pid === undefined || ppid === undefined || pgid === undefined) continue;
    out.push({
      pid: Number(pid),
      ppid: Number(ppid),
      pgid: Number(pgid),
      zombie: (stat ?? '').startsWith('Z'),
    });
  }
  return out;
}

/** macOS: the user's processes from `/bin/ps -x -U <uid>`, each line split into its columns. */
function psRows(columns: readonly string[]): string[][] {
  return psLines(columns).map((l) => l.trim().split(/\s+/));
}

/** macOS: the lines `/bin/ps -x -U <uid>` prints for `columns`, in UTC and the C locale. */
function psLines(columns: readonly string[], extra: readonly string[] = []): string[] {
  let text: string;
  try {
    text = execFileSync(
      '/bin/ps',
      [...extra, '-ww', '-x', '-U', String(process.getuid?.() ?? ''), '-o', columns.join(',')],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC0' },
        maxBuffer: 64 * 1024 * 1024,
      },
    );
  } catch {
    return [];
  }
  return text.split('\n').filter((l) => l.trim() !== '');
}

/**
 * Where a session or a `verify` command ran, for finding on macOS what it left running whose
 * marker cannot be read (#367): processes started at or after `since` (ms since the epoch) whose
 * working directory is `dir` or inside it.
 */
export interface OrphanScope {
  since: number;
  dir: string;
}

/** A process `unreadableOrphans` may take, as the platform shows it. */
export interface OrphanCandidate {
  pid: number;
  ppid: number;
  /** When it started, in ms since the epoch, to the second `ps` reports. */
  startMs: number;
  /** Its environment cannot be read (`ps -E` shows none). */
  envHidden: boolean;
  command: string;
}

/** How `unreadableOrphans` looks at processes; replaced in tests. */
export interface OrphanProbe {
  platform: NodeJS.Platform;
  /** The user's orphaned processes (parent pid 1). */
  candidates(): OrphanCandidate[];
  /** The working directory of each of `pids` that can be read. */
  cwdOf(pids: readonly number[]): Map<number, string>;
}

/**
 * macOS only (#367): the user's processes that a Worker session or a `verify` command in one of
 * `scopes` most likely left running, though no marker shows it. A process is taken only if all of
 * these hold: it is orphaned (parent pid 1), so nothing of the user's own still holds it; its
 * environment cannot be read, so it is not one whose environment shows it is not ours (with SIP
 * on, macOS hides a platform binary's from every other process); it started at or after a scope's
 * `since` (to the second `ps` reports); and its working directory, after symlinks, is that
 * scope's `dir` or inside it. One that moved out of the directory is missed; one the user started
 * there themselves meanwhile, from a shell since gone, would be taken, so the caller records every
 * one. Elsewhere, or with no scope, none.
 */
export function unreadableOrphans(
  scopes: readonly OrphanScope[],
  probe: OrphanProbe = darwinProbe,
): { pid: number; command: string }[] {
  if (probe.platform !== 'darwin' || scopes.length === 0) return [];
  const earliest = Math.min(...scopes.map((s) => Math.floor(s.since / 1000) * 1000));
  const picked = probe
    .candidates()
    .filter(
      (c) =>
        c.ppid === 1 &&
        c.envHidden &&
        c.pid !== process.pid &&
        Number.isFinite(c.startMs) &&
        c.startMs >= earliest,
    );
  if (picked.length === 0) return [];
  const cwds = probe.cwdOf(picked.map((c) => c.pid));
  // Never on doubt: a scope whose directory cannot be resolved takes nothing, and neither does a
  // working directory that cannot be read, is gone, or is not already its own real path (lsof
  // reports the resolved one, so a different real path means a link was in the way).
  const realOrUndefined = (p: string): string | undefined => {
    try {
      return realpathSync(p);
    } catch {
      return undefined;
    }
  };
  const dirs = scopes.flatMap((s) => {
    const dir = realOrUndefined(s.dir);
    return dir === undefined ? [] : [{ since: Math.floor(s.since / 1000) * 1000, dir }];
  });
  return picked.flatMap((c) => {
    const cwd = cwds.get(c.pid);
    if (cwd === undefined || !isAbsolute(cwd)) return [];
    const at = realOrUndefined(cwd);
    if (at === undefined || at !== cwd) return [];
    const inside = dirs.some((d) => {
      if (c.startMs < d.since) return false;
      const rel = relative(d.dir, at);
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    });
    return inside ? [{ pid: c.pid, command: c.command }] : [];
  });
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `ps -o lstart` in the C locale and UTC (`Tue Nov 17 10:48:32 2026`), in ms since the epoch. */
export function parseLstart(words: readonly string[]): number {
  const [, mon, day, time, year] = words;
  const [h, m, sec] = (time ?? '').split(':').map(Number);
  const month = MONTHS.indexOf(mon ?? '');
  if (month < 0) return Number.NaN;
  return Date.UTC(
    Number(year),
    month,
    Number(day),
    h ?? Number.NaN,
    m ?? Number.NaN,
    sec ?? Number.NaN,
  );
}

/** The real probe: `ps` with and without `-E`, and `lsof` for working directories. */
const darwinProbe: OrphanProbe = {
  platform: process.platform,
  candidates() {
    // `pid ppid` then `lstart` (five words) then the command; with `-E`, the environment follows
    // it, and nothing follows it when the environment cannot be read.
    const parse = (line: string) => {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s(.*)$/);
      return m
        ? { pid: Number(m[1]), ppid: Number(m[2]), lstart: m[3] ?? '', rest: m[4] ?? '' }
        : undefined;
    };
    const cols = ['pid=', 'ppid=', 'lstart=', 'command='];
    const plain = new Map<number, ReturnType<typeof parse>>();
    for (const l of psLines(cols)) {
      const r = parse(l);
      if (r && r.ppid === 1) plain.set(r.pid, r);
    }
    if (plain.size === 0) return [];
    const withEnv = new Map<number, string>();
    for (const l of psLines(cols, ['-E'])) {
      const r = parse(l);
      if (r && plain.has(r.pid)) withEnv.set(r.pid, r.rest);
    }
    return [...plain.values()].flatMap((r) => {
      if (!r) return [];
      const env = withEnv.get(r.pid);
      return [
        {
          pid: r.pid,
          ppid: r.ppid,
          startMs: parseLstart(r.lstart.split(/\s+/)),
          // Seen in both, and `-E` added nothing: no environment shown.
          envHidden: env !== undefined && env.trimEnd() === r.rest.trimEnd(),
          command: r.rest.trimEnd(),
        },
      ];
    });
  },
  cwdOf(pids) {
    const out = new Map<number, string>();
    if (pids.length === 0) return out;
    let text = '';
    try {
      text = execFileSync('/usr/sbin/lsof', ['-a', '-d', 'cwd', '-Fn', '-p', pids.join(',')], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { PATH: '/usr/bin:/bin:/usr/sbin', LC_ALL: 'C' },
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch (err) {
      // lsof exits 1 when some pid is gone, and still prints the others.
      text = String((err as { stdout?: unknown }).stdout ?? '');
    }
    let pid: number | undefined;
    for (const line of text.split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1));
      else if (line.startsWith('n') && pid !== undefined && !out.has(pid))
        out.set(pid, line.slice(1));
    }
    return out;
  },
};

function markedByEnvironment(markers: readonly string[]): Map<string, number[]> {
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

/**
 * When `pid` started, as an opaque string to compare (it tells a process apart from a later one
 * with the same pid), or undefined when there is no such process or its start time cannot be
 * read.
 */
export function processStartTime(pid: number): string | undefined {
  return identities([pid]).get(pid)?.start;
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
 * looks for marked processes forked meanwhile, and their trees (`markedProcesses`). Returns the
 * pids found, and those still running after SIGKILL (normally none).
 *
 * With `orphans`, on macOS also the processes `unreadableOrphans` takes for those scopes (#367),
 * ended the same way and returned as `orphans` too, for the caller to record each one.
 */
export async function endMarkedProcesses(
  markers: readonly string[],
  opts: {
    graceMs?: number;
    /** @internal Tests only: replaces the marker scan. */
    find?: (markers: readonly string[]) => Map<string, number[]>;
    /** Where the sessions or commands ran, for their unreadable orphans (macOS, #367). */
    orphans?: readonly OrphanScope[];
    /** @internal Tests only: replaces how orphans are looked for. */
    probe?: OrphanProbe;
  } = {},
): Promise<{ found: number[]; left: number[]; orphans?: { pid: number; command: string }[] }> {
  const find = opts.find ?? markedProcesses;
  const tracked = new Map<number, string>();
  const found: number[] = [];
  const orphans: { pid: number; command: string }[] = [];
  /** Orphans not found by a marker (those are ended as marked), not yet tracked. */
  const lookForOrphans = (marked: ReadonlySet<number>): number[] => {
    if (!opts.orphans?.length) return [];
    const fresh = unreadableOrphans(opts.orphans, opts.probe).filter(
      (o) => !tracked.has(o.pid) && !marked.has(o.pid),
    );
    for (const o of fresh) if (!orphans.some((x) => x.pid === o.pid)) orphans.push(o);
    return fresh.map((o) => o.pid);
  };
  /** Newly marked processes (and orphans), which are now tracked. */
  const scan = (): number[] => {
    const marked = new Set([...find(markers).values()].flat());
    const pids = [...new Set([...marked, ...lookForOrphans(marked)])].filter(
      (pid) => !tracked.has(pid),
    );
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
  const result = (left: number[]) => ({
    found,
    left,
    ...(opts.orphans ? { orphans: orphans.filter((o) => found.includes(o.pid)) } : {}),
  });
  scan();
  if (tracked.size === 0) return result([]);
  for (const pid of running()) signal(pid, 'SIGTERM');
  const deadline = Date.now() + (opts.graceMs ?? 5000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    for (const pid of scan()) signal(pid, 'SIGTERM');
    if (running().length === 0) return result([]);
  }
  const killDeadline = Date.now() + 2000;
  for (;;) {
    scan();
    const left = running();
    if (left.length === 0 || Date.now() >= killDeadline) return result(left);
    for (const pid of left) signal(pid, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 100));
  }
}
