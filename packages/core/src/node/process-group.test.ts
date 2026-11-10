import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { endProcessGroup, processStartTime } from './process-group.js';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A group leader (a shell) with a child that outlives it, like a vendor CLI and its tools. */
function group(leaderLives = true) {
  const script = leaderLives ? 'sleep 60 & echo $!; wait' : 'sleep 60 & echo $!';
  const leader = spawn('sh', ['-c', script], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const child = new Promise<number>((resolve) =>
    leader.stdout?.once('data', (b: Buffer) => resolve(Number.parseInt(b.toString(), 10))),
  );
  return { leader, child };
}

describe.skipIf(process.platform === 'win32')('process groups (#127)', () => {
  it('reads a start time that tells processes apart', () => {
    const t = processStartTime(process.pid);
    expect(t).toBeTruthy();
    expect(processStartTime(process.pid)).toBe(t);
    expect(processStartTime(0)).toBeUndefined();
    expect(processStartTime(2 ** 22 + 12345)).toBeUndefined();
  });

  it('ends the recorded group, leader and children', async () => {
    const { leader, child } = group();
    const pgid = leader.pid as number;
    const kid = await child;
    const rec = { pgid, startTime: processStartTime(pgid) as string };
    expect(alive(kid)).toBe(true);
    expect(await endProcessGroup(rec)).toBe('ended');
    await expect.poll(() => alive(kid)).toBe(false);
    await expect.poll(() => leader.exitCode !== null || leader.signalCode !== null).toBe(true);
  });

  it('ends what is left of a group whose leader is gone', async () => {
    const { leader, child } = group(false);
    const pgid = leader.pid as number;
    const kid = await child;
    const startTime = processStartTime(pgid) as string;
    await new Promise((r) => leader.once('exit', r));
    expect(alive(kid)).toBe(true);
    expect(await endProcessGroup({ pgid, startTime })).toBe('ended');
    await expect.poll(() => alive(kid)).toBe(false);
  });

  it('signals nothing when the pid now belongs to another process', async () => {
    const { leader, child } = group();
    const pgid = leader.pid as number;
    const kid = await child;
    // As if the pid had been reused: the recorded start time is not this process's.
    expect(await endProcessGroup({ pgid, startTime: 'not-this-one' })).toBe('reused');
    expect(await endProcessGroup({ pgid })).toBe('reused');
    expect(alive(kid)).toBe(true);
    process.kill(-pgid, 'SIGKILL');
  });

  it('never signals group 0, 1 or its own process', async () => {
    for (const pgid of [0, 1, -5, 1.5, process.pid]) {
      expect(await endProcessGroup({ pgid })).toBe('gone');
    }
    expect(await endProcessGroup({ pgid: 2 ** 22 + 12345 })).toBe('gone');
  });
});
