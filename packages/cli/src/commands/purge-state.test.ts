import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workerGitEnv, workerWorktree } from '@tacet/core/node';
import { WorktreeManager } from '@tacet/mini';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Io } from '../io.js';
import { main } from '../main.js';
import { statePaths } from '../state.js';

/** `tacet uninstall --purge` and the repo's run state (#211). */
describe('tacet uninstall --purge: run state (#211)', () => {
  let dir: string;
  let repo: string;
  let home: string;
  let env: Record<string, string>;

  const git = (cwd: string, args: string[], extra: Record<string, string> = {}) =>
    execFileSync('git', ['-C', cwd, ...args], {
      env: { ...env, ...extra },
      encoding: 'utf8',
    }).trim();
  const tacet = async (argv: string[], extra: Partial<Io> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(argv, {
      out: (t) => out.push(t),
      err: (t) => err.push(t),
      cwd: repo,
      home,
      env,
      ...extra,
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  const paths = () => statePaths(repo, join(home, '.tacet'), home);
  const manager = () => new WorktreeManager(repo, paths().worktrees, { env });

  /** A Worker checkout with a commit only its own store has: unintegrated work. */
  async function checkoutWithWork() {
    const w = await manager().create('worker');
    const wt = workerWorktree(w.path, repo);
    if (!wt) throw new Error('not a worktree');
    writeFileSync(join(w.path, 'work.txt'), 'work\n');
    git(w.path, ['add', 'work.txt'], workerGitEnv(wt));
    git(w.path, ['commit', '-qm', 'work'], workerGitEnv(wt));
    return w;
  }
  const tacetCheckouts = () =>
    git(repo, ['worktree', 'list', '--porcelain'])
      .split('\n')
      .filter((l) => l.startsWith('worktree ') && l.includes(paths().dir));

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tacet-purge-'));
    repo = join(dir, 'repo');
    home = join(dir, 'home');
    mkdirSync(repo);
    mkdirSync(home);
    env = {
      PATH: process.env.PATH ?? '',
      HOME: home,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Tacet Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Tacet Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    };
    git(repo, ['init', '-q', '-b', 'main']);
    writeFileSync(join(repo, 'README'), 'hi\n');
    git(repo, ['add', 'README']);
    git(repo, ['commit', '-qm', 'init']);
    expect((await tacet(['init', '--model', 'm'])).code).toBe(0);
    mkdirSync(paths().dir, { recursive: true });
    writeFileSync(paths().events, 'not really a database');
    git(repo, ['branch', 'tacet/some-task/result']);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('previews the state dir and each checkout, marking unintegrated work, and changes nothing', async () => {
    const clean = await manager().create('clean');
    const dirty = await checkoutWithWork();
    const r = await tacet(['uninstall', '--purge']);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`would remove checkout ${clean.path}`);
    expect(r.out).toContain(
      `would keep checkout ${dirty.path}: Worker has unintegrated private commits`,
    );
    expect(r.out).toContain(`would remove run state ${paths().dir} (with the event log)`);
    expect(r.err).toContain('tacet/* branches are kept');
    expect(existsSync(clean.path)).toBe(true);
    expect(existsSync(paths().events)).toBe(true);
    expect(existsSync(join(repo, '.tacet'))).toBe(true);

    const json = JSON.parse((await tacet(['uninstall', '--purge', '--json'])).out);
    expect(json.state.checkouts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: clean.id, missing: false }),
        expect.objectContaining({ id: dirty.id, kept: expect.stringContaining('unintegrated') }),
      ]),
    );
    expect(
      json.state.checkouts.find((c: { id: string }) => c.id === clean.id).kept,
    ).toBeUndefined();
  });

  it('refuses a checkout with unintegrated work, names it and removes nothing else', async () => {
    const clean = await manager().create('clean');
    const dirty = await checkoutWithWork();
    const r = await tacet(['uninstall', '--purge', '--apply']);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`kept checkout ${dirty.path}`);
    expect(r.err).toContain('--force');
    expect(existsSync(join(dirty.path, 'work.txt'))).toBe(true);
    expect(existsSync(paths().events)).toBe(true);
    expect(existsSync(join(repo, '.tacet', 'tacet.yaml'))).toBe(true);
    // The clean one may go; the lock is released.
    expect(existsSync(clean.path)).toBe(false);
    expect(existsSync(paths().lock)).toBe(false);
  });

  it('with --force removes every checkout, the state dir and .tacet/, and keeps tacet/* branches', async () => {
    await manager().create('clean');
    const dirty = await checkoutWithWork();
    const handDeleted = await manager().create('deleted-by-hand');
    rmSync(handDeleted.path, { recursive: true, force: true });

    const r = await tacet(['uninstall', '--purge', '--apply', '--force']);

    expect(r.code).toBe(0);
    expect(tacetCheckouts()).toEqual([]);
    expect(existsSync(dirty.path)).toBe(false);
    expect(existsSync(paths().dir)).toBe(false);
    expect(existsSync(join(repo, '.tacet'))).toBe(false);
    expect(git(repo, ['for-each-ref', '--format=%(refname)', 'refs/heads/tacet/'])).toBe(
      'refs/heads/tacet/some-task/result',
    );
  });

  it('removes the run state when nothing holds unintegrated work, without --force', async () => {
    await manager().create('clean');
    expect((await tacet(['uninstall', '--purge', '--apply'])).code).toBe(0);
    expect(existsSync(paths().dir)).toBe(false);
    expect(tacetCheckouts()).toEqual([]);
  });

  it('never prunes the user’s own worktrees whose paths are missing', async () => {
    const mine = join(dir, 'my-worktree');
    git(repo, ['worktree', 'add', '-q', '--detach', mine]);
    rmSync(mine, { recursive: true, force: true });
    expect((await tacet(['uninstall', '--purge', '--apply'])).code).toBe(0);
    expect(git(repo, ['worktree', 'list', '--porcelain'])).toContain(`worktree ${mine}`);
  });

  it('refuses while a tacet run holds the lock, and changes nothing', async () => {
    const clean = await manager().create('clean');
    writeFileSync(paths().lock, `${process.pid}\n`);
    for (const argv of [
      ['uninstall', '--purge'],
      ['uninstall', '--purge', '--apply'],
    ]) {
      const r = await tacet(argv);
      expect(r.code).toBe(1);
      expect(r.err).toContain('a tacet run is live for this repo');
    }
    expect(existsSync(clean.path)).toBe(true);
    expect(readFileSync(paths().lock, 'utf8')).toBe(`${process.pid}\n`);
    expect(existsSync(join(repo, '.tacet'))).toBe(true);
  });

  it('takes over a lock left by a run that is gone', async () => {
    writeFileSync(paths().lock, '999999999\n');
    expect((await tacet(['uninstall', '--purge', '--apply'])).code).toBe(0);
    expect(existsSync(paths().dir)).toBe(false);
  });

  it('refuses --force without --purge', async () => {
    expect((await tacet(['uninstall', '--force'])).code).toBe(2);
  });
});
