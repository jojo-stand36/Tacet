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
  branchName?: string;
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

function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return runCommand('git', args, cwd).catch((error: ProcessFailure) => {
    const code = error.code === undefined ? '' : ` (exit ${error.code})`;
    throw new Error(`git command failed${code}`);
  });
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
      const branchRef = fields.find((value) => value.startsWith('branch '))?.slice(7);
      if (worktreePath) {
        worktrees.push({
          path: path.resolve(worktreePath),
          ...(branchRef?.startsWith('refs/heads/')
            ? { branchName: branchRef.slice('refs/heads/'.length) }
            : {}),
        });
      }
      fields = [];
    } else {
      fields.push(field);
    }
  }
  return worktrees;
}

function conflictsFromOutput(output: string): string[] {
  const conflicts = [...output.matchAll(/CONFLICT[^:\n]*:\s*(?:[^:\n]* in )?(.+)$/gm)]
    .map((match) => match[1]?.trim())
    .filter((file): file is string => Boolean(file));
  return conflicts.length > 0 ? [...new Set(conflicts)] : ['<unknown>'];
}

export class WorktreeManager {
  private pathsPromise?: Promise<ManagerPaths>;

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
    await runGit(repository, ['worktree', 'add', '-b', branchName, worktreePath, baseBranch]);

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
    await this.writeInfo(root, info);

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
      if (info && info.path === worktree.path && info.branchName === worktree.branchName) {
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

  async remove(worktreeId: string): Promise<void> {
    const info = await this.requireWorktree(worktreeId);
    const { repository, root } = await this.paths();
    await runGit(repository, ['worktree', 'remove', info.path]);
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
      const status = await runGit(info.path, [
        'status',
        '--porcelain',
        '--untracked-files=all',
        '--ignored=matching',
      ]);
      if (status.trim()) {
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

    try {
      await runCommand(
        'git',
        ['merge-tree', '--write-tree', targetBranch, info.branchName],
        repository,
      );
      return [];
    } catch (error) {
      const failure = error as ProcessFailure;
      if (failure.code !== 1) throw error;
      return conflictsFromOutput(failure.stdout ?? '');
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

    const stagingWorktree = await this.create(`squash-${info.id}`, {
      baseBranch: targetBranch,
    });
    try {
      await runGit(stagingWorktree.path, ['merge', '--squash', info.branchName]);
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
      const unmerged = await runGit(stagingWorktree.path, [
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
      throw error;
    }
  }

  async rebase(worktreeId: string, baseBranch: string): Promise<string[]> {
    const info = await this.requireWorktree(worktreeId);
    const { repository } = await this.paths();
    await this.requireLocalBranch(repository, baseBranch);
    const status = await runGit(info.path, ['status', '--porcelain', '--untracked-files=all']);
    if (status.trim()) throw new Error('rebase requires a clean worker worktree');

    try {
      await runGit(info.path, ['rebase', baseBranch]);
      return [];
    } catch (error) {
      const unmerged = await runGit(info.path, ['diff', '--name-only', '--diff-filter=U']);
      if (!unmerged.trim()) throw error;
      await runGit(info.path, ['rebase', '--abort']);
      return unmerged.trim().split('\n');
    }
  }

  private async paths(): Promise<ManagerPaths> {
    this.pathsPromise ??= (async () => {
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
    return this.pathsPromise;
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
    await writeFile(temporary, JSON.stringify(info), { flag: 'wx', mode: 0o600 });
    await rename(temporary, destination);
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
