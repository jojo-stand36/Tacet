import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * A vendor process group a Worker session ran in (#127): the leader's pid, which is also the
 * group id because adapters start vendor processes as group leaders, and the leader's start time,
 * which tells the process apart from a later one that got the same pid.
 */
export interface ProcessGroupRecord {
  pgid: number;
  startTime?: string;
}

/**
 * When `pid` started, as an opaque string to compare, or undefined if no such process (or the
 * platform cannot say). Linux: field 22 of `/proc/<pid>/stat` (clock ticks since boot); macOS:
 * `ps -o lstart=`.
 */
export function processStartTime(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // The command name (field 2) is in parentheses and may contain spaces or parentheses.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return fields[19] || undefined;
    }
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C' },
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but is not ours, which counts as alive (and is never signalled below).
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * End a process group left behind by an earlier run (#127): SIGTERM, then SIGKILL after
 * `graceMs`. Guarded against pid reuse: while a process with the group's id is alive, it must be
 * the recorded leader (same start time), or nothing is signalled. Once the leader is gone, a group
 * with its id can only be what is left of the recorded one, because a new group always takes its
 * creator's pid as its id, and that pid cannot be reused while the group exists.
 */
export async function endProcessGroup(
  rec: ProcessGroupRecord,
  opts: { graceMs?: number } = {},
): Promise<'ended' | 'gone' | 'reused'> {
  const { pgid } = rec;
  // Never 0 or 1 (kill(-0) and kill(-1) reach far more than one group), never this process.
  if (!Number.isInteger(pgid) || pgid <= 1 || pgid === process.pid) return 'gone';
  const leader = processStartTime(pgid);
  if (leader !== undefined && leader !== rec.startTime) return 'reused';
  try {
    process.kill(-pgid, 'SIGTERM');
  } catch {
    // ESRCH: nothing left. EPERM: not ours to end.
    return 'gone';
  }
  const deadline = Date.now() + (opts.graceMs ?? 2000);
  while (groupAlive(pgid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (groupAlive(pgid)) {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      // Gone in between.
    }
  }
  return 'ended';
}
