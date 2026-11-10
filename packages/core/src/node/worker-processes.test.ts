import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  endMarkedProcesses,
  isWorkerMarker,
  markedProcesses,
  newWorkerMarker,
  WORKER_MARKER_VAR,
} from './worker-processes.js';

/** Running, not a zombie (in a container, PID 1 may never reap an orphan). */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== 'linux') return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch {
    return false;
  }
};

const started: ChildProcess[] = [];

/**
 * A process carrying `marker` that starts a detached child (its own process group), as Claude Code
 * does with its Bash tools. Resolves with the grandchild's pid.
 */
function worker(marker: string, opts: { ignoreTerm?: boolean } = {}) {
  const ignore = opts.ignoreTerm ? "process.on('SIGTERM', () => {});" : '';
  const kid = `${ignore} setInterval(() => {}, 1000);`;
  const script = `${ignore}
    const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(kid)}], { detached: true, stdio: 'ignore' });
    c.unref();
    console.log(c.pid);
    setInterval(() => {}, 1000);`;
  const leader = spawn(process.execPath, ['-e', script], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', [WORKER_MARKER_VAR]: marker },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  started.push(leader);
  const grandchild = new Promise<number>((resolve) =>
    leader.stdout?.once('data', (b: Buffer) => {
      const pid = Number.parseInt(b.toString(), 10);
      grandchildren.push(pid);
      resolve(pid);
    }),
  );
  return { leader, grandchild };
}

const grandchildren: number[] = [];

afterEach(async () => {
  for (const p of started.splice(0)) p.kill('SIGKILL');
  for (const pid of grandchildren.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Gone.
    }
  }
});

describe.skipIf(process.platform === 'win32')('Worker processes by marker (#127)', () => {
  it('makes markers that only match their own form', () => {
    const m = newWorkerMarker();
    expect(isWorkerMarker(m)).toBe(true);
    for (const bad of ['', 'PATH=/usr/bin', '*', `${m}\n`, `${m} x`, 42]) {
      expect(isWorkerMarker(bad)).toBe(false);
    }
  });

  it('finds the processes that carry a marker, and no others', async () => {
    const mine = newWorkerMarker();
    const other = newWorkerMarker();
    const a = worker(mine);
    const b = worker(other);
    const kidA = await a.grandchild;
    await b.grandchild;
    const found = markedProcesses([mine, 'not-a-marker']);
    expect(found.get(mine)).toEqual(expect.arrayContaining([a.leader.pid, kidA]));
    expect(found.has(other)).toBe(false);
    expect(found.get(mine)).not.toContain(b.leader.pid);
    expect(markedProcesses([])).toEqual(new Map());
  });

  it('ends them, also in another session, and SIGKILLs what ignores SIGTERM', async () => {
    const m1 = newWorkerMarker();
    const m2 = newWorkerMarker();
    const a = worker(m1);
    const b = worker(m2, { ignoreTerm: true });
    const other = worker(newWorkerMarker());
    const kids = [await a.grandchild, await b.grandchild];
    const bystander = await other.grandchild;
    const pids = [a.leader.pid, b.leader.pid, ...kids] as number[];
    expect(await endMarkedProcesses([m1, m2], { graceMs: 300 })).toBe(pids.length);
    for (const pid of pids) await expect.poll(() => alive(pid)).toBe(false);
    expect(alive(bystander)).toBe(true);
    expect(alive(other.leader.pid as number)).toBe(true);
    expect(await endMarkedProcesses([m1, m2])).toBe(0);
  });
});
