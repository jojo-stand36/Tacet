import {
  closeSync,
  constants,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cappedLog } from './capped-log.js';
import { childArgs, isDetachedChild } from './commands/detach.js';

describe('cappedLog (#273)', () => {
  let dir: string;
  let file: string;
  let fd: number;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tacet-capped-'));
    file = join(dir, 'run.log');
    // As `tacet run --detach` opens it for its background run.
    fd = openSync(
      file,
      constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC | constants.O_APPEND,
      0o600,
    );
  });
  afterEach(() => {
    closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  });
  const numbers = (text: string) =>
    text
      .split('\n')
      .flatMap((l) => (/^line (\d+) /.exec(l) ? [Number(/^line (\d+) /.exec(l)?.[1])] : []));

  it('stays under the cap, keeping the newest lines, whole and in order, after a note', () => {
    const log = cappedLog(fd, 1000);
    for (let i = 0; i < 500; i++) log(`line ${i} ${'x'.repeat(20)}`);
    const text = readFileSync(file, 'utf8');
    expect(statSync(file).size).toBeLessThanOrEqual(1000);
    expect(text.startsWith('[earlier lines dropped to keep this log under 1000 bytes]\n')).toBe(
      true,
    );
    const kept = numbers(text);
    expect(kept.at(-1)).toBe(499);
    // More than the last line: the newest half is kept, not just what came after the cut.
    expect(kept.length).toBeGreaterThan(5);
    expect(kept.every((n, i) => i === 0 || n === (kept[i - 1] as number) + 1)).toBe(true);
    expect(
      text.split('\n').every((l) => l === '' || l.startsWith('[') || /^line \d+ x+$/.test(l)),
    ).toBe(true);
  });

  it('counts what is written to the file around it, such as a warning Node prints', () => {
    const log = cappedLog(fd, 1000);
    for (let i = 0; i < 40; i++) {
      log(`line ${i} ${'x'.repeat(20)}`);
      writeSync(fd, `(node) warning ${'w'.repeat(80)}\n`);
    }
    log('line 40 last');
    expect(statSync(file).size).toBeLessThanOrEqual(1000);
    expect(readFileSync(file, 'utf8')).toMatch(/line 40 last\n$/);
  });

  it('keeps the end of a line longer than half the cap, from a whole character', () => {
    const log = cappedLog(fd, 400);
    log('short');
    log(`${'é'.repeat(300)} end`);
    const text = readFileSync(file, 'utf8');
    expect(statSync(file).size).toBeLessThanOrEqual(400);
    expect(text).toMatch(/é end\n$/);
    expect(text).not.toContain('�');
  });

  it('leaves what a crash wrote before it existed in the same file', () => {
    writeSync(fd, 'early crash\n');
    cappedLog(fd, 1000)('later line');
    expect(readFileSync(file, 'utf8')).toBe('early crash\nlater line\n');
  });

  it('refuses a cap too small for its note', () => {
    expect(() => cappedLog(fd, 50)).toThrow(/too small/);
  });
});

describe('isDetachedChild (#273)', () => {
  it('is the background run as tacet run --detach starts it, and nothing a user types', () => {
    expect(isDetachedChild(childArgs('fix it', {}))).toBe(true);
    expect(isDetachedChild(childArgs('--detached-child', { accept: ['x'] }))).toBe(true);
    expect(isDetachedChild(childArgs(undefined, { resume: true }))).toBe(true);
    expect(isDetachedChild(['run', '--', '--detached-child'])).toBe(false);
    expect(isDetachedChild(['run', 'x', '--detached-child'])).toBe(false);
    expect(isDetachedChild(['answer', 'id', '--detached-child'])).toBe(false);
    expect(isDetachedChild(['--detached-child', 'run'])).toBe(false);
  });
});
