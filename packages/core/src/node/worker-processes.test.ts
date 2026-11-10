import { type ChildProcess, spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  endMarkedProcesses,
  isProcessRunning,
  isWorkerMarker,
  markedProcesses,
  newWorkerMarker,
  WORKER_MARKER_VAR,
} from './worker-processes.js';

const alive = isProcessRunning;

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

  it('counts a zombie as not running, though kill(pid, 0) still reaches it', async () => {
    // The shell becomes `sleep 5` before its child `sleep 1` exits, and `sleep` never reaps it.
    const parent = spawn('sh', ['-c', 'sleep 1 & echo $!; exec sleep 5'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    started.push(parent);
    const zombie = await new Promise<number>((resolve) =>
      parent.stdout?.once('data', (b: Buffer) => resolve(Number.parseInt(b.toString(), 10))),
    );
    expect(isProcessRunning(zombie)).toBe(true);
    await expect.poll(() => isProcessRunning(zombie), { timeout: 4000 }).toBe(false);
    expect(() => process.kill(zombie, 0)).not.toThrow();
    expect(isProcessRunning(parent.pid as number)).toBe(true);
    expect(isProcessRunning(2 ** 22 + 12345)).toBe(false);
  });

  it('follows a found process by pid, even once its marker can no longer be read', async () => {
    const m = newWorkerMarker();
    const w = worker(m, { ignoreTerm: true });
    await w.grandchild;
    const pid = w.leader.pid as number;
    // The scan finds it once, then never again, as if its environment could no longer be read.
    let scans = 0;
    const find = () => new Map(scans++ === 0 ? [[m, [pid]]] : []);
    const ended = await endMarkedProcesses([m], { graceMs: 300, find });
    expect(ended).toEqual({ found: [pid], left: [] });
    await expect.poll(() => alive(pid)).toBe(false);
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
    const ended = await endMarkedProcesses([m1, m2], { graceMs: 300 });
    expect(ended.found).toEqual(expect.arrayContaining(pids));
    expect(ended.left).toEqual([]);
    for (const pid of pids) await expect.poll(() => alive(pid)).toBe(false);
    expect(alive(bystander)).toBe(true);
    expect(alive(other.leader.pid as number)).toBe(true);
    expect(await endMarkedProcesses([m1, m2])).toEqual({ found: [], left: [] });
  });
});
