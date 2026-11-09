import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface WorktreeSetup {
  command: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
}

export interface CreateWorktreeOptions {
  baseBranch?: string;
  setup?: WorktreeSetup;
}

export interface WorktreeInfo {
  id: string;
  workerId: string;
  branch: string;
  branchName: string;
  path: string;
  baseBranch: string;
  createdAt: number;
  lastActivityAt: number;
}

export type MergeStrategy = 'pr' | 'squash-to-branch' | 'manual';

export interface MergeResult {
  strategy: MergeStrategy;
  status: 'ready' | 'applied' | 'conflict';
  branchName: string;
  headSha: string;
  targetBranch: string;
  conflicts: string[];
  resultBranchName?: string;
  resultWorktreePath?: string;
}

export interface WorktreeGcOptions {
  olderThanMs: number;
  activeWorktreeIds?: readonly string[];
  now?: number;
}

export interface WorktreeGcResult {
  removed: string[];
  skipped: Array<{ id: string; reason: string }>;
}

interface ProcessFailure extends Error {
  code?: number | string;
  stdout?: string;
  stderr?: string;
}

interface ManagerPaths {
  repository: string;
  root: string;
}

const commandTimeoutMs = 120_000;
const maxBuffer = 1024 * 1024;
const worktreeIdPattern = /^[a-z0-9-]+$/;
const safeGitArgs = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.logAllRefUpdates=false',
  '-c',
  'extensions.worktreeConfig=false',
  '-c',
  'gc.auto=0',
  '-c',
  'maintenance.auto=false',
] as const;

function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs = commandTimeoutMs,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      {
        cwd,
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer,
        windowsHide: true,
        ...(env ? { env } : {}),
      },
      (error, stdout, stderr) => {
        if (error) {
          const failure = error as ProcessFailure;
          failure.stdout = stdout;
          failure.stderr = stderr;
          reject(failure);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function workerGitEnvironment(commonDirectory?: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    ...(commonDirectory ? { GIT_COMMON_DIR: commonDirectory } : {}),
  };
}

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const env = workerGitEnvironment();
    const repository = (
      await runCommand(
        'git',
        [...safeGitArgs, 'rev-parse', '--show-toplevel'],
        cwd,
        commandTimeoutMs,
        env,
      )
    ).trim();
    const commonDirectory = (
      await runCommand(
        'git',
        [...safeGitArgs, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
        repository,
        commandTimeoutMs,
        env,
      )
    ).trim();
    return await runCommand(
      'git',
      [...safeGitArgs, `--git-dir=${commonDirectory}`, `--work-tree=${repository}`, ...args],
      repository,
      commandTimeoutMs,
      workerGitEnvironment(commonDirectory),
    );
  } catch (error) {
    const failure = error as ProcessFailure;
    const code = failure.code === undefined ? '' : ` (exit ${failure.code})`;
    throw new Error(`git command failed${code}`);
  }
}

function isDirty(status: string): boolean {
  return status.trim().length > 0;
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative !== '' &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
  );
}

function workerSlug(workerId: string): string {
  const normalized = workerId.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  let start = 0;
  let end = normalized.length;
  while (start < end && normalized.charCodeAt(start) === 45) start += 1;
  while (end > start && normalized.charCodeAt(end - 1) === 45) end -= 1;
  return normalized.slice(start, Math.min(end, start + 48)) || 'worker';
}

export class WorktreeManager {
  private pathsPromise: Promise<ManagerPaths> | undefined;

  constructor(
    private readonly repositoryPath: string,
    private readonly worktreeRoot?: string,
  ) {}

  async create(workerId: string, options: CreateWorktreeOptions = {}): Promise<WorktreeInfo> {
    if (!workerId.trim()) throw new Error('workerId must not be empty');
    if (options.setup) {
      const timeoutMs = options.setup.timeoutMs ?? commandTimeoutMs;
      if (!options.setup.command.trim()) throw new Error('setup command must not be empty');
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        throw new Error('setup timeoutMs must be a positive safe integer');
      }
    }
    const { repository, root } = await this.paths();
    const baseBranch = options.baseBranch ?? (await this.currentBranch(repository));
    await this.requireLocalBranch(repository, baseBranch);

