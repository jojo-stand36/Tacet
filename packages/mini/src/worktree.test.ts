import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorktreeManager } from './worktree.js';

const execFileAsync = promisify(execFile);

async function git(repository: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME ?? '',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
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
      Array.from({ length: 10 }, (_, index) =>
        manager.create(`worker-${index}`, { baseBranch: 'main' }),
      ),
    );
    const firstWorktree = worktrees[0];
    if (!firstWorktree) {
      throw new Error('Expected at least one worktree');
    }

    expect(new Set(worktrees.map(({ branchName }) => branchName)).size).toBe(10);
    expect(worktrees.every(({ branch, branchName }) => branch === branchName)).toBe(true);
    expect(new Set(worktrees.map(({ path: worktreePath }) => worktreePath)).size).toBe(10);
    expect((await manager.list()).length).toBe(10);
    expect(worktrees.every(({ baseBranch }) => baseBranch === 'main')).toBe(true);
    await expect(manager.get(firstWorktree.id)).resolves.toMatchObject({
      id: firstWorktree.id,
      path: firstWorktree.path,
      branch: firstWorktree.branch,
    });
    await expect(manager.get('missing-worker')).resolves.toBeUndefined();
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

  it('retries path discovery after the repository initially does not exist', async () => {
    const lateRepository = path.join(temporaryDirectory, 'late-repo');
    const lateManager = new WorktreeManager(
      lateRepository,
      path.join(temporaryDirectory, 'late-worktrees'),
    );
    await expect(lateManager.list()).rejects.toThrow();

    await mkdir(lateRepository);
    await git(lateRepository, ['init', '-b', 'main']);
    await git(lateRepository, ['config', 'user.name', 'Tacet test']);
    await git(lateRepository, ['config', 'user.email', 'tacet-test@example.invalid']);
    await writeFile(path.join(lateRepository, 'file.txt'), 'base\n');
    await git(lateRepository, ['add', '.']);
    await git(lateRepository, ['commit', '-m', 'initial']);

    expect(await lateManager.create('retry-worker')).toMatchObject({
      branch: expect.any(String),
    });
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
    await git(repository, ['tag', 'setup-base', 'main']);
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

  it('refuses to remove dirty or ignored files unless forced', async () => {
    const worktree = await manager.create('preserve-local-files');
    await writeFile(path.join(worktree.path, '.env'), 'local\n');

    await expect(manager.remove(worktree.id)).rejects.toThrow(
      'worktree contains local or ignored files',
    );
    expect(await readFile(path.join(worktree.path, '.env'), 'utf8')).toBe('local\n');

    await manager.remove(worktree.id, { force: true });
    await expect(readFile(worktree.path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('replaces a hostile .git symlink without writing through it during removal', async () => {
    const worktree = await manager.create('symlink-worker');
    const sentinel = path.join(temporaryDirectory, 'outside-file');
    await writeFile(sentinel, 'do not overwrite\n');
    await rm(path.join(worktree.path, '.git'));
    await symlink(sentinel, path.join(worktree.path, '.git'));

    await manager.remove(worktree.id, { force: true });

    expect(await readFile(sentinel, 'utf8')).toBe('do not overwrite\n');
    await expect(readFile(worktree.path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes a worktree whose .git entry became a non-empty directory', async () => {
    const worktree = await manager.create('directory-git-worker');
    const gitEntry = path.join(worktree.path, '.git');
    await rm(gitEntry);
    await mkdir(gitEntry);
    await writeFile(path.join(gitEntry, 'hostile'), 'worker content\n');

    await manager.remove(worktree.id, { force: true });

    await expect(readFile(worktree.path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not expose rebase while worker-controlled HEAD could target a shared branch', async () => {
    const worktree = await manager.create('hostile-head-worker');
    const adminDirectory = (
      await git(repository, [
        'rev-parse',
        '--path-format=absolute',
        '--git-path',
        `worktrees/${worktree.id}`,
      ])
    ).trim();
    const mainHead = (await git(repository, ['rev-parse', 'refs/heads/main'])).trim();
    await writeFile(path.join(adminDirectory, 'HEAD'), 'ref: refs/heads/main\n');

    expect(manager).not.toHaveProperty('rebase');
    expect((await manager.list()).map(({ id }) => id)).toContain(worktree.id);
    await manager.remove(worktree.id, { force: true });

    expect((await git(repository, ['rev-parse', 'refs/heads/main'])).trim()).toBe(mainHead);
  });

  it('does not hide or trust a worktree whose admin gitdir was rewritten', async () => {
    const worktree = await manager.create('rewritten-gitdir-worker');
    const adminDirectory = (
      await git(repository, [
        'rev-parse',
        '--path-format=absolute',
        '--git-path',
        `worktrees/${worktree.id}`,
      ])
    ).trim();
    await writeFile(path.join(adminDirectory, 'gitdir'), `${temporaryDirectory}/elsewhere/.git\n`);

    expect((await manager.list()).map(({ id }) => id)).toContain(worktree.id);
    await expect(manager.checkConflicts(worktree.id, 'main')).rejects.toThrow(/refusing worktree/);
    expect(await manager.gc({ olderThanMs: 0, now: Date.now() + 1_000 })).toMatchObject({
      removed: [],
      skipped: [{ id: worktree.id, reason: 'worktree Git metadata is invalid' }],
    });
    await manager.remove(worktree.id, { force: true });
  });

  it('refuses symlinked admin reflog paths', async () => {
    const worktree = await manager.create('reflog-symlink-worker');
    const adminDirectory = (
      await git(repository, [
        'rev-parse',
        '--path-format=absolute',
        '--git-path',
        `worktrees/${worktree.id}`,
      ])
    ).trim();
    const sentinel = path.join(temporaryDirectory, 'outside-reflog');
    const logsDirectory = path.join(adminDirectory, 'logs');
    await writeFile(sentinel, 'keep\n');
    await rm(logsDirectory, { recursive: true, force: true });
    await mkdir(logsDirectory);
    await symlink(sentinel, path.join(logsDirectory, 'HEAD'));

    await expect(manager.checkConflicts(worktree.id, 'main')).resolves.toEqual([]);
    expect(await readFile(sentinel, 'utf8')).toBe('keep\n');
  });

  it('keeps detached-head worktrees listed and uses their HEAD for merge checks', async () => {
    const worktree = await manager.create('detached-worker');
    await git(worktree.path, ['checkout', '--detach']);
    await writeFile(path.join(worktree.path, 'detached.txt'), 'worker commit\n');
    await git(worktree.path, ['add', 'detached.txt']);
    await git(worktree.path, ['commit', '-m', 'detached worker commit']);

    expect((await manager.list()).map(({ id }) => id)).toContain(worktree.id);
    expect(await manager.checkConflicts(worktree.id, 'main')).toEqual([]);
    const headSha = (await git(worktree.path, ['rev-parse', 'HEAD'])).trim();
    expect(await manager.merge(worktree.id, 'pr', 'main')).toMatchObject({
      status: 'ready',
      headSha,
    });
    expect(await manager.merge(worktree.id, 'manual', 'main')).toMatchObject({
      status: 'ready',
      headSha,
    });
  });

  it('does not execute repository hooks or fsmonitor during worktree creation', async () => {
    const marker = path.join(temporaryDirectory, 'creation-command-ran');
    const fsmonitor = path.join(temporaryDirectory, 'creation-fsmonitor');
    const hooks = path.join(temporaryDirectory, 'creation-hooks');
    await mkdir(hooks);
    await writeFile(fsmonitor, `#!/bin/sh\nprintf ran >> '${marker}'\n`);
    await chmod(fsmonitor, 0o700);
    await writeFile(path.join(hooks, 'post-checkout'), `#!/bin/sh\nprintf ran >> '${marker}'\n`);
    await chmod(path.join(hooks, 'post-checkout'), 0o700);
    await git(repository, ['config', 'core.fsmonitor', fsmonitor]);
    await git(repository, ['config', 'core.hooksPath', hooks]);

    await manager.create('creation-hook-worker');

    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses worktree-specific config before a configured filter can run', async () => {
    const worktree = await manager.create('worktree-config-worker');
    const marker = path.join(temporaryDirectory, 'filter-ran');
    const filter = path.join(temporaryDirectory, 'filter');
    await writeFile(filter, `#!/bin/sh\nprintf ran >> '${marker}'\ncat\n`);
    await chmod(filter, 0o700);
    const gitDirectory = (
      await git(repository, [
        'rev-parse',
        '--path-format=absolute',
        '--git-path',
        `worktrees/${worktree.id}`,
      ])
    ).trim();
    await writeFile(
      path.join(gitDirectory, 'config.worktree'),
      `[filter "hostile"]\n clean = ${filter}\n smudge = cat\n required = true\n`,
    );
    await writeFile(path.join(worktree.path, '.gitattributes'), 'file.txt filter=hostile\n');

    await expect(manager.checkConflicts(worktree.id, 'main')).rejects.toThrow(/refusing worktree/);
    await expect(manager.remove(worktree.id)).rejects.toThrow(/refusing worktree/);
    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses repositories with extensions.worktreeConfig enabled', async () => {
    const worktree = await manager.create('extension-config-worker');
    await git(repository, ['config', 'extensions.worktreeConfig', 'true']);
    await expect(manager.checkConflicts(worktree.id, 'main')).rejects.toThrow(
      /extensions\.worktreeConfig/,
    );
  });

  it('refuses a rewritten commondir before a hostile filter can run', async () => {
    const worktree = await manager.create('commondir-worker');
    const realGitDirectory = (
      await git(repository, [
        'rev-parse',
        '--path-format=absolute',
        '--git-path',
        `worktrees/${worktree.id}`,
      ])
    ).trim();
    const commondirFile = path.join(realGitDirectory, 'commondir');
    const commonDirectory = (
      await git(repository, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    ).trim();
    const hostileCommonDirectory = path.join(temporaryDirectory, 'hostile-common');
    const marker = path.join(temporaryDirectory, 'commondir-filter-ran');
    const filter = path.join(temporaryDirectory, 'commondir-filter');
    await writeFile(filter, `#!/bin/sh\nprintf ran >> '${marker}'\ncat\n`);
    await chmod(filter, 0o700);
    await mkdir(hostileCommonDirectory);
    await writeFile(
      path.join(hostileCommonDirectory, 'config'),
      `[extensions]\n worktreeConfig = true\n[filter "hostile"]\n clean = ${filter}\n smudge = cat\n required = true\n`,
    );
    await writeFile(path.join(worktree.path, '.gitattributes'), 'file.txt filter=hostile\n');
    await writeFile(commondirFile, `${hostileCommonDirectory}\n`);
    expect(await readFile(commondirFile, 'utf8')).not.toBe(`${commonDirectory}\n`);

    await expect(manager.checkConflicts(worktree.id, 'main')).rejects.toThrow(/refusing worktree/);
    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    await manager.remove(worktree.id, { force: true });
  });

  it('detects conflicts without modifying the target', async () => {
    const worktree = await manager.create('conflicting-worker');
    await git(repository, ['tag', 'main', 'HEAD']);
    await writeFile(path.join(worktree.path, 'file.txt'), 'worker change\n');
    await git(worktree.path, ['add', 'file.txt']);
    await git(worktree.path, ['commit', '-m', 'worker change']);
    const workerCommit = (await git(worktree.path, ['rev-parse', 'HEAD'])).trim();
    await writeFile(path.join(repository, 'file.txt'), 'target change\n');
    await git(repository, ['commit', '-am', 'target change']);

    expect(await manager.checkConflicts(worktree.id, 'main')).toContain('file.txt');
    expect(await manager.merge(worktree.id, 'manual', 'main')).toMatchObject({
      status: 'conflict',
      headSha: workerCommit,
    });
    const merge = await manager.merge(worktree.id, 'squash-to-branch', 'main');
    expect(merge).toMatchObject({ status: 'conflict', conflicts: ['file.txt'] });
    expect((await git(repository, ['status', '--porcelain'])).trim()).toBe('');
  });

  it('prepares PR and manual strategies and stages squash results on an isolated target branch', async () => {
    const worktree = await manager.create('merge-worker');
    await writeFile(path.join(worktree.path, 'addition.txt'), 'worker result\n');
    await git(worktree.path, ['add', 'addition.txt']);
    await git(worktree.path, ['commit', '-m', 'worker result']);

    const workerCommit = (await git(worktree.path, ['rev-parse', 'HEAD'])).trim();
    expect(await manager.merge(worktree.id, 'pr', 'main')).toMatchObject({
      status: 'ready',
      headSha: workerCommit,
    });
    expect(await manager.merge(worktree.id, 'manual', 'main')).toMatchObject({
      status: 'ready',
      headSha: workerCommit,
    });
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
