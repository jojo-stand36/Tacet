import { readdirSync, readFileSync } from 'node:fs';

/**
 * Whether process group `pgid` has a running member. One `kill(-pgid, 0)` first, the common
 * answer being "gone". On Linux the group is then checked in `/proc`, where a zombie does not
 * count: its parent (often an init that does not reap orphans in a container) has yet to reap
 * it, though `kill(-pgid, 0)` still finds it. EPERM (no member we can signal) reads as gone.
 */
export function processGroupAlive(pgid: number): boolean {
  if (process.platform === 'win32') return false;
  try {
    process.kill(-pgid, 0);
  } catch {
    return false;
  }
  if (process.platform === 'linux') {
    try {
      return readdirSync('/proc').some((d) => {
        if (!/^\d+$/.test(d)) return false;
        try {
          // Fields after the parenthesised command name: state, ppid, pgrp.
          const stat = readFileSync(`/proc/${d}/stat`, 'utf8');
          const [state, , pgrp] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
          return Number(pgrp) === pgid && state !== 'Z';
        } catch {
          return false;
        }
      });
    } catch {
      // No /proc: trust the signal.
    }
  }
  return true;
}

/**
 * Wait until the process group led by `pid` has no running member, polling until `ms` has
 * passed; `false` if members remain. Call it once the leader itself has exited: until then its
 * pid is the group's. Without a pid, or on Windows, there is no group to wait for.
 */
export async function processGroupGone(pid: number | undefined, ms: number): Promise<boolean> {
  if (pid === undefined || process.platform === 'win32') return true;
  const deadline = Date.now() + ms;
  for (;;) {
    if (!processGroupAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 50).unref());
  }
}