    const id = `${workerSlug(workerId)}-${randomUUID()}`;
    const branchName = `tacet/workers/${id}`;
    const worktreePath = path.join(root, id);
    await runGit(repository, ['check-ref-format', '--branch', branchName]);
    await runGit(repository, [
      'worktree',
      'add',
      '-b',
      branchName,
      worktreePath,
      `refs/heads/${baseBranch}`,
    ]);

    const timestamp = Date.now();
    const info: WorktreeInfo = {
      id,
      workerId,
      branch: branchName,
      branchName,
      path: worktreePath,
      baseBranch,
      createdAt: timestamp,
      lastActivityAt: timestamp,
    };
    try {
      await this.writeInfo(root, info);
    } catch (error) {
      try {
        await runGit(repository, ['worktree', 'remove', worktreePath]);
        await runGit(repository, ['update-ref', '-d', `refs/heads/${branchName}`]);
      } catch {
        // Keep the original metadata error; Git may still need manual cleanup.
      }
      throw error;
    }

    if (options.setup) {
      const timeoutMs = options.setup.timeoutMs ?? commandTimeoutMs;
      try {
        const env: NodeJS.ProcessEnv = {};
        for (const name of [
          'PATH',
          'HOME',
          'USERPROFILE',
          'TMPDIR',
          'TMP',
          'TEMP',
          'LANG',
          'LC_ALL',
        ]) {
          const value = process.env[name];
          if (value !== undefined) env[name] = value;
        }
        Object.assign(env, options.setup.env);
        await runCommand(
          options.setup.command,
          options.setup.args ?? [],
          worktreePath,
          timeoutMs,
          env,
        );
      } catch {
        throw new Error('worktree setup command failed; the worktree was retained for recovery');
      }
    }

