import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultStateDir, repoStateDir, resolveStateDir } from './state-dir.js';

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

describe('resolveStateDir (#21)', () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'tacet-state-dir-')));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('defaults, expands ~ and keeps an absolute path', () => {
    expect(resolveStateDir(undefined, undefined, '/home/u')).toBe(defaultStateDir('/home/u'));
    expect(resolveStateDir('~', undefined, '/home/u')).toBe('/home/u');
    expect(resolveStateDir('~/x/y', undefined, '/home/u')).toBe('/home/u/x/y');
    expect(resolveStateDir('/var/tacet/', undefined, '/home/u')).toBe('/var/tacet');
  });

  it('refuses a relative path and one inside the repo, however it is spelled', () => {
    expect(() => resolveStateDir('state', undefined, '/home/u')).toThrow(/absolute/);
    expect(() => resolveStateDir('~user/x', undefined, '/home/u')).toThrow(/absolute/);
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    symlinkSync(repo, join(dir, 'link'));
    expect(() => resolveStateDir(join(repo, '.tacet-state'), repo)).toThrow(/inside the repo/);
    expect(() => resolveStateDir(repo, repo)).toThrow(/inside the repo/);
    // Through a symlink, and for a directory not created yet.
    expect(() => resolveStateDir(join(dir, 'link', 'a', 'b'), repo)).toThrow(/inside the repo/);
    expect(resolveStateDir(join(dir, 'state'), repo)).toBe(join(dir, 'state'));
    expect(resolveStateDir(join(dir, 'repo-state'), repo)).toBe(join(dir, 'repo-state'));
  });
});
