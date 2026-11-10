import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workerWorktree } from '@tacet/core/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitWorktrees } from './worktrees.js';

describe('GitWorktrees (#21)', () => {
  let root: string;
  let repo: string;
  let env: Record<string, string>;
  const git = (cwd: string, args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' }).trim();
  const make = () =>
    new GitWorktrees({ repoRoot: repo, root: join(root, 'state', 'worktrees'), env });

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tacet-worktrees-')));
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
    writeFileSync(join(repo, 'README'), 'one\n');
    git(repo, ['add', 'README']);
    git(repo, ['commit', '-qm', 'one']);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('creates a detached checkout at HEAD or at a base, outside the repo, with its own objects', async () => {
    const first = git(repo, ['rev-parse', 'HEAD']);
    writeFileSync(join(repo, 'README'), 'two\n');
    git(repo, ['commit', '-qam', 'two']);
    const head = git(repo, ['rev-parse', 'HEAD']);
    const w = make();

    const a = await w.create('sess/1');
    expect(a.id).toBe('ws-sess_1');
    expect(a.path).toBe(join(root, 'state', 'worktrees', 'ws-sess_1'));
    expect(git(a.path, ['rev-parse', 'HEAD'])).toBe(head);
    expect(() => git(a.path, ['symbolic-ref', '-q', 'HEAD'])).toThrow();
    const wt = workerWorktree(a.path, repo);
    expect(wt).toBeDefined();
    expect(existsSync(join(wt?.gitDir as string, 'objects'))).toBe(true);

    const b = await w.create('sess-2', first);
    expect(git(b.path, ['rev-parse', 'HEAD'])).toBe(first);
    await expect(w.create('sess/1')).rejects.toThrow(/already exists/);
  });

  it('finds a checkout again from a new instance, and refuses ids that are not its own', async () => {
    const a = await make().create('s1');
    const again = make();
    expect(await again.get(a.id)).toEqual(a);
    expect(await again.get('ws-missing')).toBeUndefined();
    expect(await again.get('../repo')).toBeUndefined();
    expect(await again.get('ws-..')).toBeUndefined();
    await again.remove(a.id);
    expect(await again.get(a.id)).toBeUndefined();
    expect(git(repo, ['worktree', 'list'])).not.toContain('ws-s1');
  });

  it('creates many at once without colliding on the repo lock', async () => {
    const w = make();
    const all = await Promise.all(Array.from({ length: 10 }, (_, i) => w.create(`s${i}`)));
    expect(new Set(all.map((x) => x.path)).size).toBe(10);
    for (const x of all) expect(existsSync(join(x.path, 'README'))).toBe(true);
  });
});