    return info;
  }

  async list(): Promise<WorktreeInfo[]> {
    const { root } = await this.paths();
    const entries = await readdir(root, { withFileTypes: true });
    const result: WorktreeInfo[] = [];

    for (const entry of entries) {
      const match = /^\.tacet-([a-z0-9-]+)\.json$/.exec(entry.name);
      if (!entry.isFile() || !match) continue;
      const id = match[1];
      if (!id || !worktreeIdPattern.test(id)) continue;
      const info = await this.readInfo(root, id);
      if (!info || info.path !== path.join(root, id)) continue;
      const actualPath = await realpath(info.path).catch(() => undefined);
      if (actualPath === info.path) result.push(info);
    }
    return result;
  }

  async touch(worktreeId: string, now = Date.now()): Promise<WorktreeInfo> {
    const info = await this.requireWorktree(worktreeId);
    if (!Number.isSafeInteger(now) || now < 0)
      throw new Error('now must be a non-negative safe integer');
    const updated = { ...info, lastActivityAt: now };
    const { root } = await this.paths();
    await this.writeInfo(root, updated);
    return updated;
  }

  async remove(worktreeId: string, options: { force?: boolean } = {}): Promise<void> {
    const info = await this.requireWorktree(worktreeId);
    const { repository, root } = await this.paths();
    if (!options.force) {
      const status = await this.runWorktreeGit(info, [
        'status',
        '--porcelain',
        '--untracked-files=all',
        '--ignored=matching',
      ]);
      if (isDirty(status)) {
        throw new Error(
          'worktree contains local or ignored files; pass { force: true } to remove it',
        );
      }
    }
    const gitDirectory = await this.worktreeGitDirectory(info, false);
    await this.assertSafeWorktreeConfig(gitDirectory);
    await this.restoreAdminGitdir(info, gitDirectory);
    const gitFile = path.join(info.path, '.git');
    const temporaryGitFile = path.join(info.path, `.git.${randomUUID()}.tmp`);
    await writeFile(temporaryGitFile, `gitdir: ${gitDirectory}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    try {
      await rm(gitFile, { recursive: true, force: true });
      await rename(temporaryGitFile, gitFile);
    } catch (error) {
      await rm(temporaryGitFile, { force: true });
      throw error;
    }
    const commonDirectory = await this.commonGitDirectory();
    await runCommand(
      'git',
      [
        ...safeGitArgs,
        `--git-dir=${commonDirectory}`,
        `--work-tree=${repository}`,
        'worktree',
        'remove',
        '--force',
        info.path,
      ],
      repository,
      commandTimeoutMs,
      workerGitEnvironment(commonDirectory),
    );
    await rm(this.infoPath(root, worktreeId), { force: true });
  }

  async gc(options: WorktreeGcOptions): Promise<WorktreeGcResult> {
    if (!Number.isSafeInteger(options.olderThanMs) || options.olderThanMs < 0) {
      throw new Error('olderThanMs must be a non-negative safe integer');
    }
    const now = options.now ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0)
      throw new Error('now must be a non-negative safe integer');
    const active = new Set(options.activeWorktreeIds ?? []);
    const result: WorktreeGcResult = { removed: [], skipped: [] };

    for (const info of await this.list()) {
      if (active.has(info.id)) {
        result.skipped.push({ id: info.id, reason: 'active' });
        continue;
      }
      if (now - info.lastActivityAt < options.olderThanMs) {
        result.skipped.push({ id: info.id, reason: 'not stale' });
        continue;
      }
      let status: string;
      try {
        status = await this.runWorktreeGit(info, [
          'status',
          '--porcelain',
          '--untracked-files=all',
          '--ignored=matching',
        ]);
      } catch {
        result.skipped.push({ id: info.id, reason: 'worktree Git metadata is invalid' });
        continue;
      }
      if (isDirty(status)) {
        result.skipped.push({ id: info.id, reason: 'worktree contains local or ignored files' });
        continue;
      }
      try {
        await this.remove(info.id);
        result.removed.push(info.id);
      } catch {
        result.skipped.push({ id: info.id, reason: 'Git refused to remove the worktree' });
      }
    }
    return result;
  }

  async checkConflicts(worktreeId: string, targetBranch: string): Promise<string[]> {
    const info = await this.requireWorktree(worktreeId);
    const { repository } = await this.paths();
    await this.requireLocalBranch(repository, targetBranch);
    const workerCommit = await this.worktreeHead(info);
    return this.findConflicts(repository, targetBranch, workerCommit);
  }

  private async findConflicts(
    repository: string,
    targetBranch: string,
    workerCommit: string,
  ): Promise<string[]> {
    try {
      const commonDirectory = await this.commonGitDirectory();
      await runCommand(
        'git',
        [
          ...safeGitArgs,
          `--git-dir=${commonDirectory}`,
          `--work-tree=${repository}`,
          'merge-tree',
          '--write-tree',
          '--name-only',
          '-z',
          `refs/heads/${targetBranch}`,
          workerCommit,
        ],
        repository,
        commandTimeoutMs,
        workerGitEnvironment(commonDirectory),
      );
      return [];
    } catch (error) {
      const failure = error as ProcessFailure;
      if (failure.code !== 1) throw error;
      const fields = (failure.stdout ?? '').split('\0');
      const endOfNames = fields.indexOf('', 1);
      const names = fields.slice(1, endOfNames < 0 ? undefined : endOfNames);
      return names.length > 0 ? [...new Set(names)] : ['<unknown>'];
    }
  }

  async merge(
    worktreeId: string,
    strategy: MergeStrategy,
    targetBranch: string,
  ): Promise<MergeResult> {
    const info = await this.requireWorktree(worktreeId);
    const { repository } = await this.paths();
    await this.requireLocalBranch(repository, targetBranch);

    const workerCommit = await this.worktreeHead(info);
    const conflicts = await this.findConflicts(repository, targetBranch, workerCommit);
    if (conflicts.length > 0) {
      return {
        strategy,
        status: 'conflict',
        branchName: info.branchName,
        headSha: workerCommit,
        targetBranch,
        conflicts,
      };
    }

    if (strategy !== 'squash-to-branch') {
      return {
        strategy,
        status: 'ready',
        branchName: info.branchName,
        headSha: workerCommit,
        targetBranch,
        conflicts: [],
      };
    }

    const stagingWorktree = await this.create(`squash-${info.id}`, {
      baseBranch: targetBranch,
    });
    try {
      await this.runWorktreeGit(stagingWorktree, ['merge', '--squash', workerCommit]);
      return {
        strategy,
        status: 'applied',
        branchName: info.branchName,
        headSha: workerCommit,
        targetBranch,
        conflicts: [],
        resultBranchName: stagingWorktree.branchName,
        resultWorktreePath: stagingWorktree.path,
      };
    } catch (error) {
      const unmerged = await this.runWorktreeGit(stagingWorktree, [
        'diff',
        '--name-only',
        '--diff-filter=U',
      ]);
      if (unmerged.trim()) {
        return {
          strategy,
          status: 'conflict',
          branchName: info.branchName,
          headSha: workerCommit,
          targetBranch,
          conflicts: unmerged.trim().split('\n'),
          resultBranchName: stagingWorktree.branchName,
          resultWorktreePath: stagingWorktree.path,
        };
      }
      await this.remove(stagingWorktree.id);
      throw error;
    }
  }

  private async paths(): Promise<ManagerPaths> {
    if (this.pathsPromise) return this.pathsPromise;
    const pathsPromise = (async () => {
      const repository = await realpath(
        (await runGit(this.repositoryPath, ['rev-parse', '--show-toplevel'])).trim(),
      );
      const digest = createHash('sha256').update(repository).digest('hex').slice(0, 12);
      const defaultRoot = path.join(
        path.dirname(repository),
        `.${path.basename(repository)}.tacet-worktrees-${digest}`,
      );
      const configuredRoot = path.resolve(this.worktreeRoot ?? defaultRoot);
      if (configuredRoot === repository || isWithin(repository, configuredRoot)) {
        throw new Error('worktree root must be outside the repository');
      }
      await mkdir(configuredRoot, { recursive: true, mode: 0o700 });
      const root = await realpath(configuredRoot);
      if (root === repository || isWithin(repository, root)) {
        throw new Error('worktree root must be outside the repository');
      }
      return { repository, root };
    })();
    this.pathsPromise = pathsPromise.catch((error: unknown) => {
      this.pathsPromise = undefined;
      throw error;
    });
    return this.pathsPromise;
  }

  private async worktreeGitDirectory(info: WorktreeInfo, validateGitdir = true): Promise<string> {
    const commonDirectory = await this.commonGitDirectory();
    const gitDirectory = await realpath(path.join(commonDirectory, 'worktrees', info.id));
    const expectedParent = path.join(commonDirectory, 'worktrees');
    if (path.dirname(gitDirectory) !== expectedParent || path.basename(gitDirectory) !== info.id) {
      throw new Error('worktree Git directory is outside the repository common directory');
    }
    if (validateGitdir) {
      const gitdirFile = path.join(gitDirectory, 'gitdir');
      const gitdir = (await readFile(gitdirFile, 'utf8')).trim();
      if (path.resolve(gitDirectory, gitdir) !== path.join(info.path, '.git')) {
        throw new Error('worktree Git directory does not point to its manager-owned worktree');
      }
    }
    return gitDirectory;
  }

  private async restoreAdminGitdir(info: WorktreeInfo, gitDirectory: string): Promise<void> {
    const gitdirFile = path.join(gitDirectory, 'gitdir');
    const temporaryGitdirFile = `${gitdirFile}.${randomUUID()}.tmp`;
    await writeFile(temporaryGitdirFile, `${path.join(info.path, '.git')}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    try {
      await rm(gitdirFile, { recursive: true, force: true });
      await rename(temporaryGitdirFile, gitdirFile);
    } catch (error) {
      await rm(temporaryGitdirFile, { force: true });
      throw error;
    }
  }

  private async runWorktreeGit(info: WorktreeInfo, args: readonly string[]): Promise<string> {
    const { repository } = await this.paths();
    if ((await realpath(info.path)) !== info.path) {
      throw new Error('worktree path no longer resolves to its managed location');
    }
    const gitDirectory = await this.worktreeGitDirectory(info);
    const commonDirectory = await this.commonGitDirectory();
    await this.assertSafeWorktreeConfig(gitDirectory);
    return runCommand(
      'git',
      [...safeGitArgs, `--git-dir=${gitDirectory}`, `--work-tree=${info.path}`, ...args],
      repository,
      commandTimeoutMs,
      workerGitEnvironment(commonDirectory),
    );
  }

  private async assertSafeWorktreeConfig(gitDirectory: string): Promise<void> {
    const commonDirectory = await this.commonGitDirectory();
    const worktreeCommonDirectory = (
      await readFile(path.join(gitDirectory, 'commondir'), 'utf8')
    ).trim();
    if (path.resolve(gitDirectory, worktreeCommonDirectory) !== commonDirectory) {
      throw new Error('worktree common directory is not the manager-owned directory');
    }

    for (const logPath of [
      path.join(gitDirectory, 'logs'),
      path.join(gitDirectory, 'logs', 'HEAD'),
    ]) {
      try {
        if ((await lstat(logPath)).isSymbolicLink()) {
          throw new Error('worktree Git reflog path must not be a symlink');
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }

    try {
      await lstat(path.join(gitDirectory, 'config.worktree'));
      throw new Error('worktree-specific Git config is not allowed');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    try {
      const enabled = await runCommand(
        'git',
        [
          'config',
          '--file',
          path.join(commonDirectory, 'config'),
          '--bool',
          '--get',
          'extensions.worktreeConfig',
        ],
        commonDirectory,
        commandTimeoutMs,
        workerGitEnvironment(commonDirectory),
      );
      if (enabled.trim() === 'true') {
        throw new Error('extensions.worktreeConfig is not allowed for managed worktrees');
      }
    } catch (error) {
      const failure = error as ProcessFailure;
      if (failure.code !== 1) throw error;
    }
  }

  private async worktreeHead(info: WorktreeInfo): Promise<string> {
    return (await this.runWorktreeGit(info, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  }

  private async commonGitDirectory(): Promise<string> {
    const { repository } = await this.paths();
    return realpath(
      (
        await runGit(repository, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
      ).trim(),
    );
  }

  private async currentBranch(repository: string): Promise<string> {
    const branch = (
      await runGit(repository, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    ).trim();
    if (!branch) throw new Error('baseBranch is required when the repository has a detached HEAD');
    return branch;
  }

  private async requireLocalBranch(repository: string, branch: string): Promise<void> {
    await runGit(repository, ['check-ref-format', '--branch', branch]);
    await runGit(repository, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`]);
  }

  private infoPath(root: string, id: string): string {
    if (!worktreeIdPattern.test(id)) throw new Error('invalid worktree id');
    return path.join(root, `.tacet-${id}.json`);
  }

  private async writeInfo(root: string, info: WorktreeInfo): Promise<void> {
    const destination = this.infoPath(root, info.id);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(info), { flag: 'wx', mode: 0o600 });
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  private async readInfo(root: string, id: string): Promise<WorktreeInfo | undefined> {
    try {
      const info = JSON.parse(await readFile(this.infoPath(root, id), 'utf8')) as WorktreeInfo;
      if (
        info.id !== id ||
        typeof info.workerId !== 'string' ||
        typeof info.branchName !== 'string' ||
        typeof info.path !== 'string' ||
        typeof info.baseBranch !== 'string' ||
        !info.branchName.startsWith('tacet/workers/') ||
        !Number.isSafeInteger(info.createdAt) ||
        !Number.isSafeInteger(info.lastActivityAt)
      ) {
        return undefined;
      }
      return { ...info, branch: info.branchName };
    } catch {
      return undefined;
    }
  }

  private async requireWorktree(id: string): Promise<WorktreeInfo> {
    if (!worktreeIdPattern.test(id)) throw new Error('invalid worktree id');
    const info = (await this.list()).find((worktree) => worktree.id === id);
    if (!info) throw new Error(`managed worktree not found: ${id}`);
    return info;
  }
}
