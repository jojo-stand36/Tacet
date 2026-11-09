import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
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

interface GitWorktree {
  path: string;
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

function workerGitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    GIT_CONFIG_NOSYSTEM: '1',
  };
}

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const env = workerGitEnvironment();
    const repository = (
      await runCommand('git', ['rev-parse', '--show-toplevel'], cwd, commandTimeoutMs, env)
    ).trim();
    const commonDirectory = (
      await runCommand(
        'git',
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        repository,
        commandTimeoutMs,
        env,
      )
    ).trim();
    return await runCommand(
      'git',
      [
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.hooksPath=/dev/null',
        `--git-dir=${commonDirectory}`,
        `--work-tree=${repository}`,
        ...args,
      ],
      repository,
      commandTimeoutMs,
      env,
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

function parseWorktrees(output: string): GitWorktree[] {
  const worktrees: GitWorktree[] = [];
  let fields: string[] = [];
  for (const field of output.split('\0')) {
    if (!field) {
      const worktreePath = fields.find((value) => value.startsWith('worktree '))?.slice(9);
      if (worktreePath) {
        worktrees.push({ path: path.resolve(worktreePath) });
      }
      fields = [];
    } else {
      fields.push(field);
    }
  }
  return worktrees;
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
    const { repository, root } = await this.paths();
    const worktrees = parseWorktrees(
      await runGit(repository, ['worktree', 'list', '--porcelain', '-z']),
    );
    const result: WorktreeInfo[] = [];

    for (const worktree of worktrees) {
      if (!isWithin(root, worktree.path) || path.dirname(worktree.path) !== root) continue;
      const id = path.basename(worktree.path);
      if (!worktreeIdPattern.test(id)) continue;
      const info = await this.readInfo(root, id);
      if (info && info.path === worktree.path) {
        result.push(info);
      }
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
    const gitDirectory = await this.worktreeGitDirectory(info);
    await rm(path.join(info.path, '.git'), { recursive: true, force: true });
    await writeFile(path.join(info.path, '.git'), `gitdir: ${gitDirectory}\n`, {
      mode: 0o600,
    });
    const commonDirectory = await this.commonGitDirectory();
    await runCommand(
      'git',
      [
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.hooksPath=/dev/null',
        `--git-dir=${commonDirectory}`,
        `--work-tree=${repository}`,
        'worktree',
        'remove',
        ...(options.force ? ['--force'] : []),
        info.path,
      ],
      repository,
      commandTimeoutMs,
      workerGitEnvironment(),
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
      const status = await this.runWorktreeGit(info, [
        'status',
        '--porcelain',
        '--untracked-files=all',
        '--ignored=matching',
      ]);
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

    try {
      await runCommand(
        'git',
        [
          'merge-tree',
          '--write-tree',
          '--name-only',
          '-z',
          `refs/heads/${targetBranch}`,
          workerCommit,
        ],
        repository,
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

    const conflicts = await this.checkConflicts(worktreeId, targetBranch);
    if (conflicts.length > 0) {
      return { strategy, status: 'conflict', branchName: info.branchName, targetBranch, conflicts };
    }

    if (strategy !== 'squash-to-branch') {
      return {
        strategy,
        status: 'ready',
        branchName: info.branchName,
        targetBranch,
        conflicts: [],
      };
    }

    const workerCommit = await this.worktreeHead(info);
    const stagingWorktree = await this.create(`squash-${info.id}`, {
      baseBranch: targetBranch,
    });
    try {
      await this.runWorktreeGit(stagingWorktree, ['merge', '--squash', workerCommit]);
      return {
        strategy,
        status: 'applied',
        branchName: info.branchName,
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

  async rebase(worktreeId: string, baseBranch: string): Promise<string[]> {
    const info = await this.requireWorktree(worktreeId);
    const { repository } = await this.paths();
    await this.requireLocalBranch(repository, baseBranch);
    const status = await this.runWorktreeGit(info, [
      'status',
      '--porcelain',
      '--untracked-files=all',
    ]);
    if (isDirty(status)) throw new Error('rebase requires a clean worker worktree');

    try {
      await this.runWorktreeGit(info, ['rebase', '--no-verify', `refs/heads/${baseBranch}`]);
      return [];
    } catch (error) {
      const unmerged = await this.runWorktreeGit(info, ['diff', '--name-only', '--diff-filter=U']);
      if (!unmerged.trim()) throw error;
      await this.runWorktreeGit(info, ['rebase', '--abort']);
      return unmerged.trim().split('\n');
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

  private async worktreeGitDirectory(info: WorktreeInfo): Promise<string> {
    const { repository } = await this.paths();
    const commonDirectory = await this.commonGitDirectory();
    const gitDirectory = await realpath(
      (
        await runGit(repository, [
          'rev-parse',
          '--path-format=absolute',
          '--git-path',
          `worktrees/${info.id}`,
        ])
      ).trim(),
    );
    const expectedParent = path.join(commonDirectory, 'worktrees');
    if (path.dirname(gitDirectory) !== expectedParent) {
      throw new Error('worktree Git directory is outside the repository common directory');
    }
    return gitDirectory;
  }

  private async runWorktreeGit(info: WorktreeInfo, args: readonly string[]): Promise<string> {
    const { repository } = await this.paths();
    if ((await realpath(info.path)) !== info.path) {
      throw new Error('worktree path no longer resolves to its managed location');
    }
    const gitDirectory = await this.worktreeGitDirectory(info);
    return runCommand(
      'git',
      [
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.hooksPath=/dev/null',
        `--git-dir=${gitDirectory}`,
        `--work-tree=${info.path}`,
        ...args,
      ],
      repository,
      commandTimeoutMs,
      workerGitEnvironment(),
    );
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
