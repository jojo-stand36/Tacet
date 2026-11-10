import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { combineCommits, MergeConflictError, setTaskBranch } from './merge.js';

describe('combineCommits / setTaskBranch', () => {
  let root: string;
  let repo: string;
  let env: Record<string, string>;
  const git = (args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' }).trim();
  const o = () => ({ repoRoot: repo, env });

  /** A commit on top of `from` that writes `files`, without moving any branch. */
  const commitOn = (from: string, files: Record<string, string>): string => {
    git(['checkout', '-q', '--detach', from]);
    for (const [f, text] of Object.entries(files)) writeFileSync(join(repo, f), text);
    git(['add', ...Object.keys(files)]);
    git(['commit', '-qm', Object.keys(files).join(' ')]);
    const c = git(['rev-parse', 'HEAD']);
    git(['checkout', '-q', 'main']);
    return c;
  };

  let main: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tacet-merge-')));
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
    git(['init', '-q', '-b', 'main']);
    writeFileSync(join(repo, 'README'), 'hi\n');
    git(['add', 'README']);
    git(['commit', '-qm', 'init']);
    main = git(['rev-parse', 'HEAD']);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('gives nothing for no commits and the commit itself for one', async () => {
    expect(await combineCommits([], o())).toBeUndefined();
    const a = commitOn(main, { 'a.txt': 'a\n' });
    expect(await combineCommits([a, a], o())).toBe(a);
  });

  it('drops a commit another one already contains', async () => {
    const a = commitOn(main, { 'a.txt': 'a\n' });
    const b = commitOn(a, { 'b.txt': 'b\n' });
    expect(await combineCommits([a, b], o())).toBe(b);
    expect(await combineCommits([b, a], o())).toBe(b);
  });

  it('merges commits that touch different files, without a checkout', async () => {
    const a = commitOn(main, { 'a.txt': 'a\n' });
    const b = commitOn(main, { 'b.txt': 'b\n' });
    const c = commitOn(main, { 'c.txt': 'c\n' });
    const status = git(['status', '--porcelain']);
    const merged = (await combineCommits([a, b, c], o())) as string;
    expect(merged).toMatch(/^[0-9a-f]{40}$/);
    expect(git(['show', `${merged}:a.txt`])).toBe('a');
    expect(git(['show', `${merged}:b.txt`])).toBe('b');
    expect(git(['show', `${merged}:c.txt`])).toBe('c');
    for (const x of [a, b, c]) git(['merge-base', '--is-ancestor', x, merged]);
    expect(git(['log', '-1', '--format=%an <%ae>', merged])).toBe(
      'Tacet Mini-conductor <mini-conductor@tacet.invalid>',
    );
    // The main checkout and its branch are untouched.
    expect(git(['rev-parse', 'main'])).toBe(main);
    expect(git(['status', '--porcelain'])).toBe(status);
  });

  it('names the conflicting files', async () => {
    const a = commitOn(main, { 'x.txt': 'from a\n', 'a.txt': 'a\n' });
    const b = commitOn(main, { 'x.txt': 'from b\n', 'b.txt': 'b\n' });
    const err = await combineCommits([a, b], o()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MergeConflictError);
    expect((err as MergeConflictError).files).toEqual(['x.txt']);
  });

  it('refuses anything but full commit ids, and commits it does not have', async () => {
    await expect(combineCommits(['main'], o())).rejects.toThrow(/not a commit id/);
    await expect(combineCommits(['--output=/tmp/x'], o())).rejects.toThrow(/not a commit id/);
    await expect(combineCommits(['0'.repeat(40), main], o())).rejects.toThrow();
    const tree = git(['rev-parse', 'HEAD^{tree}']);
    await expect(combineCommits([tree, main], o())).rejects.toThrow();
  });

  it('writes only task branches, as a compare-and-swap', async () => {
    const a = commitOn(main, { 'a.txt': 'a\n' });
    await expect(setTaskBranch('refs/heads/main', a, o())).rejects.toThrow(/only branches/);
    expect(await setTaskBranch('refs/heads/tacet/t1/result', a, o())).toBe(true);
    expect(git(['rev-parse', 'refs/heads/tacet/t1/result'])).toBe(a);
    expect(await setTaskBranch('refs/heads/tacet/t1/result', a, o())).toBe(false);
    const b = commitOn(a, { 'b.txt': 'b\n' });
    expect(await setTaskBranch('refs/heads/tacet/t1/result', b, o())).toBe(true);
    expect(git(['rev-parse', 'refs/heads/tacet/t1/result'])).toBe(b);
  });
});
