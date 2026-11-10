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
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_APPEND,
      0o600,
    );
  });
  afterEach(() => {
    closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the log under the cap, holding the newest lines', () => {
    const log = cappedLog(fd, 1000);
    for (let i = 0; i < 500; i++) log(`line ${i} ${'x'.repeat(20)}`);
    const text = readFileSync(file, 'utf8');
    expect(statSync(file).size).toBeLessThanOrEqual(1000);
    expect(text).toContain('[earlier lines dropped: this log keeps the last 1000 bytes]');
    expect(text).toContain('line 499 ');
    expect(text).not.toContain('line 0 ');
    // Whole lines, in order, after the note.
    const lines = text.trimEnd().split('\n').slice(1);
    const numbers = lines.map((l) => Number(/^line (\d+) /.exec(l)?.[1]));
    expect(numbers.every((n, i) => i === 0 || n === (numbers[i - 1] as number) + 1)).toBe(true);
  });

  it('cuts a single line longer than the cap to fit', () => {
    const log = cappedLog(fd, 200);
    log('short');
    log(`${'y'.repeat(500)} end`);
    expect(statSync(file).size).toBeLessThanOrEqual(200);
    expect(readFileSync(file, 'utf8')).toMatch(/ end\n$/);
  });

  it('leaves what was written around it (a crash before it existed) in the same file', () => {
    writeSync(fd, 'early crash\n');
    const log = cappedLog(fd, 1000);
    log('later line');
    expect(readFileSync(file, 'utf8')).toBe('early crash\nlater line\n');
  });
});
