import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnDetachedWith } from './detach.js';

/** The real background start (#201), on a script that reports what it was given. */
describe('spawnDetachedWith', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tacet-detach-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

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
    // Node may add a few variables of its own; nothing else of this process's environment.
    expect(got.env.ONLY_THIS).toBe('yes');
    for (const k of Object.keys(process.env)) {
      if (!(k in env)) expect(got.env[k], k).toBeUndefined();
    }
    expect(got.stdin).toBe(0);
    expect(got.ownGroup).toBe(true);
    expect(rest.join('\n')).toContain('to the log too');
  });
});
