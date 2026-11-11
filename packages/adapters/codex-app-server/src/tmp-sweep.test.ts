import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sweepWorkerTmpdirs } from './adapter.js';
import { codexFixtureDir } from './testing/fixture-dir.js';

/** A pid that no process has any more: a child that has exited. */
const deadPid = (): number => {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  return Number(String(r.stdout));
};

describe('sweepWorkerTmpdirs (#299)', () => {
  let base: string;
  let root: string;
  beforeEach(() => {
    base = codexFixtureDir('tacet-299-');
    root = join(base, 'codex-tmp');
    mkdirSync(root);
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  /** A Worker TMPDIR with some content, and its owner record unless `owner` is undefined. */
  const tmpdir = (owner?: { host: number; group?: number }) => {
    const dir = join(root, randomUUID());
    mkdirSync(join(dir, 'sub'), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'sub', 'f'), 'x');
    if (owner) writeFileSync(`${dir}.owner`, JSON.stringify(owner));
    return dir;
  };

  it('removes what dead hosts left, with their owner records, and keeps a live host’s', () => {
    const dead = tmpdir({ host: deadPid() });
    // A Worker locked a directory in it: removed all the same.
    chmodSync(join(dead, 'sub'), 0o000);
    const mine = tmpdir({ host: process.pid, group: process.pid });
    expect(sweepWorkerTmpdirs(root)).toBe(1);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(`${dead}.owner`)).toBe(false);
    expect(existsSync(mine)).toBe(true);
    expect(existsSync(`${mine}.owner`)).toBe(true);
  });

  it('keeps a dir whose host is gone while its Codex process group still runs', async () => {
    const codex = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      detached: true,
      stdio: 'ignore',
    });
    try {
      const dir = tmpdir({ host: deadPid(), group: codex.pid as number });
      expect(sweepWorkerTmpdirs(root)).toBe(0);
      expect(existsSync(dir)).toBe(true);
      process.kill(-(codex.pid as number), 'SIGKILL');
      await new Promise((r) => codex.once('exit', r));
      // Reaped: the group is gone now.
      await new Promise((r) => setTimeout(r, 50));
      expect(sweepWorkerTmpdirs(root)).toBe(1);
      expect(existsSync(dir)).toBe(false);
    } finally {
      try {
        process.kill(-(codex.pid as number), 'SIGKILL');
      } catch {
        // Gone already.
      }
    }
  });

  it('keeps a fresh dir with no owner record, and removes one a day old', () => {
    const fresh = tmpdir();
    const old = tmpdir();
    const dayAgo = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
    utimesSync(old, dayAgo, dayAgo);
    expect(sweepWorkerTmpdirs(root)).toBe(1);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(old)).toBe(false);
  });

  it('touches nothing but uuid-named directories of the user', () => {
    const outside = join(base, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep'), 'x');
    const link = join(root, randomUUID());
    symlinkSync(outside, link);
    writeFileSync(`${link}.owner`, JSON.stringify({ host: deadPid() }));
    mkdirSync(join(root, 'not-a-uuid'));
    writeFileSync(join(root, 'not-a-uuid.owner'), JSON.stringify({ host: deadPid() }));
    expect(sweepWorkerTmpdirs(root)).toBe(0);
    expect(readdirSync(outside)).toEqual(['keep']);
    expect(existsSync(join(root, 'not-a-uuid'))).toBe(true);
    // No root at all is not an error.
    expect(sweepWorkerTmpdirs(join(base, 'missing'))).toBe(0);
  });
});
