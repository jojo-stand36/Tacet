import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectLanded } from './landed.js';

describe('detectLanded (#210)', () => {
  let root: string;
  let repo: string;
  let env: Record<string, string>;
  const git = (args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' }).trim();
  const commitFile = (file: string, text: string) => {
    writeFileSync(join(repo, file), text);
    git(['add', file]);
    git(['commit', '-qm', file]);
    return git(['rev-parse', 'HEAD']);
  };
  /** A task branch with two commits off main; returns its tip. */
  const work = () => {
    git(['checkout', '-qb', 'work']);
    commitFile('a.txt', 'one\n');
    const tip = commitFile('b.txt', 'two\n');
    git(['checkout', '-q', 'main']);
    return tip;
  };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tacet-landed-')));
    repo = join(root, 'repo');
    mkdirSync(repo);
    env = {
      PATH: process.env.PATH ?? '',
      HOME: root,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Tacet Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Tacet Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    };
    git(['init', '-q', '-b', 'main']);
    commitFile('README', 'hi\n');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const detect = (commit: string, maxScan?: number) =>
    detectLanded({
      repoRoot: repo,
      commit,
      target: 'refs/heads/main',
      env,
      ...(maxScan !== undefined ? { maxScan } : {}),
    });

  it('finds a merge', async () => {
    const tip = work();
    git(['merge', '-q', '--no-ff', '-m', 'merge work', 'work']);
    expect(await detect(tip)).toEqual({ how: 'merge' });
  });

  it('finds a squash merge among later commits, and names the target commit', async () => {
    const tip = work();
    commitFile('other.txt', 'other\n');
    git(['merge', '-q', '--squash', 'work']);
    git(['commit', '-qm', 'squashed']);
    const squashed = git(['rev-parse', 'HEAD']);
    commitFile('later.txt', 'later\n');
    expect(await detect(tip)).toEqual({ how: 'squash', landedAs: squashed });
  });

  it('reads work that has not landed, an empty change, or a missing target as not landed', async () => {
    const tip = work();
    commitFile('other.txt', 'other\n');
    expect(await detect(tip)).toBeUndefined();

    // Only half of the work landed.
    git(['cherry-pick', '-n', `${tip}~1`]);
    git(['commit', '-qm', 'half']);
    expect(await detect(tip)).toBeUndefined();

    expect(await detect(git(['rev-parse', 'main~1']))).toEqual({ how: 'merge' });
    git(['checkout', '-qb', 'empty']);
    git(['commit', '-q', '--allow-empty', '-m', 'empty']);
    const empty = git(['rev-parse', 'HEAD']);
    git(['checkout', '-q', 'main']);
    expect(await detect(empty)).toBeUndefined();

    expect(
      await detectLanded({ repoRoot: repo, commit: tip, target: 'refs/heads/gone', env }),
    ).toBeUndefined();
    expect(await detect('f'.repeat(40))).toBeUndefined();
  });

  it('only scans maxScan target commits', async () => {
    const tip = work();
    git(['merge', '-q', '--squash', 'work']);
    git(['commit', '-qm', 'squashed']);
    commitFile('x.txt', 'x\n');
    commitFile('y.txt', 'y\n');
    expect(await detect(tip, 2)).toBeUndefined();
    expect(await detect(tip, 3)).toMatchObject({ how: 'squash' });
  });

  it('refuses arguments that are not a commit id and a branch ref', async () => {
    const tip = work();
    await expect(detect('HEAD')).rejects.toThrow(/commit/);
    await expect(
      detectLanded({ repoRoot: repo, commit: tip, target: '--all', env }),
    ).rejects.toThrow(/branch ref/);
    await expect(
      detectLanded({ repoRoot: repo, commit: tip, target: 'refs/heads/a..b', env }),
    ).rejects.toThrow(/branch ref/);
  });
});
