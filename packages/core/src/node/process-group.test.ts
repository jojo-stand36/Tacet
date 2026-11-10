import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { processGroupAlive, processGroupGone } from './process-group.js';

describe.runIf(process.platform !== 'win32')('process groups (#191)', () => {
  it('waits for a group whose leader exited but a member still runs', async () => {
    // A leader that starts a SIGTERM-ignoring member, then exits at once.
    const leader = spawn('sh', ['-c', '(trap "" TERM; while :; do sleep 0.1; done) & echo $!'], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pgid = leader.pid as number;
    const member = Number(
      await new Promise<string>((r) => leader.stdout?.once('data', (b: Buffer) => r(String(b)))),
    );
    await new Promise((r) => leader.once('exit', r));
    try {
      expect(processGroupAlive(pgid)).toBe(true);
      process.kill(-pgid, 'SIGTERM'); // ignored by the member
      expect(await processGroupGone(pgid, 200)).toBe(false);
      process.kill(-pgid, 'SIGKILL');
      expect(await processGroupGone(pgid, 2000)).toBe(true);
    } finally {
      try {
        process.kill(member, 'SIGKILL');
      } catch {}
    }
  });

  it('has nothing to wait for without a pid', async () => {
    expect(await processGroupGone(undefined, 10)).toBe(true);
  });
});
