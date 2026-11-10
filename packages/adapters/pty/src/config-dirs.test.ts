import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeClaudeConfigDir, sweepClaudeConfigDirs } from './config-dirs.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const DAY = 24 * 60 * 60 * 1000;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tacet-claude-pty-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A session directory whose every entry was last written `daysAgo` days ago. */
function session(id: string, daysAgo: number, fresh?: string): string {
  const dir = join(root, id);
  mkdirSync(join(dir, 'projects'), { recursive: true });
  writeFileSync(join(dir, '.claude.json'), '{}');
  writeFileSync(join(dir, 'projects', 't.jsonl'), '{}');
  const t = (Date.now() - daysAgo * DAY) / 1000;
  for (const p of [
    join(dir, 'projects', 't.jsonl'),
    join(dir, '.claude.json'),
    join(dir, 'projects'),
    dir,
  ]) {
    utimesSync(p, t, t);
  }
  if (fresh) writeFileSync(join(dir, 'projects', fresh), '{}');
  return dir;
}

describe('Claude config directories (#153)', () => {
  it('removes one session directory, named by its UUID only', () => {
    const dir = session(A, 0);
    expect(removeClaudeConfigDir(root, A)).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(removeClaudeConfigDir(root, A)).toBe(false);
    expect(() => removeClaudeConfigDir(root, '../x')).toThrow(/UUID/);
  });

  it('never follows a symlink out of the root', () => {
    const outside = mkdtempSync(join(tmpdir(), 'tacet-outside-'));
    try {
      writeFileSync(join(outside, 'keep'), 'x');
      symlinkSync(outside, join(root, B));
      expect(removeClaudeConfigDir(root, B)).toBe(false);
      expect(sweepClaudeConfigDirs(root, 0, new Set(), Date.now() + DAY)).toBe(0);
      expect(existsSync(join(outside, 'keep'))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('sweeps directories nothing wrote to within the retention, except open sessions', () => {
    const old = session(A, 40);
    const open = session(B, 40);
    // An old directory with a transcript written today is in use.
    const active = session(C, 40, 'today.jsonl');
    mkdirSync(join(root, 'not-a-session'));
    expect(sweepClaudeConfigDirs(root, 30 * DAY, new Set([B]))).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(open)).toBe(true);
    expect(existsSync(active)).toBe(true);
    expect(existsSync(join(root, 'not-a-session'))).toBe(true);
    expect(sweepClaudeConfigDirs(join(root, 'missing'), 0, new Set())).toBe(0);
  });
});
