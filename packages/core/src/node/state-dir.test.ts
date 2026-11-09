import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultStateDir, repoStateDir } from './state-dir.js';

describe('repoStateDir', () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'tacet-state-dir-')));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('keys a repo by its canonical path, however it is spelled', () => {
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    symlinkSync(repo, join(dir, 'link'));
    const state = join(dir, 'state');
    const key = repoStateDir(repo, state);
    expect(repoStateDir(join(dir, 'link'), state)).toBe(key);
    expect(repoStateDir(`${repo}/`, state)).toBe(key);
    expect(key).toMatch(new RegExp(`^${state}/[0-9a-f]{16}$`));
    // A path that does not exist yet is keyed as written.
    expect(repoStateDir(join(dir, 'missing'), state)).not.toBe(key);
  });

  it('defaults under ~/.tacet/state', () => {
    expect(defaultStateDir('/home/u')).toBe(join('/home/u', '.tacet', 'state'));
  });
});
