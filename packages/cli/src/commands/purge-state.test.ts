import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workerGitEnv, workerWorktree } from '@tacet/core/node';
import { WorktreeManager } from '@tacet/mini';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Io } from '../io.js';
import { main } from '../main.js';
import { statePaths } from '../state.js';
import { applyState, planState } from './purge-state.js';

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
  const root = () => repo;
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

  /** Every path under `root` with its size and mode, to show a preview writes nothing. */
  const tree = (root: string): Record<string, string> => {
    const out: Record<string, string> = {};
    const walk = (at: string, rel: string) => {
      for (const e of readdirSync(at, { withFileTypes: true })) {
        const r = `${rel}/${e.name}`;
        const st = statSync(join(at, e.name));
        out[r] = `${st.size} ${st.mode} ${st.mtimeMs}`;
        if (e.isDirectory()) walk(join(at, e.name), r);
      }
    };
    walk(root, '');
    return out;
  };

  it('previews without writing anything, with --force too, even with stale lock markers', async () => {
    await manager().create('clean');
    const dirty = await checkoutWithWork();
    const locks = join(paths().worktrees, '.tacet-locks');
    mkdirSync(locks, { recursive: true });
    writeFileSync(join(locks, `${dirty.id}.busy.999999999.stale`), '');
    const before = tree(paths().dir);
    for (const argv of [
      ['uninstall', '--purge'],
      ['uninstall', '--purge', '--force'],
      ['uninstall', '--purge', '--json'],
    ]) {
      expect((await tacet(argv)).code).toBe(0);
    }
    expect(tree(paths().dir)).toEqual(before);
    const r = await tacet(['uninstall', '--purge']);
    expect(r.out).toMatch(/would remove run state .*: events\.db, worktrees/);
  });

  it('refuses when a run takes the lock between the preview and the removal', async () => {
    const clean = await manager().create('clean');
    const io = { out: () => {}, err: () => {}, cwd: repo, home, env };
    const userDir = join(home, '.tacet');
    await planState(io, root(), userDir);
    // A run starts now: a live process holds the lock.
    const run = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
    try {
      writeFileSync(paths().lock, `${run.pid}\n`);
      await expect(applyState(io, root(), userDir, true)).rejects.toThrow(
        `a tacet run is live for this repo (process ${run.pid})`,
      );
      expect(readFileSync(paths().lock, 'utf8')).toBe(`${run.pid}\n`);
      expect(existsSync(clean.path)).toBe(true);
    } finally {
      run.kill();
    }
  });

  it('keeps everything when git still lists a worktree it does not manage in the state dir', async () => {
    const stray = join(paths().dir, 'stray');
    git(repo, ['worktree', 'add', '-q', '--detach', stray]);
    const r = await tacet(['uninstall', '--purge', '--apply']);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`git still lists the worktree ${stray}`);
    expect(existsSync(paths().events)).toBe(true);
    expect(existsSync(join(repo, '.tacet', 'tacet.yaml'))).toBe(true);
    expect(existsSync(paths().lock)).toBe(false);
  });

  it('reports --apply as JSON in one shape, refused or not', async () => {
    const dirty = await checkoutWithWork();
    const refused = await tacet(['uninstall', '--purge', '--apply', '--json']);
    expect(refused.code).toBe(1);
    const a = JSON.parse(refused.out);
    expect(a).toMatchObject({ applied: false, refused: true, removals: [] });
    expect(a.state.result.refused).toEqual([
      expect.objectContaining({ id: dirty.id, forceable: true }),
    ]);
    const done = await tacet(['uninstall', '--purge', '--apply', '--force', '--json']);
    expect(done.code).toBe(0);
    const b = JSON.parse(done.out);
    expect(b).toMatchObject({ applied: true });
    expect(b.state.result).toMatchObject({ dirRemoved: true, refused: [] });
    expect(b.removals).toEqual([join(repo, '.tacet')]);
  });

  it('keeps a checkout’s own tacet branch even when forced', async () => {
    const dirty = await checkoutWithWork();
    // Its own branch, holding a commit no other branch has, as a squash staging result would.
    const own = `refs/heads/${dirty.branchName}`;
    git(repo, ['checkout', '-q', '-b', 'scratch']);
    writeFileSync(join(repo, 'only-here.txt'), 'x\n');
    git(repo, ['add', 'only-here.txt']);
    git(repo, ['commit', '-qm', 'only on the own branch']);
    const tip = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['update-ref', own, tip]);
    git(repo, ['checkout', '-q', 'main']);
    git(repo, ['branch', '-q', '-D', 'scratch']);
    expect((await tacet(['uninstall', '--purge', '--apply', '--force'])).code).toBe(0);
    expect(git(repo, ['rev-parse', own])).toBe(tip);
  });

  it('refuses to remove run state when the config cannot be read', async () => {
    await manager().create('clean');
    const p = paths();
    writeFileSync(join(repo, '.tacet', 'tacet.yaml'), 'tiers: [not, a, map\n');
    const preview = await tacet(['uninstall', '--purge']);
    expect(preview.err).toContain('the config could not be read');
    const r = await tacet(['uninstall', '--purge', '--apply']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('fix .tacet/tacet.yaml first');
    expect(existsSync(p.events)).toBe(true);
    expect(existsSync(join(repo, '.tacet'))).toBe(true);
  });
});
