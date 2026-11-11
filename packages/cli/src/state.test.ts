import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isGitCheckout, repoRootFrom } from './state.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tacet-state-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A `.git` directory with a HEAD, as `git init` leaves it. */
function gitDir(at: string): string {
  mkdirSync(join(at, '.git'), { recursive: true });
  writeFileSync(join(at, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return at;
}

/**
 * The read-only skeleton the Claude Code sandbox plants at `<dir>/.git` to
 * reserve the path (#326): config, hooks, info and friends, but no HEAD.
 */
function sandboxSkeleton(at: string): string {
  const g = join(at, '.git');
  mkdirSync(join(g, 'info', '.claude-sandbox-noreplace'), { recursive: true });
  mkdirSync(join(g, 'hooks'));
  mkdirSync(join(g, 'remotes'));
  mkdirSync(join(g, 'branches'));
  writeFileSync(join(g, 'config'), '');
  writeFileSync(join(g, 'config.worktree'), '');
  return at;
}

describe('isGitCheckout', () => {
  it('accepts a .git directory with HEAD', () => {
    expect(isGitCheckout(gitDir(join(dir, 'repo')))).toBe(true);
  });

  it('accepts a gitdir file, as linked worktrees and submodules have', () => {
    const wt = join(dir, 'wt');
    mkdirSync(wt);
    writeFileSync(join(wt, '.git'), 'gitdir: /somewhere/.git/worktrees/wt\n');
    expect(isGitCheckout(wt)).toBe(true);
  });

  it('rejects a missing, empty or skeleton .git', () => {
    expect(isGitCheckout(dir)).toBe(false);

    const empty = join(dir, 'empty');
    mkdirSync(join(empty, '.git'), { recursive: true });
    expect(isGitCheckout(empty)).toBe(false);

    expect(isGitCheckout(sandboxSkeleton(join(dir, 'skel')))).toBe(false);
  });

  it('rejects a .git file that is not a gitdir pointer, and a HEAD that is not a file', () => {
    const junk = join(dir, 'junk');
    mkdirSync(junk);
    writeFileSync(join(junk, '.git'), 'not a pointer\n');
    expect(isGitCheckout(junk)).toBe(false);

    const blank = join(dir, 'blank');
    mkdirSync(blank);
    writeFileSync(join(blank, '.git'), '');
    expect(isGitCheckout(blank)).toBe(false);

    const headDir = join(dir, 'head-dir');
    mkdirSync(join(headDir, '.git', 'HEAD'), { recursive: true });
    expect(isGitCheckout(headDir)).toBe(false);
  });

  it('does not follow a symbolic link at .git', () => {
    const real = gitDir(join(dir, 'real'));
    const link = join(dir, 'link');
    mkdirSync(link);
    symlinkSync(join(real, '.git'), join(link, '.git'));
    expect(isGitCheckout(link)).toBe(false);
  });
});

describe('repoRootFrom', () => {
  it('finds the nearest real checkout, walking past a planted skeleton', () => {
    const outer = sandboxSkeleton(join(dir, 'outer'));
    const repo = gitDir(join(outer, 'repo'));
    const deep = join(repo, 'src', 'deep');
    mkdirSync(deep, { recursive: true });
    expect(repoRootFrom(deep)).toBe(repo);
    expect(repoRootFrom(repo)).toBe(repo);
  });

  it('never stops at a skeleton above a plain directory', () => {
    const outer = sandboxSkeleton(join(dir, 'outer'));
    const plain = join(outer, 'plain');
    mkdirSync(plain);
    const root = repoRootFrom(plain);
    expect(root).not.toBe(outer);
    // The start directory comes back, unless a real checkout sits above the temp dir.
    expect(root === plain || isGitCheckout(root)).toBe(true);
  });

  it('walks past a skeleton to the real checkout above it', () => {
    const outer = gitDir(join(dir, 'outer'));
    const inner = sandboxSkeleton(join(outer, 'inner'));
    expect(repoRootFrom(inner)).toBe(outer);
  });
});
