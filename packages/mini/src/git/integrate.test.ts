import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workerGitEnv, workerWorktree } from '@tacet/core/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { integrateWorktree, taskBranch, WorktreeRefusedError } from './integrate.js';

/**
 * Integration of Worker commits (#119) against real git: a Worker in a linked worktree commits on
 * a detached HEAD into its own object store (#116); the Mini-conductor brings the commit into the
 * repo from outside the sandbox.
 */
describe('integrateWorktree', () => {
  let root: string;
  let repo: string;
  let env: Record<string, string>;

  const git = (cwd: string, args: string[], extra: Record<string, string> = {}) =>
    execFileSync('git', ['-C', cwd, ...args], {
      env: { ...env, ...extra },
      encoding: 'utf8',
    }).trim();

  /** A Worker checkout as the adapter leaves it: detached, with its own object store. */
  const worker = (name: string) => {
    const dir = join(root, 'worktrees', name);
    git(repo, ['worktree', 'add', '-q', '--detach', dir, 'main']);
    const wt = workerWorktree(dir, repo);
    if (!wt) throw new Error('not a worktree');
    mkdirSync(join(wt.gitDir, 'objects'), { recursive: true });
    return { dir, wt, wenv: workerGitEnv(wt) };
  };
  const commitIn = (w: ReturnType<typeof worker>, file: string, text: string) => {
    writeFileSync(join(w.dir, file), text);
    git(w.dir, ['add', file], w.wenv);
    git(w.dir, ['commit', '-qm', `add ${file}`], w.wenv);
    return git(w.dir, ['rev-parse', 'HEAD'], w.wenv);
  };
  const hasObject = (sha: string) => {
    try {
      git(repo, ['cat-file', '-e', `${sha}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tacet-integrate-')));
    repo = join(root, 'repo');
    mkdirSync(join(root, 'home'));
    env = {
      PATH: process.env.PATH ?? '',
      HOME: join(root, 'home'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Tacet Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Tacet Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    };
    mkdirSync(repo);
    git(repo, ['init', '-q', '-b', 'main']);
    writeFileSync(join(repo, 'README'), 'hi\n');
    git(repo, ['add', 'README']);
    git(repo, ['commit', '-qm', 'init']);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('brings a Worker commit into the repo under its task branch, and gc works again', () => {
    const w = worker('t1');
    const sha = commitIn(w, 'a.txt', 'a\n');
    expect(hasObject(sha)).toBe(false);
    // Before integration the repo's own gc trips over the Worker's HEAD.
    expect(() => git(repo, ['gc', '-q'])).toThrow();

    const ref = taskBranch('01JTASK/1');
    expect(ref).toBe('refs/heads/tacet/01JTASK/1');
    expect(integrateWorktree({ cwd: w.dir, repoRoot: repo, ref, env })).toEqual({
      commit: sha,
      ref,
    });
    expect(git(repo, ['rev-parse', ref])).toBe(sha);
    expect(hasObject(sha)).toBe(true);
    git(repo, ['gc', '-q']);
    git(repo, ['fsck', '--no-progress']);
    // Again with nothing new: idempotent.
    expect(integrateWorktree({ cwd: w.dir, repoRoot: repo, ref, env })).toEqual({
      commit: sha,
      ref,
    });
  });

  it.each([
    ['first', 'second'],
    ['second', 'first'],
  ])('integrates two Workers with unintegrated commits in either order (%s first)', (a, b) => {
    const ws = { first: worker('w1'), second: worker('w2') };
    const shas = {
      first: commitIn(ws.first, 'one.txt', '1\n'),
      second: commitIn(ws.second, 'two.txt', '2\n'),
    };
    for (const k of [a, b] as const) {
      const ref = taskBranch(`task-${k}`);
      integrateWorktree({ cwd: ws[k as 'first'].dir, repoRoot: repo, ref, env });
      expect(git(repo, ['rev-parse', ref])).toBe(shas[k as 'first']);
    }
    git(repo, ['gc', '-q']);
  });

  it('integrates a Worker on a branch HEAD (no sandbox), whose commits are already shared', () => {
    const dir = join(root, 'worktrees', 'claude');
    git(repo, ['worktree', 'add', '-q', dir, '-b', 'feature']);
    writeFileSync(join(dir, 'c.txt'), 'c\n');
    git(dir, ['add', 'c.txt']);
    git(dir, ['commit', '-qm', 'c']);
    const sha = git(dir, ['rev-parse', 'HEAD']);
    const ref = taskBranch('t-claude');
    expect(integrateWorktree({ cwd: dir, repoRoot: repo, ref, env })?.commit).toBe(sha);
  });

  it('refuses a worktree whose pointers were forged, without running git or a hook in it', () => {
    const w = worker('evil');
    commitIn(w, 'e.txt', 'e\n');
    const evil = join(w.dir, 'evil');
    const marker = join(root, 'hook-ran');
    mkdirSync(join(evil, 'hooks'), { recursive: true });
    writeFileSync(join(evil, 'config'), `[core]\n\thooksPath = ${join(evil, 'hooks')}\n`);
    writeFileSync(join(evil, 'hooks', 'reference-transaction'), `#!/bin/sh\ntouch ${marker}\n`, {
      mode: 0o755,
    });
    writeFileSync(join(w.wt.gitDir, 'commondir'), evil);
    expect(() =>
      integrateWorktree({ cwd: w.dir, repoRoot: repo, ref: taskBranch('evil'), env }),
    ).toThrow(WorktreeRefusedError);
    expect(existsSync(marker)).toBe(false);
    expect(() => git(repo, ['rev-parse', '--verify', '-q', taskBranch('evil')])).toThrow();
  });

  it('refuses a HEAD that is neither a commit id nor a branch', () => {
    const w = worker('weird');
    writeFileSync(join(w.wt.gitDir, 'HEAD'), 'ref: refs/remotes/origin/main\n');
    expect(() =>
      integrateWorktree({ cwd: w.dir, repoRoot: repo, ref: taskBranch('weird'), env }),
    ).toThrow(WorktreeRefusedError);
  });

  it('rejects forged objects: nothing lands in the shared store and no branch moves', () => {
    const w = worker('forged');
    // A commit object whose tree does not exist anywhere, written into the Worker's own store.
    const bogusTree = 'a'.repeat(40);
    const body = `tree ${bogusTree}\nauthor x <x@x> 0 +0000\ncommitter x <x@x> 0 +0000\n\nforged\n`;
    const forged = execFileSync(
      'git',
      ['-C', w.dir, 'hash-object', '-t', 'commit', '-w', '--literally', '--stdin'],
      { env: { ...env, ...w.wenv }, input: body, encoding: 'utf8' },
    ).trim();
    writeFileSync(join(w.wt.gitDir, 'HEAD'), `${forged}\n`);
    const ref = taskBranch('forged');
    expect(() => integrateWorktree({ cwd: w.dir, repoRoot: repo, ref, env })).toThrow();
    expect(hasObject(forged)).toBe(false);
    expect(() => git(repo, ['rev-parse', '--verify', '-q', ref])).toThrow();
  });
});
