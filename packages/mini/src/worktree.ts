import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readWorkerFile, SAFE_GIT_ARGS, trustedGitEnv, workerWorktree } from '@tacet/core/node';
import { MergeConflictError } from './daemon/ports.js';
import { integrateWorktree, taskBranch } from './git/integrate.js';
import { combineCommits } from './git/merge.js';

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
  baseCommit: string;
  createdAt: number;
  lastActivityAt: number;
}

export type MergeStrategy = 'pr' | 'squash-to-branch' | 'manual';

export interface MergeResult {
  strategy: MergeStrategy;
  status: 'ready' | 'applied' | 'conflict' | 'no-changes';
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
  commonDirectory: string;
}

const commandTimeoutMs = 120_000;
const maxBuffer = 1024 * 1024;
const worktreeIdPattern = /^[a-z0-9-]+$/;
const managerGitArgs = [
  ...SAFE_GIT_ARGS,
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

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const env = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    };
    const repository = (
      await runCommand(
        'git',
        [...managerGitArgs, 'rev-parse', '--show-toplevel'],
        cwd,
        commandTimeoutMs,
        env,
      )
    ).trim();
    const commonDirectory = (
      await runCommand(
        'git',
        [...managerGitArgs, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
        repository,
        commandTimeoutMs,
        env,
      )
    ).trim();
    const gitEnv = trustedGitEnv(
      repository,
      { gitDir: commonDirectory, commonDir: commonDirectory },
      process.env,
    );
    return await runCommand(
      'git',
      [...managerGitArgs, ...args],
      repository,
      commandTimeoutMs,
      gitEnv,
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
  private readonly activeStagingWorktrees = new Set<string>();

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
    const { root } = await this.paths();
    const baseBranch = options.baseBranch ?? (await this.currentBranch());
    await this.requireLocalBranch(baseBranch);
    const baseCommit = (
      await this.git(['rev-parse', '--verify', `refs/heads/${baseBranch}^{commit}`])
    ).trim();

    const id = `${workerSlug(workerId)}-${randomUUID()}`;
    const branchName = taskBranch(id).slice('refs/heads/'.length);
    const worktreePath = path.join(root, id);
    await this.git(['worktree', 'add', '--detach', worktreePath, `refs/heads/${baseBranch}`]);

    const timestamp = Date.now();
    const info: WorktreeInfo = {
      id,
      workerId,
      branch: branchName,
      branchName,
      path: worktreePath,
      baseBranch,
      baseCommit,
      createdAt: timestamp,
      lastActivityAt: timestamp,
    };
    try {
      const commonDirectory = await this.commonGitDirectory();
      await mkdir(path.join(commonDirectory, 'worktrees', id, 'objects'), {
        recursive: true,
        mode: 0o700,
      });
      await this.writeInfo(root, info);
    } catch (error) {
      try {
        await this.git(['worktree', 'remove', '--force', worktreePath]);
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
        throw new Error(
          `worktree setup command failed for ${id}; the worktree was retained for recovery`,
        );
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

  async get(worktreeId: string): Promise<WorktreeInfo | undefined> {
    if (!worktreeIdPattern.test(worktreeId)) return undefined;
    return (await this.list()).find(({ id }) => id === worktreeId);
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
    const { root } = await this.paths();
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
    if (!(await this.headIsReachable(info))) {
      throw new Error('worker HEAD is not reachable from a ref; integrate it before removal');
    }
    await this.ensureNoPrivateCommits(info, options.force === true);
    const gitDirectory = await this.managerWorktreeGitDirectory(info);
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
    await this.git(['worktree', 'remove', '--force', info.path]);
    await this.git(['update-ref', '-d', taskBranch(info.id)]).catch(() => {});
    await rm(this.infoPath(root, worktreeId), { force: true });
    this.activeStagingWorktrees.delete(worktreeId);
  }

  async gc(options: WorktreeGcOptions): Promise<WorktreeGcResult> {
    if (!Number.isSafeInteger(options.olderThanMs) || options.olderThanMs < 0) {
      throw new Error('olderThanMs must be a non-negative safe integer');
    }
    const now = options.now ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0)
      throw new Error('now must be a non-negative safe integer');
    const active = new Set(options.activeWorktreeIds ?? []);
    for (const id of this.activeStagingWorktrees) active.add(id);
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
        await this.ensureNoPrivateCommits(info, false);
      } catch {
        result.skipped.push({ id: info.id, reason: 'Worker has unintegrated private commits' });
        continue;
      }
      try {
        await this.remove(info.id);
        result.removed.push(info.id);
      } catch (error) {
        const reason =
          error instanceof Error && error.message.includes('not reachable')
            ? 'worker HEAD is not reachable from a ref'
            : 'Git refused to remove the worktree';
        result.skipped.push({ id: info.id, reason });
      }
    }
    return result;
  }

  async checkConflicts(worktreeId: string, targetBranch: string): Promise<string[]> {
    const info = await this.requireWorktree(worktreeId);
    await this.requireLocalBranch(targetBranch);
    const workerCommit = await this.integrate(info);
    if (!workerCommit) return [];
    try {
      await this.combineWithTarget(targetBranch, workerCommit);
      return [];
    } catch (error) {
      if (error instanceof MergeConflictError) return error.files;
      throw error;
    }
  }

  private async combineWithTarget(
    targetBranch: string,
    workerCommit: string,
  ): Promise<{ commit: string; targetTip: string }> {
    try {
      const targetTip = (
        await this.git(['rev-parse', '--verify', `refs/heads/${targetBranch}^{commit}`])
      ).trim();
      const combined = await combineCommits([targetTip, workerCommit], {
        repoRoot: (await this.paths()).repository,
      });
      if (!combined) throw new Error('commit combination returned no result');
      return { commit: combined, targetTip };
    } catch (error) {
      if (error instanceof MergeConflictError) throw error;
      throw new Error('unable to combine Worker commits');
    }
  }

  async merge(
    worktreeId: string,
    strategy: MergeStrategy,
    targetBranch: string,
  ): Promise<MergeResult> {
    const info = await this.requireWorktree(worktreeId);
    await this.requireLocalBranch(targetBranch);

    const workerCommit = await this.integrate(info);
    if (!workerCommit) {
      const targetTip = (
        await this.git(['rev-parse', '--verify', `refs/heads/${targetBranch}^{commit}`])
      ).trim();
      return {
        strategy,
        status: 'no-changes',
        branchName: targetBranch,
        headSha: targetTip,
        targetBranch,
        conflicts: [],
      };
    }
    let combinedCommit: string;
    let targetTip: string;
    try {
      const combined = await this.combineWithTarget(targetBranch, workerCommit);
      combinedCommit = combined.commit;
      targetTip = combined.targetTip;
    } catch (error) {
      if (!(error instanceof MergeConflictError)) throw error;
      return {
        strategy,
        status: 'conflict',
        branchName: info.branchName,
        headSha: workerCommit,
        targetBranch,
        conflicts: error.files,
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

    const stagingWorktree = await this.create(`squash-${info.id}`, { baseBranch: targetBranch });
    this.activeStagingWorktrees.add(stagingWorktree.id);
    let stagingBranchCreated = false;
    let stagingBase: string | undefined;
    try {
      stagingBase = await this.worktreeHead(stagingWorktree);
      if (stagingBase !== targetTip) throw new Error('target branch moved while preparing squash');
      await this.attachStagingBranch(stagingWorktree, stagingBase);
      stagingBranchCreated = true;
      await this.runWorktreeGit(stagingWorktree, ['read-tree', '--reset', combinedCommit]);
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
      let unmerged = '';
      try {
        unmerged = await this.runWorktreeGit(stagingWorktree, [
          'diff',
          '--name-only',
          '--diff-filter=U',
        ]);
      } catch {
        // Preserve the original squash failure.
      }
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
      await this.remove(stagingWorktree.id, { force: true }).catch(() => {});
      if (stagingBranchCreated && stagingBase) {
        await this.deleteStagingBranch(stagingWorktree, stagingBase).catch(() => {});
      }
      throw error;
    }
  }

  private async paths(): Promise<ManagerPaths> {
    if (this.pathsPromise) return this.pathsPromise;
    const pathsPromise = (async () => {
      const repository = await realpath(
        (await runGit(this.repositoryPath, ['rev-parse', '--show-toplevel'])).trim(),
      );
      const commonDirectory = await realpath(
        (
          await runGit(repository, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
        ).trim(),
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
      return { repository, root, commonDirectory };
    })();
    this.pathsPromise = pathsPromise.catch((error: unknown) => {
      this.pathsPromise = undefined;
      throw error;
    });
    return this.pathsPromise;
  }

  private async git(args: readonly string[]): Promise<string> {
    const { repository, commonDirectory } = await this.paths();
    const env = trustedGitEnv(
      repository,
      { gitDir: commonDirectory, commonDir: commonDirectory },
      process.env,
    );
    try {
      return await runCommand('git', [...managerGitArgs, ...args], repository, commandTimeoutMs, {
        ...env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      });
    } catch (error) {
      const failure = error as ProcessFailure;
      const code = failure.code === undefined ? '' : ` (exit ${failure.code})`;
      throw new Error(`git command failed${code}`);
    }
  }

  private async managerWorktreeGitDirectory(info: WorktreeInfo): Promise<string> {
    const commonDirectory = await this.commonGitDirectory();
    const expectedGitDirectory = path.join(commonDirectory, 'worktrees', info.id);
    const gitDirectory = await realpath(expectedGitDirectory);
    const expectedParent = path.join(commonDirectory, 'worktrees');
    if (path.dirname(gitDirectory) !== expectedParent || path.basename(gitDirectory) !== info.id) {
      throw new Error('worktree Git directory is outside the repository common directory');
    }
    if (gitDirectory !== expectedGitDirectory) {
      throw new Error('worktree Git directory is not manager-owned');
    }
    return gitDirectory;
  }

  private async restoreAdminGitdir(info: WorktreeInfo, gitDirectory: string): Promise<void> {
    await this.replaceAdminFile(path.join(gitDirectory, 'commondir'), '../..\n');
    await this.replaceAdminFile(
      path.join(gitDirectory, 'gitdir'),
      `${path.join(info.path, '.git')}\n`,
    );
    await rm(path.join(gitDirectory, 'config.worktree'), { recursive: true, force: true });
    await rm(path.join(gitDirectory, 'logs'), { recursive: true, force: true });
    await rm(path.join(gitDirectory, 'locked'), { force: true });
  }

  private async replaceAdminFile(filePath: string, contents: string): Promise<void> {
    const temporaryFile = `${filePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryFile, contents, { flag: 'wx', mode: 0o600 });
    try {
      await rm(filePath, { recursive: true, force: true });
      await rename(temporaryFile, filePath);
    } catch (error) {
      await rm(temporaryFile, { force: true });
      throw error;
    }
  }

  private async runWorktreeGit(info: WorktreeInfo, args: readonly string[]): Promise<string> {
    const { repository } = await this.paths();
    if ((await realpath(info.path)) !== info.path) {
      throw new Error('worktree path no longer resolves to its managed location');
    }
    const worktree = workerWorktree(info.path, repository);
    if (!worktree) throw new Error('managed path is not a linked worktree');
    const gitDirectory = await this.managerWorktreeGitDirectory(info);
    if (worktree.gitDir !== gitDirectory) {
      throw new Error('worktree Git directory does not point to its manager-owned worktree');
    }
    const commonDirectory = await this.commonGitDirectory();
    if (worktree.commonDir !== commonDirectory) {
      throw new Error('worktree common directory is not the manager-owned directory');
    }
    return runCommand(
      'git',
      [...managerGitArgs, ...args],
      repository,
      commandTimeoutMs,
      trustedGitEnv(info.path, worktree, process.env),
    );
  }

  private async integrate(info: WorktreeInfo): Promise<string | undefined> {
    const { repository } = await this.paths();
    const integrated = await integrateWorktree({
      cwd: info.path,
      repoRoot: repository,
      ref: `refs/heads/${info.branchName}`,
      base: info.baseCommit,
    });
    return integrated?.commit ?? undefined;
  }

  private async attachStagingBranch(info: WorktreeInfo, commit: string): Promise<void> {
    const ref = `refs/heads/${info.branchName}`;
    await this.git(['update-ref', ref, commit, '0'.repeat(commit.length)]);
    try {
      await this.runWorktreeGit(info, ['symbolic-ref', 'HEAD', ref]);
    } catch (error) {
      await this.git(['update-ref', '-d', ref, commit]).catch(() => {});
      throw error;
    }
  }

  private async deleteStagingBranch(info: WorktreeInfo, commit: string): Promise<void> {
    await this.git(['update-ref', '-d', `refs/heads/${info.branchName}`, commit]);
  }

  private async worktreeHead(info: WorktreeInfo): Promise<string> {
    return (await this.runWorktreeGit(info, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  }

  private async headIsReachable(info: WorktreeInfo): Promise<boolean> {
    try {
      const gitDirectory = await this.managerWorktreeGitDirectory(info);
      const head = readWorkerFile(path.join(gitDirectory, 'HEAD'), 512).trim();
      let commit = head;
      if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) {
        const ref = /^ref: (refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+)$/.exec(head)?.[1];
        if (!ref) return false;
        commit = (await this.git(['rev-parse', '--verify', `${ref}^{commit}`])).trim();
      }

      if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) return false;
      await this.git(['cat-file', '-e', `${commit}^{commit}`]);
      const refs = await this.git(['for-each-ref', `--contains=${commit}`, '--format=%(refname)']);
      return refs.trim().length > 0;
    } catch {
      return false;
    }
  }

  private async ensureNoPrivateCommits(info: WorktreeInfo, force: boolean): Promise<void> {
    if (force) return;
    let unreachable: string;
    try {
      unreachable = await this.runWorktreeGit(info, [
        'fsck',
        '--full',
        '--unreachable',
        '--no-reflogs',
        '--no-progress',
      ]);
    } catch {
      throw new Error('unable to verify Worker private commits');
    }
    for (const match of unreachable.matchAll(
      /(?:unreachable|dangling) commit ([0-9a-f]{40}(?:[0-9a-f]{24})?)/g,
    )) {
      const commit = match[1];
      if (!commit) continue;
      try {
        await this.git(['cat-file', '-e', `${commit}^{commit}`]);
      } catch {
        throw new Error('Worker has unintegrated private commits');
      }
    }
  }

  private async commonGitDirectory(): Promise<string> {
    return (await this.paths()).commonDirectory;
  }

  private async currentBranch(): Promise<string> {
    const branch = (await this.git(['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim();
    if (!branch) throw new Error('baseBranch is required when the repository has a detached HEAD');
    return branch;
  }

  private async requireLocalBranch(branch: string): Promise<void> {
    await this.git(['check-ref-format', '--branch', branch]);
    await this.git(['rev-parse', '--verify', `refs/heads/${branch}^{commit}`]);
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
        !Number.isSafeInteger(info.createdAt) ||
        !Number.isSafeInteger(info.lastActivityAt)
      ) {
        return undefined;
      }
      const branchName = taskBranch(id).slice('refs/heads/'.length);
      return { ...info, branch: branchName, branchName };
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
