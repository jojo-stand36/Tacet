import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnDetachedWith } from './detach.js';

/**
 * Variables the OS itself adds to every process it starts, whatever its parent passed: macOS's
 * CoreFoundation sets its text encoding (seen on the macOS CI runner).
 */
const OS_ADDED: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: ['__CF_USER_TEXT_ENCODING'],
};

/** The real background start (#201), on a script that reports what it was given. */
describe('spawnDetachedWith', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tacet-detach-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // A secret in this process's environment, as a user's API key would be.
  const SENTINEL = 'TACET_DETACH_TEST_SECRET';
  beforeEach(() => {
    process.env[SENTINEL] = 'sk-not-for-the-child';
  });
  afterEach(() => {
    delete process.env[SENTINEL];
  });

  it('starts it in a session of its own, with exactly the given environment, no stdin, output to the log', async () => {
    const script = join(dir, 'report.cjs');
    writeFileSync(
      script,
      [
        "const { readSync } = require('node:fs');",
        'let stdin = -1;',
        'try { stdin = readSync(0, Buffer.alloc(1)); } catch { stdin = -2; }',
        'process.stdout.write(JSON.stringify({',
        '  argv: process.argv.slice(2), env: process.env, stdin,',
        // A session leader's process group is its own pid.
        "  ownGroup: require('node:child_process').execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)]).toString().trim() === String(process.pid),",
        '}));',
        "process.stderr.write('\\nto the log too\\n');",
      ].join('\n'),
    );
    const log = join(dir, 'run.log');
    const fd = openSync(log, 'w', 0o600);
    const env = { PATH: process.env.PATH ?? '', ONLY_THIS: 'yes' };
    const child = spawnDetachedWith(script)(['run', 'a task', '--detached-child'], env, fd);
    closeSync(fd);
    expect(child.pid).toBeGreaterThan(0);
    expect(await child.exited).toBe(0);
    const [json, ...rest] = readFileSync(log, 'utf8').split('\n');
    const got = JSON.parse(json ?? '') as {
      argv: string[];
      env: Record<string, string>;
      stdin: number;
      ownGroup: boolean;
    };
    expect(got.argv).toEqual(['run', 'a task', '--detached-child']);
    // Exactly the given environment. The OS may add a variable of its own to every process it
    // starts (named here, per platform); nothing of this process's environment gets through.
    expect(got.env.ONLY_THIS).toBe('yes');
    expect(got.env[SENTINEL]).toBeUndefined();
    const added = Object.keys(got.env).filter((k) => !(k in env));
    expect(added.filter((k) => !(OS_ADDED[process.platform] ?? []).includes(k))).toEqual([]);
    expect(got.stdin).toBe(0);
    expect(got.ownGroup).toBe(true);
    expect(rest.join('\n')).toContain('to the log too');
  });
});
