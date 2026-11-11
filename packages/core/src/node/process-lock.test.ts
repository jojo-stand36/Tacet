import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { processLockHolder, releaseProcessLock, takeProcessLock } from './process-lock.js';

const text = {
  heldHere: 'held here',
  heldBy: (pid: number) => `held by ${pid}`,
  failed: 'failed',
};

describe('a single-instance process lock (#23)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const lockIn = () => {
    const d = mkdtempSync(join(tmpdir(), 'tacet-lock-'));
    dirs.push(d);
    return join(d, 'sub', 'x.lock');
  };

  it('is taken once, names its holder, and is released', () => {
    const lock = lockIn();
    expect(processLockHolder(lock)).toBeUndefined();
    takeProcessLock(lock, text);
    expect(readFileSync(lock, 'utf8')).toBe(`${process.pid}\n`);
    expect(processLockHolder(lock)).toBe(process.pid);
    expect(() => takeProcessLock(lock, text)).toThrow('held here');
    releaseProcessLock(lock);
    expect(processLockHolder(lock)).toBeUndefined();
  });

  it('refuses a lock a live process holds, and takes over one a dead process left', async () => {
    const lock = lockIn();
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      stdio: 'ignore',
    });
    try {
      takeProcessLock(lock, text);
      releaseProcessLock(lock);
      writeFileSync(lock, `${other.pid}\n`);
      expect(() => takeProcessLock(lock, text)).toThrow(`held by ${other.pid}`);
      expect(processLockHolder(lock)).toBe(other.pid);
    } finally {
      other.kill('SIGKILL');
      await new Promise((r) => other.once('exit', r));
    }
    // Its holder is gone: stale, taken over.
    expect(processLockHolder(lock)).toBeUndefined();
    takeProcessLock(lock, text);
    expect(processLockHolder(lock)).toBe(process.pid);
    releaseProcessLock(lock);
  });
});
