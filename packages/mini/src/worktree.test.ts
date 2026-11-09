import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorktreeManager } from './worktree.js';

const execFileAsync = promisify(execFile);

async function git(repository: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repository, ...args], { encoding: 'utf8' });
  return stdout;
}

describe('WorktreeManager', () => {
  let temporaryDirectory: string;
  let repository: string;
  let manager: WorktreeManager;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'tacet-worktrees-'));
    repository = path.join(temporaryDirectory, 'repo');
    await mkdir(repository);
    await git(repository, ['init', '-b', 'main']);
    await git(repository, ['config', 'user.name', 'Tacet test']);
    await git(repository, ['config', 'user.email', 'tacet-test@example.invalid']);
    await git(repository, ['config', 'core.excludesfile', '/dev/null']);
    await writeFile(path.join(repository, '.gitignore'), '.env\n');
    await writeFile(path.join(repository, 'file.txt'), 'base\n');
    await git(repository, ['add', '.']);
    await git(repository, ['commit', '-m', 'initial']);
    manager = new WorktreeManager(repository, path.join(temporaryDirectory, 'worktrees'));
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it('creates ten parallel workers with unique branches and paths', async () => {
    const worktrees = await Promise.all(
      Array.from({ length: 10 }, (_, index) => manager.create(`worker-${index}`)),
    );

    expect(new Set(worktrees.map(({ branchName }) => branchName)).size).toBe(10);
    expect(new Set(worktrees.map(({ path: worktreePath }) => worktreePath)).size).toBe(10);
    expect((await manager.list()).length).toBe(10);
    expect(worktrees.every(({ baseBranch }) => baseBranch === 'main')).toBe(true);
  });

  it('rejects a worktree root inside the repository', async () => {
    const unsafeManager = new WorktreeManager(
      repository,
      path.join(repository, 'nested-worktrees'),
    );

    await expect(unsafeManager.create('unsafe-worker')).rejects.toThrow(
      'worktree root must be outside the repository',
    );
  });

  it('handles worker IDs with long hyphen runs', async () => {
    const worktree = await manager.create(`${'-'.repeat(10_000)}worker${'-'.repeat(10_000)}`);

    expect(worktree.branchName).toMatch(/^tacet\/workers\/worker-/);
  });

  it('creates from an explicit base branch and runs an opt-in setup command', async () => {
    await git(repository, ['checkout', '-b', 'setup-base']);
    await writeFile(path.join(repository, 'base-only.txt'), 'from setup base\n');
    await git(repository, ['add', 'base-only.txt']);
    await git(repository, ['commit', '-m', 'base branch']);
    await git(repository, ['checkout', 'main']);
    await writeFile(path.join(repository, '.env'), 'test-value\n');

    const worktree = await manager.create('setup-worker', {
      baseBranch: 'setup-base',
      setup: {
        command: process.execPath,
        args: ['-e', "require('node:fs').writeFileSync('setup.txt', process.cwd())"],
      },
    });

    expect(worktree.baseBranch).toBe('setup-base');
    expect(await readFile(path.join(worktree.path, 'base-only.txt'), 'utf8')).toBe(
      'from setup base\n',
    );
    expect(await readFile(path.join(worktree.path, 'setup.txt'), 'utf8')).toBe(worktree.path);
    await expect(readFile(path.join(worktree.path, '.env'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('removes only stale, clean worktrees and preserves active or ignored content', async () => {
    const stale = await manager.create('stale');
    const dirty = await manager.create('dirty');
    const active = await manager.create('active');
    const now = Date.now();
    await Promise.all([stale, dirty, active].map(({ id }) => manager.touch(id, now - 10_000)));
    await writeFile(path.join(dirty.path, 'untracked.txt'), 'keep me\n');
    await writeFile(path.join(active.path, '.env'), 'keep me too\n');

    const result = await manager.gc({
      olderThanMs: 1_000,
      activeWorktreeIds: [active.id],
      now,
    });

    expect(result.removed).toEqual([stale.id]);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { id: dirty.id, reason: 'worktree contains local or ignored files' },
        { id: active.id, reason: 'active' },
      ]),
    );
    expect((await manager.list()).map(({ id }) => id)).toEqual(
      expect.arrayContaining([dirty.id, active.id]),
    );
  });

  it('detects conflicts without modifying the target and aborts a conflicted rebase', async () => {
    const worktree = await manager.create('conflicting-worker');
    await writeFile(path.join(worktree.path, 'file.txt'), 'worker change\n');
    await git(worktree.path, ['add', 'file.txt']);
    await git(worktree.path, ['commit', '-m', 'worker change']);
    const workerCommit = (await git(worktree.path, ['rev-parse', 'HEAD'])).trim();

    await writeFile(path.join(repository, 'file.txt'), 'target change\n');
    await git(repository, ['commit', '-am', 'target change']);

    expect(await manager.checkConflicts(worktree.id, 'main')).toContain('file.txt');
    const merge = await manager.merge(worktree.id, 'squash-to-branch', 'main');
    expect(merge).toMatchObject({ status: 'conflict', conflicts: ['file.txt'] });
    expect((await git(repository, ['status', '--porcelain'])).trim()).toBe('');

    expect(await manager.rebase(worktree.id, 'main')).toContain('file.txt');
    expect((await git(worktree.path, ['rev-parse', 'HEAD'])).trim()).toBe(workerCommit);
    expect((await git(worktree.path, ['status', '--porcelain'])).trim()).toBe('');
  });

  it('prepares PR and manual strategies and stages squash results on an isolated target branch', async () => {
    const worktree = await manager.create('merge-worker');
    await writeFile(path.join(worktree.path, 'addition.txt'), 'worker result\n');
    await git(worktree.path, ['add', 'addition.txt']);
    await git(worktree.path, ['commit', '-m', 'worker result']);

    expect(await manager.merge(worktree.id, 'pr', 'main')).toMatchObject({ status: 'ready' });
    expect(await manager.merge(worktree.id, 'manual', 'main')).toMatchObject({ status: 'ready' });
    const result = await manager.merge(worktree.id, 'squash-to-branch', 'main');
    expect(result).toMatchObject({
      status: 'applied',
      resultBranchName: expect.any(String),
      resultWorktreePath: expect.any(String),
    });
    expect((await git(repository, ['status', '--porcelain'])).trim()).toBe('');
    const resultWorktreePath = result.resultWorktreePath;
    if (!resultWorktreePath) throw new Error('squash result worktree was not returned');
    expect((await git(resultWorktreePath, ['diff', '--cached', '--name-only'])).trim()).toBe(
      'addition.txt',
    );
  });
});
