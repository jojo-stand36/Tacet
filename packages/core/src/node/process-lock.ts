import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** What a lock's refusals say: the daemon's own words (`Mini-conductor`, `Conductor`). */
export interface ProcessLockText {
  /** This process already holds it. */
  heldHere: string;
  /** Another live process (`pid`) holds it. */
  heldBy: (pid: number) => string;
  /** It could not be taken (lost every race). */
  failed: string;
}

/** Lock files held by daemons in this process. */
const HELD = new Set<string>();

/** True when `pid` is a live process (one this user may not signal counts as live). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Take a single-instance lock: a 0600 file holding this process's pid, created exclusively. A lock
 * left by a process that is gone is taken over, renamed away first so that of two processes doing
 * this at once only one wins. Throws `text.heldBy` when a live process holds it.
 */
export function takeProcessLock(path: string, text: ProcessLockText): void {
  if (HELD.has(path)) throw new Error(text.heldHere);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(path, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
      HELD.add(path);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const aside = `${path}.${process.pid}.${randomUUID()}.stale`;
    try {
      renameSync(path, aside);
    } catch {
      continue;
    }
    const pid = Number.parseInt(readFileSync(aside, 'utf8'), 10);
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && isProcessAlive(pid)) {
      // Not stale after all: put it back and refuse.
      try {
        renameSync(aside, path);
      } catch {
        rmSync(aside, { force: true });
      }
      throw new Error(text.heldBy(pid));
    }
    rmSync(aside, { force: true });
  }
  throw new Error(text.failed);
}

/** Release a lock this process took with `takeProcessLock`; a no-op for any other. */
export function releaseProcessLock(path: string): void {
  if (!HELD.delete(path)) return;
  rmSync(path, { force: true });
}

/** The pid of the live process holding the lock at `path`, or undefined. Never takes it. */
export function processLockHolder(path: string): number | undefined {
  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(path, 'utf8'), 10);
  } catch {
    return undefined;
  }
  return Number.isInteger(pid) && pid > 0 && isProcessAlive(pid) ? pid : undefined;
}
