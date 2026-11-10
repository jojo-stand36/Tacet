import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type EventStore, openEventStore, workerWorktree } from '@tacet/core/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CheckoutPlanner } from './standalone.js';
import { WorktreeManager } from './worktree.js';

/** The manager as standalone mode (#21) uses it, behind the `Workspaces` port. */
describe('WorktreeManager as standalone Workspaces', () => {
  let root: string;
  let repo: string;
  let env: Record<string, string>;
  const git = (cwd: string, args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' }).trim();
  let store: EventStore;
  /** A new manager on the same event log each time: the registry lives in the log (#126). */
  const make = () =>
    new WorktreeManager(repo, join(root, 'state', 'worktrees'), {
      log: { store, miniId: 'test' },
    });

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tacet-workspaces-')));
    repo = join(root, 'repo');
    mkdirSync(join(root, 'home'));
    env = {
      PATH: process.env.PATH ?? '',
      HOME: join(root, 'home'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Tacet Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Tacet Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    };
    store = openEventStore(':memory:');
    mkdirSync(repo);
    git(repo, ['init', '-q', '-b', 'main']);
    writeFileSync(join(repo, 'README'), 'one\n');
    git(repo, ['add', 'README']);
    git(repo, ['commit', '-qm', 'one']);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('creates a detached checkout at HEAD or at a base commit, with its own objects', async () => {
    const first = git(repo, ['rev-parse', 'HEAD']);
    writeFileSync(join(repo, 'README'), 'two\n');
    git(repo, ['commit', '-qam', 'two']);
    const head = git(repo, ['rev-parse', 'HEAD']);
    const w = make();

    const a = await w.create('s1');
    expect(a.path.startsWith(join(root, 'state', 'worktrees'))).toBe(true);
    expect(git(a.path, ['rev-parse', 'HEAD'])).toBe(head);
    expect(() => git(a.path, ['symbolic-ref', '-q', 'HEAD'])).toThrow();
    const wt = workerWorktree(a.path, repo);
    expect(wt && existsSync(join(wt.gitDir, 'objects'))).toBe(true);

    const b = await w.create('s2', first);
    expect(git(b.path, ['rev-parse', 'HEAD'])).toBe(first);
  });

  it('starts at the HEAD commit when the repository HEAD is detached', async () => {
    git(repo, ['checkout', '-q', '--detach']);
    const head = git(repo, ['rev-parse', 'HEAD']);

    const a = await make().create('s1');

    expect(git(a.path, ['rev-parse', 'HEAD'])).toBe(head);
    expect(a.baseCommit).toBe(head);
  });

  it('finds a checkout again from a new instance', async () => {
    const a = await make().create('s1');
    expect(await make().get(a.id)).toMatchObject({ id: a.id, path: a.path });
    await make().remove(a.id);
    expect(await make().get(a.id)).toBeUndefined();
    expect(git(repo, ['worktree', 'list'])).not.toContain(a.id);
  });

  it('refuses a base that is not a commit or could be read as an option', async () => {
    const w = make();
    await expect(w.create('s1', '--upload-pack=touch /tmp/x')).rejects.toThrow();
    await expect(w.create('s2', 'nope')).rejects.toThrow();
    expect(await w.list()).toEqual([]);
  });

  it('prunes a checkout deleted by hand', async () => {
    const w = make();
    const a = await w.create('s1');
    rmSync(a.path, { recursive: true, force: true });
    await w.remove(a.id);
    expect(git(repo, ['worktree', 'list'])).not.toContain(a.id);
  });

  it('plans in a throwaway checkout, never in the repo, and removes it (#21 review)', async () => {
    let seen: string | undefined;
    const workspaces = make();
    const planner = new CheckoutPlanner(workspaces, (cwd) => ({
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
    expect(seen?.startsWith(join(root, 'state', 'worktrees'))).toBe(true);
    expect(existsSync(seen as string)).toBe(false);
    expect(await workspaces.list()).toEqual([]);
    expect(git(repo, ['status', '--porcelain'])).toBe('');
  });

  it('creates many at once without colliding on the repo lock', async () => {
    const w = make();
    const all = await Promise.all(Array.from({ length: 10 }, (_, i) => w.create(`s${i}`)));
    expect(new Set(all.map((x) => x.path)).size).toBe(10);
    for (const x of all) expect(existsSync(join(x.path, 'README'))).toBe(true);
  });
});
