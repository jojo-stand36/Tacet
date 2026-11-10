import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { newUlid } from '@tacet/core';
import { type EventStore, openEventStore, workerGitEnv, workerWorktree } from '@tacet/core/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Workspaces } from './daemon/ports.js';
import { type WorktreeLog, WorktreeManager } from './worktree.js';

const execFileAsync = promisify(execFile);

async function git(
  repository: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME ?? '',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      ...extraEnv,
    },
  });

  return stdout;
}

describe('WorktreeManager', () => {
  let temporaryDirectory: string;
  let repository: string;
  let manager: WorktreeManager;
  let store: EventStore;
  let log: WorktreeLog;

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
    store = openEventStore(':memory:');
    log = { store, miniId: 'test' };
    manager = new WorktreeManager(repository, path.join(temporaryDirectory, 'worktrees'), { log });
  });

  async function workerGit(worktreePath: string, args: string[]): Promise<string> {
    const worktree = workerWorktree(worktreePath, repository);
    if (!worktree) throw new Error('expected linked Worker worktree');
    return git(worktreePath, args, workerGitEnv(worktree));
  }

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it('creates ten parallel detached workers with unique integration refs and paths', async () => {
    const worktrees = await Promise.all(
      Array.from({ length: 10 }, (_, index) => manager.create(`worker-${index}`, 'main')),
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
    for (const worktree of worktrees) {
      await expect(workerGit(worktree.path, ['symbolic-ref', '--quiet', 'HEAD'])).rejects.toThrow();
      await expect(
        git(repository, ['show-ref', '--verify', `refs/heads/${worktree.branchName}`]),
      ).rejects.toThrow();
    }
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

    expect(worktree.branchName).toMatch(/^tacet\/worker-/);
  });

  it('creates from an explicit base branch and runs an opt-in setup command', async () => {
    await git(repository, ['checkout', '-b', 'setup-base']);
    await writeFile(path.join(repository, 'base-only.txt'), 'from setup base\n');
    await git(repository, ['add', 'base-only.txt']);
    await git(repository, ['commit', '-m', 'base branch']);
    await git(repository, ['tag', 'setup-base', 'main']);
    await git(repository, ['checkout', 'main']);
    await writeFile(path.join(repository, '.env'), 'test-value\n');

    const worktree = await manager.create('setup-worker', 'setup-base', {
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
    // Staleness is by creation time (#126): all three are 10 s old by then.
    const now = Date.now() + 10_000;
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

  it('keeps Worker commits through gc and remove until they are merged, unless forced', async () => {
    const worktree = await manager.create('unintegrated-worker');
    await writeFile(path.join(worktree.path, 'private.txt'), 'not integrated yet\n');
    await workerGit(worktree.path, ['add', 'private.txt']);
    await workerGit(worktree.path, ['commit', '-m', 'private worker commit']);
    const head = (await workerGit(worktree.path, ['rev-parse', 'HEAD'])).trim();

    await expect(manager.remove(worktree.id)).rejects.toThrow(
      'Worker has unintegrated private commits',
    );
    expect(await manager.gc({ olderThanMs: 0 })).toMatchObject({
      removed: [],
      skipped: [{ id: worktree.id, reason: 'Worker has unintegrated private commits' }],
    });
    await expect(git(repository, ['cat-file', '-e', `${head}^{commit}`])).rejects.toThrow();

    // Integrated, the commit is only on tacet/<id>, which remove would delete.
    expect(await manager.checkConflicts(worktree.id, 'main')).toEqual([]);
    expect((await git(repository, ['rev-parse', `refs/heads/${worktree.branchName}`])).trim()).toBe(
      head,
    );
    await expect(manager.remove(worktree.id)).rejects.toThrow(
      'Worker has commits no other ref contains',
    );
    expect(await manager.gc({ olderThanMs: 0 })).toMatchObject({
      removed: [],
      skipped: [{ id: worktree.id, reason: 'Worker has commits no other ref contains' }],
    });

    await git(repository, ['merge', '--ff-only', worktree.branchName]);
    await manager.remove(worktree.id);
    expect((await manager.list()).map(({ id }) => id)).not.toContain(worktree.id);
    await expect(
      git(repository, ['show-ref', '--verify', `refs/heads/${worktree.branchName}`]),
    ).rejects.toThrow();
  });

  it('discards unmerged Worker commits and the task branch only when forced', async () => {
    const worktree = await manager.create('forced-worker');
    await writeFile(path.join(worktree.path, 'work.txt'), 'work\n');
    await workerGit(worktree.path, ['add', 'work.txt']);
    await workerGit(worktree.path, ['commit', '-m', 'work']);
    expect(await manager.merge(worktree.id, 'pr', 'main')).toMatchObject({ status: 'ready' });

    await manager.remove(worktree.id, { force: true });

    expect(await manager.get(worktree.id)).toBeUndefined();
    await expect(
      git(repository, ['show-ref', '--verify', `refs/heads/${worktree.branchName}`]),
    ).rejects.toThrow();
  });

  it('keeps the Worker commit after a PR-ready merge or a conflict', async () => {
    const ready = await manager.create('pr-worker');
    await writeFile(path.join(ready.path, 'pr.txt'), 'for a PR\n');
    await workerGit(ready.path, ['add', 'pr.txt']);
    await workerGit(ready.path, ['commit', '-m', 'pr work']);
    const readyHead = (await workerGit(ready.path, ['rev-parse', 'HEAD'])).trim();
    const conflicting = await manager.create('conflict-worker');
    await writeFile(path.join(conflicting.path, 'file.txt'), 'worker side\n');
    await workerGit(conflicting.path, ['commit', '-am', 'worker side']);
    const conflictHead = (await workerGit(conflicting.path, ['rev-parse', 'HEAD'])).trim();
    await writeFile(path.join(repository, 'file.txt'), 'target side\n');
    await git(repository, ['commit', '-am', 'target side']);

    expect(await manager.merge(ready.id, 'pr', 'main')).toMatchObject({ status: 'ready' });
    expect(await manager.merge(conflicting.id, 'manual', 'main')).toMatchObject({
      status: 'conflict',
    });

    for (const worktree of [ready, conflicting]) {
      await expect(manager.remove(worktree.id)).rejects.toThrow(
        'Worker has commits no other ref contains',
      );
    }
    expect((await manager.gc({ olderThanMs: 0, now: Date.now() + 1_000 })).removed).toEqual([]);
    for (const [worktree, head] of [
      [ready, readyHead],
      [conflicting, conflictHead],
    ] as const) {
      expect(
        (await git(repository, ['rev-parse', `refs/heads/${worktree.branchName}`])).trim(),
      ).toBe(head);
    }
  });

  it('keeps commits a Worker without a sandbox left only in its HEAD reflog', async () => {
    const worktree = await manager.create('unsandboxed-worker');
    // Plain git in the checkout writes the shared object store, as a Worker without a sandbox.
    await writeFile(path.join(worktree.path, 'shared.txt'), 'in the shared store\n');
    await git(worktree.path, ['add', 'shared.txt']);
    await git(worktree.path, ['commit', '-m', 'shared store commit']);
    const commit = (await git(worktree.path, ['rev-parse', 'HEAD'])).trim();
    await git(worktree.path, ['checkout', '--detach', 'refs/heads/main']);
    expect((await git(repository, ['cat-file', '-t', commit])).trim()).toBe('commit');

    await expect(manager.remove(worktree.id)).rejects.toThrow(
      'Worker has commits no other ref contains',
    );
    expect(await manager.gc({ olderThanMs: 0, now: Date.now() + 1_000 })).toMatchObject({
      removed: [],
      skipped: [{ id: worktree.id, reason: 'Worker has commits no other ref contains' }],
    });
  });

  it("never gives the Worker's object store alternates to git", async () => {
    const worktree = await manager.create('alternates-worker');
    const other = path.join(temporaryDirectory, 'other');
    await mkdir(other);
    await git(other, ['init', '-b', 'main']);
    await writeFile(path.join(other, 'other.txt'), 'elsewhere\n');
    await git(other, ['add', 'other.txt']);
    await git(other, [
      '-c',
      'user.name=Other',
      '-c',
      'user.email=other@example.invalid',
      'commit',
      '-m',
      'other',
    ]);
    const gitDirectory = (
      await git(repository, [
        'rev-parse',
        '--path-format=absolute',
        '--git-path',
        `worktrees/${worktree.id}`,
      ])
    ).trim();
    await mkdir(path.join(gitDirectory, 'objects', 'info'), { recursive: true });
    await writeFile(
      path.join(gitDirectory, 'objects', 'info', 'alternates'),
      `${path.join(other, '.git', 'objects')}\n`,
    );

    await manager.remove(worktree.id);

    expect(await manager.get(worktree.id)).toBeUndefined();
  });

  it('refuses to vouch for a Worker object store with packs', async () => {
    const worktree = await manager.create('packed-worker');
    const gitDirectory = (
      await git(repository, [
        'rev-parse',
        '--path-format=absolute',
        '--git-path',
        `worktrees/${worktree.id}`,
      ])
    ).trim();
    await mkdir(path.join(gitDirectory, 'objects', 'pack'), { recursive: true });
    await writeFile(path.join(gitDirectory, 'objects', 'pack', 'pack-1.pack'), 'PACK');

    await expect(manager.remove(worktree.id)).rejects.toThrow('unable to verify Worker commits');
    expect(await manager.gc({ olderThanMs: 0, now: Date.now() + 1_000 })).toMatchObject({
      skipped: [{ id: worktree.id, reason: 'unable to verify Worker commits' }],
    });
  });

  it('does not pass git stderr through remove', async () => {
    const worktree = await manager.create('corrupt-index-worker');
    const gitDirectory = (
      await git(repository, [
        'rev-parse',
        '--path-format=absolute',
        '--git-path',
        `worktrees/${worktree.id}`,
      ])
    ).trim();
    await writeFile(path.join(gitDirectory, 'index'), 'SECRET-WORKER-CONTENT not an index');

    const error = await manager.remove(worktree.id).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/^git command failed/);
    expect((error as Error).message).not.toMatch(/index|SECRET/);
  });

  it('creates at a commit id for the Workspaces port, and removes ids that are gone', async () => {
    await git(repository, ['checkout', '--detach']);
    await writeFile(path.join(repository, 'tagged.txt'), 'only on a tag\n');
    await git(repository, ['add', 'tagged.txt']);
    await git(repository, ['commit', '-m', 'tagged']);
    const commit = (await git(repository, ['rev-parse', 'HEAD'])).trim();
    await git(repository, ['tag', 'only-tag', commit]);
    await git(repository, ['checkout', 'main']);
    const workspaces: Workspaces = manager;

    const workspace = await workspaces.create('sha-worker', commit);
    expect(await readFile(path.join(workspace.path, 'tagged.txt'), 'utf8')).toBe('only on a tag\n');
    expect(await manager.get(workspace.id)).toMatchObject({ baseCommit: commit });
    expect((await manager.get(workspace.id))?.baseBranch).toBeUndefined();
    await expect(workspaces.create('bad-base', '--upload-pack=touch')).rejects.toThrow();
    await expect(workspaces.create('missing-commit', 'f'.repeat(40))).rejects.toThrow();

    await workspaces.remove(workspace.id);
    expect(await workspaces.get(workspace.id)).toBeUndefined();
    await workspaces.remove(workspace.id);
    await workspaces.remove('never-existed');

    const deleted = await manager.create('deleted-by-hand');
    await rm(deleted.path, { recursive: true, force: true });
    await workspaces.remove(deleted.id);
    expect(await git(repository, ['worktree', 'list'])).not.toContain(deleted.id);
    await expect(
      readFile(path.join(temporaryDirectory, 'worktrees', `.tacet-${deleted.id}.json`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('includes the worktree ID when setup fails and retains it for recovery', async () => {
    let worktreeId: string | undefined;
    try {
      await manager.create('setup-failure-worker', undefined, {
        setup: { command: process.execPath, args: ['-e', 'process.exit(1)'] },
      });
    } catch (error) {
      const match = /failed for ([a-z0-9-]+)/.exec((error as Error).message);
      worktreeId = match?.[1];
    }

    expect(worktreeId).toBeDefined();
    expect((await manager.list()).map(({ id }) => id)).toContain(worktreeId);
  });

  it('replaces a hostile .git symlink without writing through it during removal', async () => {
    const worktree = await manager.create('symlink-worker');
    const head = (await workerGit(worktree.path, ['rev-parse', 'HEAD'])).trim();
    expect(
      await workerGit(worktree.path, ['for-each-ref', `--contains=${head}`, '--format=%(refname)']),
    ).toContain('refs/heads/main');
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
    await writeFile(path.join(worktree.path, 'detached.txt'), 'worker commit\n');
    await workerGit(worktree.path, ['add', 'detached.txt']);
    await workerGit(worktree.path, ['commit', '-m', 'detached worker commit']);

    expect((await manager.list()).map(({ id }) => id)).toContain(worktree.id);
    expect(await manager.checkConflicts(worktree.id, 'main')).toEqual([]);
    const headSha = (await workerGit(worktree.path, ['rev-parse', 'HEAD'])).trim();
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
    await workerGit(worktree.path, ['add', 'file.txt']);
    await workerGit(worktree.path, ['commit', '-m', 'worker change']);
    const workerCommit = (await workerGit(worktree.path, ['rev-parse', 'HEAD'])).trim();
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
    await workerGit(worktree.path, ['add', 'addition.txt']);
    await workerGit(worktree.path, ['commit', '-m', 'worker result']);

    const workerCommit = (await workerGit(worktree.path, ['rev-parse', 'HEAD'])).trim();
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
    const resultBranchName = result.resultBranchName;
    if (!resultWorktreePath) throw new Error('squash result worktree was not returned');
    if (!resultBranchName) throw new Error('squash result branch was not returned');
    expect((await git(resultWorktreePath, ['symbolic-ref', '--short', 'HEAD'])).trim()).toBe(
      resultBranchName,
    );
    expect(
      (await git(repository, ['show-ref', '--verify', `refs/heads/${resultBranchName}`])).trim(),
    ).toContain(resultBranchName);
    expect((await git(resultWorktreePath, ['diff', '--cached', '--name-only'])).trim()).toBe(
      'addition.txt',
    );
    // The working tree has the result too, not only the index.
    expect(await readFile(path.join(resultWorktreePath, 'addition.txt'), 'utf8')).toBe(
      'worker result\n',
    );
    expect((await git(resultWorktreePath, ['status', '--porcelain'])).trim()).toBe(
      'A  addition.txt',
    );
  });

  it('keeps a committed squash result until its branch is merged', async () => {
    const worktree = await manager.create('squash-worker');
    await writeFile(path.join(worktree.path, 'squashed.txt'), 'squashed\n');
    await workerGit(worktree.path, ['add', 'squashed.txt']);
    await workerGit(worktree.path, ['commit', '-m', 'to squash']);
    const result = await manager.merge(worktree.id, 'squash-to-branch', 'main');
    const stagingPath = result.resultWorktreePath;
    const stagingBranch = result.resultBranchName;
    if (!stagingPath || !stagingBranch) throw new Error('squash result was not returned');
    const staging = (await manager.list()).find(({ path: p }) => p === stagingPath);
    if (!staging) throw new Error('staging worktree is not managed');

    await expect(manager.remove(staging.id)).rejects.toThrow('local or ignored files');
    await git(stagingPath, ['commit', '-m', 'squashed result']);
    const squashed = (await git(repository, ['rev-parse', `refs/heads/${stagingBranch}`])).trim();
    await expect(manager.remove(staging.id)).rejects.toThrow(
      'Worker has commits no other ref contains',
    );
    expect(await manager.gc({ olderThanMs: 0, now: Date.now() + 1_000 })).toMatchObject({
      removed: [],
    });
    expect((await git(repository, ['cat-file', '-t', squashed])).trim()).toBe('commit');

    await git(repository, ['merge', '--ff-only', stagingBranch]);
    await manager.remove(staging.id);
    await expect(
      git(repository, ['show-ref', '--verify', `refs/heads/${stagingBranch}`]),
    ).rejects.toThrow();
    expect(await manager.get(staging.id)).toBeUndefined();
  });

  it('protects the source and staging worktrees from every manager while a squash runs', async () => {
    const other = new WorktreeManager(repository, path.join(temporaryDirectory, 'worktrees'), {
      log,
    });
    const skippedDuringMerge: Array<{ id: string; reason: string }> = [];
    let ids: { source: string; staging: string } | undefined;
    const hooked = new WorktreeManager(repository, path.join(temporaryDirectory, 'worktrees'), {
      log,
      onSquashStaging: async (seen) => {
        ids = seen;
        const later = Date.now() + 10_000;
        for (const gc of [other, hooked]) {
          skippedDuringMerge.push(...(await gc.gc({ olderThanMs: 0, now: later })).skipped);
        }
        await expect(other.remove(seen.source, { force: true })).rejects.toThrow(
          'in use by a merge',
        );
        await expect(other.remove(seen.staging, { force: true })).rejects.toThrow(
          'in use by a merge',
        );
      },
    });
    const worktree = await hooked.create('guarded-worker');
    await writeFile(path.join(worktree.path, 'guarded.txt'), 'guarded\n');
    await workerGit(worktree.path, ['add', 'guarded.txt']);
    await workerGit(worktree.path, ['commit', '-m', 'guarded']);

    const result = await hooked.merge(worktree.id, 'squash-to-branch', 'main');

    expect(result.status).toBe('applied');
    if (!ids || !result.resultWorktreePath) throw new Error('hook did not run');
    expect(skippedDuringMerge).toEqual(
      expect.arrayContaining([
        { id: ids.source, reason: 'in use by a merge' },
        { id: ids.staging, reason: 'in use by a merge' },
      ]),
    );
    expect(await readFile(path.join(result.resultWorktreePath, 'guarded.txt'), 'utf8')).toBe(
      'guarded\n',
    );
    expect(await hooked.get(worktree.id)).toBeDefined();
  });

  it('cleans up the staging worktree and releases both worktrees when a squash fails', async () => {
    const failing = new WorktreeManager(repository, path.join(temporaryDirectory, 'worktrees'), {
      log,
      onSquashStaging: async () => {
        throw new Error('staging failed');
      },
    });
    const worktree = await failing.create('failed-squash-worker');
    await writeFile(path.join(worktree.path, 'failed.txt'), 'failed\n');
    await workerGit(worktree.path, ['add', 'failed.txt']);
    await workerGit(worktree.path, ['commit', '-m', 'failed']);

    await expect(failing.merge(worktree.id, 'squash-to-branch', 'main')).rejects.toThrow(
      'staging failed',
    );

    expect((await failing.list()).map(({ id }) => id)).toEqual([worktree.id]);
    expect(await git(repository, ['for-each-ref', 'refs/heads/tacet/squash-*'])).toBe('');
    await failing.remove(worktree.id, { force: true });
    expect(await failing.list()).toEqual([]);
  });

  it('keeps a worktree whose private objects it cannot fully read', async () => {
    const worktree = await manager.create('unreadable-objects-worker');
    await writeFile(path.join(worktree.path, 'hidden.txt'), 'hidden\n');
    await workerGit(worktree.path, ['add', 'hidden.txt']);
    await workerGit(worktree.path, ['commit', '-m', 'hidden']);
    const head = (await workerGit(worktree.path, ['rev-parse', 'HEAD'])).trim();
    const gitDirectory = (
      await git(repository, [
        'rev-parse',
        '--path-format=absolute',
        '--git-path',
        `worktrees/${worktree.id}`,
      ])
    ).trim();
    const fanout = path.join(gitDirectory, 'objects', head.slice(0, 2));
    const moved = path.join(temporaryDirectory, 'moved-fanout');
    await rename(fanout, moved);
    await symlink(moved, fanout);

    await expect(manager.remove(worktree.id)).rejects.toThrow('unable to verify Worker commits');
    expect((await manager.gc({ olderThanMs: 0, now: Date.now() + 1_000 })).removed).toEqual([]);

    // Nothing else names the commit: only reading the whole private store finds it.
    await rm(fanout);
    await rename(moved, fanout);
    await workerGit(worktree.path, ['checkout', '--detach', 'refs/heads/main']);
    await rm(path.join(gitDirectory, 'logs'), { recursive: true, force: true });
    await rename(fanout, moved);
    await symlink(moved, fanout);
    await expect(manager.remove(worktree.id)).rejects.toThrow('unable to verify Worker commits');
  });

  it('refuses a private store with a pack whose name starts with a dot', async () => {
    const worktree = await manager.create('dot-pack-worker');
    const gitDirectory = (
      await git(repository, [
        'rev-parse',
        '--path-format=absolute',
        '--git-path',
        `worktrees/${worktree.id}`,
      ])
    ).trim();
    await mkdir(path.join(gitDirectory, 'objects', 'pack'), { recursive: true });
    await writeFile(path.join(gitDirectory, 'objects', 'pack', '.h.pack'), 'PACK');

    await expect(manager.remove(worktree.id)).rejects.toThrow('unable to verify Worker commits');
  });

  it('checks a checkout deleted by hand before dropping its admin directory, and prunes nothing else', async () => {
    const worktree = await manager.create('deleted-with-work');
    await writeFile(path.join(worktree.path, 'work.txt'), 'work\n');
    await workerGit(worktree.path, ['add', 'work.txt']);
    await workerGit(worktree.path, ['commit', '-m', 'work']);
    const userWorktree = path.join(temporaryDirectory, 'user-worktree');
    await git(repository, ['worktree', 'add', '--detach', userWorktree]);
    await rm(userWorktree, { recursive: true, force: true });
    await rm(worktree.path, { recursive: true, force: true });

    await expect(manager.remove(worktree.id)).rejects.toThrow(
      'Worker has unintegrated private commits',
    );
    await manager.remove(worktree.id, { force: true });

    const registered = await git(repository, ['worktree', 'list', '--porcelain']);
    expect(registered).not.toContain(worktree.id);
    expect(registered).toContain(userWorktree);
    await manager.remove(worktree.id);
  });

  it('honours a live removal lock and recovers from an empty one', async () => {
    const worktree = await manager.create('locked-worker');
    const locks = path.join(temporaryDirectory, 'worktrees', '.tacet-locks');
    await mkdir(locks, { recursive: true });
    const lock = path.join(locks, `${worktree.id}.removing`);
    await writeFile(lock, `${process.pid} 0123abcd-0000\n`);

    await expect(manager.remove(worktree.id)).rejects.toThrow('already being removed');
    // A merge waits for the removal, then gives up while the lock is still live.
    const waiting = new WorktreeManager(repository, path.join(temporaryDirectory, 'worktrees'), {
      log,
      lockWaitMs: 300,
    });
    const started = Date.now();
    await expect(waiting.merge(worktree.id, 'pr', 'main')).rejects.toThrow('being removed');
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(await readFile(lock, 'utf8')).toBe(`${process.pid} 0123abcd-0000\n`);

    await writeFile(lock, '');
    expect(await manager.checkConflicts(worktree.id, 'main')).toEqual([]);
    await manager.remove(worktree.id);
    expect(await manager.get(worktree.id)).toBeUndefined();
  });

  it('never counts another tacet branch as keeping a commit, so concurrent removals keep it', async () => {
    const first = await manager.create('race-a');
    const second = await manager.create('race-b');
    await writeFile(path.join(first.path, 'race.txt'), 'race\n');
    await workerGit(first.path, ['add', 'race.txt']);
    await workerGit(first.path, ['commit', '-m', 'race']);
    expect(await manager.checkConflicts(first.id, 'main')).toEqual([]);
    const commit = (await git(repository, ['rev-parse', `refs/heads/${first.branchName}`])).trim();
    await git(repository, ['update-ref', `refs/heads/${second.branchName}`, commit]);
    await workerGit(first.path, ['checkout', '--detach', 'refs/heads/main']);
    const other = new WorktreeManager(repository, path.join(temporaryDirectory, 'worktrees'), {
      log,
    });

    const results = await Promise.allSettled([manager.remove(first.id), other.remove(second.id)]);

    expect(results.map(({ status }) => status)).toEqual(['rejected', 'rejected']);
    const containing = await git(repository, [
      'for-each-ref',
      `--contains=${commit}`,
      '--format=%(refname)',
    ]);
    expect(containing.trim()).not.toBe('');
  });

  it('does not let a private commit hide behind a replace ref', async () => {
    const worktree = await manager.create('replace-worker');
    await writeFile(path.join(worktree.path, 'replaced.txt'), 'replaced\n');
    await workerGit(worktree.path, ['add', 'replaced.txt']);
    await workerGit(worktree.path, ['commit', '-m', 'replaced']);
    const privateCommit = (await workerGit(worktree.path, ['rev-parse', 'HEAD'])).trim();
    const mainHead = (await git(repository, ['rev-parse', 'refs/heads/main'])).trim();
    await git(repository, ['update-ref', `refs/replace/${privateCommit}`, mainHead]);

    await expect(manager.remove(worktree.id)).rejects.toThrow(
      'Worker has unintegrated private commits',
    );
  });

  it('treats a lock held past the maximum age as stale, and waits out a short removal', async () => {
    const worktree = await manager.create('old-lock-worker');
    const locks = path.join(temporaryDirectory, 'worktrees', '.tacet-locks');
    await mkdir(locks, { recursive: true });
    const lock = path.join(locks, `${worktree.id}.removing`);

    // Held by a live PID (ours), as a reused PID would be: briefly, then released.
    await writeFile(lock, `${process.pid} 0123abcd-0002\n`);
    const released = new Promise((resolve) => setTimeout(resolve, 300)).then(() =>
      rm(lock, { force: true }),
    );
    expect(await manager.checkConflicts(worktree.id, 'main')).toEqual([]);
    await released;

    // Held by a live PID for longer than any removal runs.
    await writeFile(lock, `${process.pid} 0123abcd-0003\n`);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(lock, old, old);
    await manager.remove(worktree.id);
    expect(await manager.get(worktree.id)).toBeUndefined();
  });

  it('sweeps lock drafts and stale locks left by a crash', async () => {
    const locks = path.join(temporaryDirectory, 'worktrees', '.tacet-locks');
    await mkdir(locks, { recursive: true });
    const old = new Date(Date.now() - 60 * 60 * 1000);
    const draft = path.join(locks, 'w-1.draft.0123abcd-0004');
    const stale = path.join(locks, 'w-1.stale.0123abcd-0005');
    const fresh = path.join(locks, 'w-2.draft.0123abcd-0006');
    for (const file of [draft, stale, fresh]) await writeFile(file, '');
    await utimes(draft, old, old);
    await utimes(stale, old, old);

    await manager.gc({ olderThanMs: 0 });

    await expect(readFile(draft)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(stale)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(fresh, 'utf8')).toBe('');
  });

  describe('landed commits (#210)', () => {
    async function workerCommit(worktreePath: string, file: string): Promise<string> {
      await writeFile(path.join(worktreePath, file), `${file}\n`);
      await workerGit(worktreePath, ['add', file]);
      await workerGit(worktreePath, ['commit', '-m', file]);
      return (await workerGit(worktreePath, ['rev-parse', 'HEAD'])).trim();
    }
    async function squashIntoMain(commit: string): Promise<void> {
      await git(repository, ['merge', '--squash', commit]);
      await git(repository, ['commit', '-m', 'squash-merged']);
    }

    it('frees a squash-merged worktree only when told its commit landed', async () => {
      const worktree = await manager.create('squashed-worker');
      const commit = await workerCommit(worktree.path, 'squashed.txt');
      expect(await manager.checkConflicts(worktree.id, 'main')).toEqual([]);
      await squashIntoMain(commit);

      await expect(manager.remove(worktree.id)).rejects.toThrow(
        'Worker has commits no other ref contains',
      );
      await manager.remove(worktree.id, { landed: [commit] });
      expect(await manager.get(worktree.id)).toBeUndefined();
    });

    it('keeps work done after the landed commit', async () => {
      const worktree = await manager.create('after-landing-worker');
      const landed = await workerCommit(worktree.path, 'landed.txt');
      await workerCommit(worktree.path, 'later.txt');
      expect(await manager.checkConflicts(worktree.id, 'main')).toEqual([]);
      await squashIntoMain(landed);

      await expect(manager.remove(worktree.id, { landed: [landed] })).rejects.toThrow(
        'Worker has commits no other ref contains',
      );
    });

    it('keeps an amended-away commit that was never integrated', async () => {
      const worktree = await manager.create('amended-worker');
      await workerCommit(worktree.path, 'first.txt');
      await workerGit(worktree.path, ['commit', '--amend', '-m', 'amended']);
      const amended = (await workerGit(worktree.path, ['rev-parse', 'HEAD'])).trim();
      expect(await manager.checkConflicts(worktree.id, 'main')).toEqual([]);
      await squashIntoMain(amended);

      await expect(manager.remove(worktree.id, { landed: [amended] })).rejects.toThrow(
        'Worker has unintegrated private commits',
      );
    });

    it('refuses landed values that are not commits of the repository', async () => {
      const worktree = await manager.create('bad-landed-worker');
      const commit = await workerCommit(worktree.path, 'bad.txt');
      expect(await manager.checkConflicts(worktree.id, 'main')).toEqual([]);

      for (const landed of [['--all'], ['HEAD'], [`^${commit}`]]) {
        await expect(manager.remove(worktree.id, { landed })).rejects.toThrow(
          'unable to verify Worker commits',
        );
      }
      // A commit the repository does not have covers nothing.
      await expect(manager.remove(worktree.id, { landed: ['f'.repeat(40)] })).rejects.toThrow(
        'Worker has commits no other ref contains',
      );
      expect(await manager.get(worktree.id)).toBeDefined();
      expect(commit).toMatch(/^[0-9a-f]{40}$/);
    });
  });

  describe('the registry in the event log (#126)', () => {
    const root = () => path.join(temporaryDirectory, 'worktrees');
    const events = (type: string) =>
      store.query({ typePrefix: type }).map((e) => e.envelope.data as Record<string, unknown>);
    const adminDir = async (id: string) =>
      (
        await git(repository, [
          'rev-parse',
          '--path-format=absolute',
          '--git-path',
          `worktrees/${id}`,
        ])
      ).trim();
    async function workerCommit(worktreePath: string): Promise<void> {
      const file = `w-${path.basename(worktreePath)}.txt`;
      await writeFile(path.join(worktreePath, file), 'w\n');
      await workerGit(worktreePath, ['add', file]);
      await workerGit(worktreePath, ['commit', '-m', file]);
    }

    it('keeps no state files, with or without a log', async () => {
      for (const m of [manager, new WorktreeManager(repository, root())]) {
        const a = await m.create('a');
        const b = await m.create('b');
        await workerCommit(a.path);
        const squash = await m.merge(a.id, 'squash-to-branch', 'main');
        expect(squash.status).toBe('applied');
        await m.remove(b.id);
        for (const name of await readdir(root())) {
          expect(name === '.tacet-locks' || /^[a-z0-9-]+$/.test(name), name).toBe(true);
        }
      }
      // Never a path in an event: a checkout is <root>/<id>.
      for (const e of store.query({ typePrefix: 'workspace' })) {
        expect(JSON.stringify(e.envelope)).not.toContain(temporaryDirectory);
      }
    });

    it('finds every live worktree from the log after a restart, and none removed', async () => {
      await git(repository, ['checkout', '-q', '--detach']);
      const detached = await manager.create('detached');
      await git(repository, ['checkout', '-q', 'main']);
      const onMain = await manager.create('on-main');
      const removed = await manager.create('removed');
      await manager.remove(removed.id);
      expect(events('workspace.created')).toHaveLength(3);
      expect(events('workspace.removed')).toEqual([{ workspaceId: removed.id, reason: 'removed' }]);

      const restarted = new WorktreeManager(repository, root(), { log });
      const live = await restarted.list();
      expect(live.map(({ id }) => id).sort()).toEqual([detached.id, onMain.id].sort());
      expect(await restarted.get(onMain.id)).toMatchObject({
        baseBranch: 'main',
        baseCommit: onMain.baseCommit,
        path: onMain.path,
        branchName: onMain.branchName,
      });
      expect((await restarted.get(detached.id))?.baseBranch).toBeUndefined();
      expect(await restarted.get(removed.id)).toBeUndefined();
    });

    it('records intent first, and reconciles a crash on either side of git', async () => {
      // Crashed before `git worktree add`: only the intent is there.
      store.append({
        v: 1,
        id: newUlid(),
        ts: new Date().toISOString(),
        source: { kind: 'mini', id: 'test' },
        type: 'workspace.created',
        data: { workspaceId: 'never-made-1', workerId: 'w', baseCommit: 'a'.repeat(40) },
      });
      // Crashed after removing it, before recording that.
      const gone = await manager.create('gone');
      await git(repository, ['worktree', 'remove', '--force', gone.path]);
      // Deleted by hand: its admin directory is left, so it stays registered.
      const byHand = await manager.create('by-hand');
      await rm(byHand.path, { recursive: true, force: true });
      const live = await manager.create('live');

      await manager.reconcile();

      expect(events('workspace.removed')).toEqual(
        expect.arrayContaining([
          { workspaceId: 'never-made-1', reason: 'gone' },
          { workspaceId: gone.id, reason: 'gone' },
        ]),
      );
      expect(events('workspace.removed')).toHaveLength(2);
      expect((await manager.registered()).map(({ id, missing }) => [id, missing])).toEqual(
        expect.arrayContaining([
          [byHand.id, true],
          [live.id, false],
        ]),
      );
      expect(await manager.get(gone.id)).toBeUndefined();
      expect(await lstat(await adminDir(byHand.id))).toBeTruthy();
      await manager.reconcile();
      expect(events('workspace.removed')).toHaveLength(2);
    });

    it('records the intent before git makes the checkout', async () => {
      const seen: boolean[] = [];
      const append = store.append.bind(store);
      store.append = ((e: Parameters<EventStore['append']>[0]) => {
        for (const one of Array.isArray(e) ? e : [e]) {
          if (one.type === 'workspace.created') {
            const id = (one.data as { workspaceId: string }).workspaceId;
            seen.push(existsSync(path.join(root(), id)));
          }
        }
        return append(e);
      }) as EventStore['append'];
      await manager.create('ordered');
      expect(seen).toEqual([false]);
    });

    it('records a creation that git refused as gone, and one with a bad base not at all', async () => {
      await expect(manager.create('bad', 'f'.repeat(40))).rejects.toThrow();
      expect(events('workspace.created')).toEqual([]);
      // `git worktree add` fails after the intent is recorded.
      const worktreesDir = await adminDir('');
      await rm(worktreesDir, { recursive: true, force: true });
      await writeFile(worktreesDir.replace(/\/$/, ''), 'not a directory');
      await expect(manager.create('refused')).rejects.toThrow();
      const [created] = events('workspace.created');
      expect(events('workspace.removed')).toEqual([
        { workspaceId: created?.workspaceId, reason: 'gone' },
      ]);
    });

    it('never reconciles a workspace away while it is being created', async () => {
      const making = manager.create('racing');
      while (events('workspace.created').length === 0) await new Promise((r) => setImmediate(r));
      await manager.reconcile();
      const made = await making;
      expect(events('workspace.removed')).toEqual([]);
      expect(await manager.get(made.id)).toBeDefined();
    });

    it('leaves a registry file it cannot read, or that points elsewhere, where it is', async () => {
      const moved = await new WorktreeManager(repository, root()).create('moved');
      const unreadable = path.join(root(), '.tacet-broken-1.json');
      await writeFile(unreadable, '{ not json');
      const elsewhere = path.join(root(), `.tacet-${moved.id}.json`);
      await writeFile(
        elsewhere,
        JSON.stringify({
          ...moved,
          path: path.join(temporaryDirectory, 'elsewhere'),
          lastActivityAt: 1,
        }),
      );
      await manager.reconcile();
      expect(events('workspace.created')).toEqual([]);
      expect(await lstat(unreadable)).toBeTruthy();
      expect(await lstat(elsewhere)).toBeTruthy();
    });

    it('imports pre-#126 registry files once, deleting each only after it is in the log', async () => {
      const old = await manager.create('old');
      // As a pre-#126 manager left it: no event, a sidecar file.
      const legacyStore = openEventStore(':memory:');
      const legacy = new WorktreeManager(repository, root(), {
        log: { store: legacyStore, miniId: 'x' },
      });
      const made = await legacy.create('legacy');
      const sidecar = path.join(root(), `.tacet-${made.id}.json`);
      await writeFile(sidecar, JSON.stringify({ ...made, createdAt: 1, lastActivityAt: 1 }));
      expect((await manager.registered()).map(({ id }) => id)).toEqual(
        expect.arrayContaining([old.id, made.id]),
      );

      await manager.reconcile();
      expect(events('workspace.created').filter((e) => e.workspaceId === made.id)).toEqual([
        {
          workspaceId: made.id,
          workerId: 'legacy',
          baseCommit: made.baseCommit,
          baseBranch: 'main',
          migrated: true,
        },
      ]);
      await expect(lstat(sidecar)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await manager.get(made.id)).toMatchObject({ baseCommit: made.baseCommit });

      // A crash between the append and the delete: the file is back, the event is there.
      await writeFile(sidecar, JSON.stringify({ ...made, createdAt: 1, lastActivityAt: 1 }));
      await manager.reconcile();
      expect(events('workspace.created').filter((e) => e.workspaceId === made.id)).toHaveLength(1);
      await expect(lstat(sidecar)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('refuses to create or remove on a read-only log, before running git', async () => {
      const live = await manager.create('live');
      const reader = new WorktreeManager(repository, root(), {
        log: { store, miniId: 'test', readonly: true },
      });
      await expect(reader.create('nope')).rejects.toThrow(/read-only/);
      await expect(reader.remove(live.id)).rejects.toThrow(/read-only/);
      await expect(reader.reconcile()).rejects.toThrow(/read-only/);
      expect(await reader.check(live.id)).toBeUndefined();
      expect((await readdir(root())).filter((n) => n.startsWith('nope'))).toEqual([]);
      expect(await manager.get(live.id)).toBeDefined();
    });
  });

  it('ignores busy markers left by a manager that died', async () => {
    const worktree = await manager.create('orphaned-marker-worker');
    const child = execFile(process.execPath, ['-e', '']);
    const deadPid = child.pid;
    await new Promise((resolve) => child.on('exit', resolve));
    if (deadPid === undefined) throw new Error('no pid');
    const locks = path.join(temporaryDirectory, 'worktrees', '.tacet-locks');
    await mkdir(locks, { recursive: true });
    await writeFile(path.join(locks, `${worktree.id}.busy.${deadPid}.stale`), '');
    await writeFile(path.join(locks, `${worktree.id}.removing`), `${deadPid} 0123abcd-0001\n`);

    expect((await manager.gc({ olderThanMs: 0, now: Date.now() + 1_000 })).removed).toEqual([
      worktree.id,
    ]);
  });

  it('returns no-changes with the target SHA when a Worker has no commits', async () => {
    const worktree = await manager.create('no-change-worker');
    const targetTip = (await git(repository, ['rev-parse', 'refs/heads/main'])).trim();

    await expect(manager.merge(worktree.id, 'pr', 'main')).resolves.toMatchObject({
      status: 'no-changes',
      headSha: targetTip,
    });
  });

  it('retains private commits after the Worker moves HEAD back to the base', async () => {
    const worktree = await manager.create('moved-head-worker');
    await writeFile(path.join(worktree.path, 'private.txt'), 'private commit\n');
    await workerGit(worktree.path, ['add', 'private.txt']);
    await workerGit(worktree.path, ['commit', '-m', 'private commit']);
    const privateCommit = (await workerGit(worktree.path, ['rev-parse', 'HEAD'])).trim();
    await workerGit(worktree.path, ['checkout', '--detach', 'refs/heads/main']);

    await expect(manager.remove(worktree.id)).rejects.toThrow('unintegrated private commits');
    expect(await manager.gc({ olderThanMs: 0, now: Date.now() + 1_000 })).toMatchObject({
      removed: [],
      skipped: [{ id: worktree.id, reason: 'Worker has unintegrated private commits' }],
    });
    expect(await workerGit(worktree.path, ['cat-file', '-e', `${privateCommit}^{commit}`])).toBe(
      '',
    );
  });
});
