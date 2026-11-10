import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workerWorktree } from '@tacet/core/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CheckoutPlanner } from '../standalone.js';
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

  it('refuses a base that is not a commit, and a Worker id it cannot name', async () => {
    const w = make();
    await expect(w.create('s1', '--upload-pack=touch /tmp/x')).rejects.toThrow(/rev-parse/);
    await expect(w.create('s2', 'nope')).rejects.toThrow(/rev-parse/);
    await expect(w.create('..')).rejects.toThrow(/cannot make a checkout/);
  });

  it('prunes a checkout deleted by hand', async () => {
    const w = make();
    const a = await w.create('s1');
    rmSync(a.path, { recursive: true, force: true });
    await w.remove(a.id);
    expect(git(repo, ['worktree', 'list'])).not.toContain('ws-s1');
  });

  it('plans in a throwaway checkout, never in the repo (#21 review)', async () => {
    let seen: string | undefined;
    const planner = new CheckoutPlanner(make(), (cwd) => ({
      plan: async () => {
        seen = cwd;
        // A planner whose adapter writes without asking (Codex's sandbox).
        writeFileSync(join(cwd, 'README'), 'changed by the planner\n');
        return { subtasks: [] };
      },
    }));
    const task = {
      id: 't1',
      goal: 'g',
      acceptanceCriteria: [],
      priority: 'p2' as const,
      createdAt: '',
    };
    await planner.plan(task);
    expect(seen).toBeDefined();
    expect(seen?.startsWith(join(root, 'state', 'worktrees'))).toBe(true);
    expect(existsSync(seen as string)).toBe(false);
    expect(git(repo, ['status', '--porcelain'])).toBe('');
    expect(git(repo, ['worktree', 'list'])).not.toContain('plan-t1');
  });

  it('creates many at once without colliding on the repo lock', async () => {
    const w = make();
    const all = await Promise.all(Array.from({ length: 10 }, (_, i) => w.create(`s${i}`)));
    expect(new Set(all.map((x) => x.path)).size).toBe(10);
    for (const x of all) expect(existsSync(join(x.path, 'README'))).toBe(true);
  });
});
