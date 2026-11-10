import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {
  type EventEnvelope,
  newUlid,
  type WorkspaceCreated,
  type WorkspaceRemoved,
  type WorkspacesState,
  workspacesProjection,
} from '@tacet/core';
import {
  type EventStore,
  readWorkerFile,
  SAFE_GIT_ARGS,
  trustedGitEnv,
  workerWorktree,
} from '@tacet/core/node';
import { MergeConflictError, type Workspaces } from './daemon/ports.js';
import { integrateWorktree, looseCommits, taskBranch } from './git/integrate.js';
import { combineCommits } from './git/merge.js';

export interface WorktreeSetup {
  command: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
}

export interface CreateWorktreeOptions {
  setup?: WorktreeSetup;
  /**
   * A throwaway checkout (a planner's, #238): it holds nothing of value, so one a crash left
   * registered is force-removed by the next `reconcile`, and `gc` leaves it to its owner.
   */
  scratch?: boolean;
}

export interface RemoveWorktreeOptions {
  /**
   * Discard the checkout even if it holds local files or commits no other ref contains, and
   * delete its `tacet/<id>` branch. Without it, `remove` refuses rather than lose work.
   */
  force?: boolean;
  /** Keep the checkout's `tacet/<id>` branch, whatever it holds (#211: a purge keeps branches). */
  keepBranch?: boolean;
  /**
   * Commits that landed in their target (#210): the event log records the task's published result
   * as merged or squash-merged. Work they contain counts as kept, as if a branch held them. Each
   * must be a full commit id (else the worktree is kept); one not in the repository covers nothing.
   */
  landed?: readonly string[];
}

export interface WorktreeInfo {
  id: string;
  workerId: string;
  branch: string;
  branchName: string;
  path: string;
  /** The local branch the checkout started from; absent when it started at a commit. */
  baseBranch?: string;
  baseCommit: string;
  /** When it was registered (ms since the epoch). */
  createdAt: number;
  /** A throwaway checkout (#238): see `CreateWorktreeOptions.scratch`. */
  scratch?: true;
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
  /**
   * When each worktree was last used (ms since the epoch, by id), e.g. its Worker sessions' newest
   * `worker.*` event (#238). A worktree is stale once both this and its creation are older than
   * `olderThanMs`.
   */
  lastActivity?: ReadonlyMap<string, number>;
  now?: number;
}

export interface WorktreeGcResult {
  removed: string[];
  skipped: Array<{ id: string; reason: string }>;
  /** Removals git refused (also in `skipped`), with git's error: a problem, not a kept checkout. */
  failed: Array<{ id: string; message: string }>;
}

/** How long gc trusts its last "kept" verdict on an unchanged checkout (#254). */
const keptRecheckMs = 86_400_000;

/**
 * Where the worktree registry lives (#126): the Mini-conductor's event log, as `workspace.*`
 * events. The manager appends only from `create`, `remove` and `reconcile`, and only while its
 * process holds the Mini-conductor lock; `readonly` (a log opened read-only, e.g. a preview)
 * refuses those before any git command runs.
 */
export interface WorktreeLog {
  store: EventStore;
  /** Repo id stamped on events. */
  repo?: string;
  /** The Mini-conductor's id: the events' source. */
  miniId: string;
  readonly?: boolean;
}

export interface WorktreeManagerOptions {
  /**
   * The event log that holds the registry. Without one, the registry is this instance's memory:
   * nothing about worktrees is ever written to a file.
   */
  log?: WorktreeLog;
  /** PATH, HOME and setup-command variables are taken from here. Default: `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** @internal Test seam: runs once a squash's staging worktree exists, before it is filled. */
  onSquashStaging?: (ids: { source: string; staging: string }) => Promise<void>;
  /** How long a merge waits for a removal that may only be checking its worktree. Default 5 s. */
  lockWaitMs?: number;
}

/** `remove` kept the checkout: `reason` says why (also what `gc` reports). */
export class WorktreeKeptError extends Error {
  override name = 'WorktreeKeptError';
  constructor(
    readonly reason: string,
    message = reason,
  ) {
    super(message);
  }
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
/** Large enough for `status` listing an ignored dependency tree, or a big `rev-list`. */
const maxBuffer = 64 * 1024 * 1024;
const maxReflogBytes = 4 * 1024 * 1024;
const worktreeIdPattern = /^[a-z0-9-]+$/;
const commitIdPattern = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const locksDirectoryName = '.tacet-locks';
/** Longer than any merge or removal runs; a holder older than this is taken to be dead. */
const maxHoldMs = 60 * 60 * 1000;
const defaultLockWaitMs = 5_000;
/** Drafts and stale locks are only ever left by a crash once they are this old. */
const lockLitterMs = 10 * 60 * 1000;
const managerGitArgs = [
  ...SAFE_GIT_ARGS,
  '-c',
  'gc.auto=0',
  '-c',
  'maintenance.auto=false',
  // A Worker's `git replace` must not make its private commit look present in the shared store.
  '-c',
  'core.useReplaceRefs=false',
] as const;

function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs = commandTimeoutMs,
  env?: NodeJS.ProcessEnv,
  input?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
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
    if (input !== undefined) {
      child.stdin?.on('error', () => {});
      child.stdin?.end(input);
    }
  });
}

/** git's stderr can carry paths and Worker-written content: never pass it on. */
function gitFailure(error: unknown): Error {
  const failure = error as ProcessFailure;
  const code = failure.code === undefined ? '' : ` (exit ${failure.code})`;
  return new Error(`git command failed${code}`);
}

async function runGit(
  cwd: string,
  args: readonly string[],
  baseEnv: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  try {
    const env = {
      PATH: baseEnv.PATH ?? '',
      HOME: baseEnv.HOME ?? '',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_NO_REPLACE_OBJECTS: '1',
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
      baseEnv,
    );
    return await runCommand(
      'git',
      [...managerGitArgs, ...args],
      repository,
      commandTimeoutMs,
      gitEnv,
    );
  } catch (error) {
    throw gitFailure(error);
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

function processAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * A marker or lock holder is live while its process is, for at most `maxHoldMs`: after a crash
 * its PID can be reused by an unrelated process, which must not block removal forever.
 */
function holderIsLive(pid: number, modifiedMs: number): boolean {
  return (
    Number.isSafeInteger(pid) && pid > 0 && Date.now() - modifiedMs < maxHoldMs && processAlive(pid)
  );
}

/** `refs/tacet/<task>/target`, with the task id made ref-safe as `taskBranch` does (#236). */
export function targetRef(taskId: string): string {
  return `${taskBranch(taskId).replace(/^refs\/heads\/tacet\//, 'refs/tacet/')}/target`;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Git worktrees for Workers (#16), outside the repository, one detached checkout per Worker with
 * its own object store. Implements the Mini-conductor's `Workspaces` port.
 *
 * Removal never loses work unless forced: a checkout is kept while it has local or ignored files,
 * while its HEAD, its HEAD reflog or its `tacet/<id>` branch holds a commit that no other branch,
 * tag or remote-tracking ref contains, and while its private object store has a commit the shared
 * store lacks. A merge marks its source and staging worktrees busy (marker files under the
 * worktree root, shared by every manager on the repo), and removal skips busy worktrees.
 */
export class WorktreeManager implements Workspaces {
  private pathsPromise: Promise<ManagerPaths> | undefined;
  /** `git worktree add/remove/prune` lock the repository's worktree list: one at a time. */
  private worktreeQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly repositoryPath: string,
    private readonly worktreeRoot?: string,
    private readonly options: WorktreeManagerOptions = {},
  ) {}

  private get env(): Readonly<Record<string, string | undefined>> {
    return this.options.env ?? process.env;
  }

  /**
   * A fresh detached checkout for `workerId`, at `base`: a full commit id, or a local branch
   * name. Without `base`, it starts at the repository's current branch, or its HEAD commit
   * when that is detached.
   */
  async create(
    workerId: string,
    base?: string,
    options: CreateWorktreeOptions = {},
  ): Promise<WorktreeInfo> {
    return this.createWorktree(workerId, base, options, this.newId(workerId));
  }

  /**
   * Point `refs/tacet/<task>/target` at `commit` (#236): the commit a task's sub-tasks start from,
   * held so git gc never prunes it. Outside `refs/heads`, so it is no branch of the user's.
   */
  async pin(taskId: string, commit: string): Promise<void> {
    if (!commitIdPattern.test(commit)) throw new Error('pin: expected a full commit id');
    await this.git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${commit}^{commit}`]);
    await this.git(['update-ref', '--no-deref', targetRef(taskId), commit]);
  }

  /** The repo's checked-out branch (absent when HEAD is detached) and its commit (#219). */
  async head(): Promise<{ branch?: string; commit: string }> {
    const { baseBranch, baseCommit } = await this.resolveBase(undefined);
    return { ...(baseBranch !== undefined ? { branch: baseBranch } : {}), commit: baseCommit };
  }

  /** The registered checkouts that are on disk where the manager put them. */
  async list(): Promise<WorktreeInfo[]> {
    const { root } = await this.paths();
    const result: WorktreeInfo[] = [];
    for (const info of (await this.registry()).values()) {
      const expected = path.join(root, info.id);
      const actualPath = await realpath(expected).catch(() => undefined);
      if (actualPath === expected) result.push(info);
    }
    return result;
  }

  async get(worktreeId: string): Promise<WorktreeInfo | undefined> {
    if (!worktreeIdPattern.test(worktreeId)) return undefined;
    return (await this.list()).find(({ id }) => id === worktreeId);
  }

  /**
   * Remove a checkout and its `tacet/<id>` branch. Throws `WorktreeKeptError` instead when that
   * would lose work (see the class comment) or a merge is using it, unless `force` is given. An
   * id with no checkout is a no-op. For a checkout deleted by hand, the same checks run on what
   * is left (its Git admin directory and branch), then only that admin directory is deleted.
   */
  async remove(worktreeId: string, options: RemoveWorktreeOptions = {}): Promise<void> {
    this.requireWritable();
    const found = await this.registeredEntry(worktreeId);
    if (!found) return;
    await this.removeWorktree(found.info, options.force === true, found.missing, false, {
      keepBranch: options.keepBranch === true,
      landed: options.landed ?? [],
    });
  }

  /**
   * Why `remove(worktreeId)` without `force` would keep the checkout, or undefined when it would
   * remove it (or there is nothing to remove). Runs the same checks and changes nothing (#211).
   */
  async check(
    worktreeId: string,
    options: Pick<RemoveWorktreeOptions, 'landed'> = {},
  ): Promise<WorktreeKeptError | undefined> {
    const found = await this.registeredEntry(worktreeId);
    if (!found) return undefined;
    try {
      await this.removeWorktree(found.info, false, found.missing, true, {
        landed: options.landed ?? [],
      });
      return undefined;
    } catch (error) {
      if (error instanceof WorktreeKeptError) return error;
      throw error;
    }
  }

  /**
   * The branches, tags and remote-tracking refs other than the checkout's own `tacet/<id>` that
   * contain its HEAD commit: where its work lives once it is gone (#211). Empty when its HEAD
   * cannot be read or nothing else holds it.
   */
  async holders(worktreeId: string): Promise<string[]> {
    const found = await this.registeredEntry(worktreeId);
    if (!found) return [];
    let head: string;
    try {
      const gitDirectory = await this.managerWorktreeGitDirectory(found.info);
      head = readWorkerFile(path.join(gitDirectory, 'HEAD'), 512).trim();
    } catch {
      return [];
    }
    let commit: string | undefined = commitIdPattern.test(head) ? head : undefined;
    if (!commit) {
      const ref = /^ref: (refs\/heads\/[A-Za-z0-9._/-]+)$/.exec(head)?.[1];
      if (ref) commit = await this.refTip(ref);
    }
    if (!commit) return [];
    const own = taskBranch(found.info.id);
    const out = await this.git([
      'for-each-ref',
      `--contains=${commit}`,
      '--format=%(refname)',
      'refs/heads',
      'refs/tags',
      'refs/remotes',
    ]).catch(() => '');
    return out
      .split('\n')
      .map((line) => line.trim())
      .filter((ref) => ref && ref !== own);
  }

  /**
   * Every checkout this manager registered, including ones deleted by hand (`missing`), which
   * `list()` leaves out. For a full cleanup (#211).
   */
  async registered(): Promise<Array<WorktreeInfo & { missing: boolean }>> {
    const ids = new Set([...(await this.registry()).keys(), ...(await this.legacyIds())]);
    const result: Array<WorktreeInfo & { missing: boolean }> = [];
    for (const id of ids) {
      const found = await this.registeredEntry(id).catch(() => undefined);
      if (found) result.push({ ...found.info, missing: found.missing });
    }
    return result;
  }

  /**
   * Bring the registry up to date with the disk, once the Mini-conductor holds its lock (#126):
   * import each pre-#126 `.tacet-<id>.json` file as `workspace.created` (then delete the file),
   * and record as gone each registered workspace with neither its checkout nor its git admin
   * directory left (a crash around creation or removal). A checkout deleted by hand, whose admin
   * directory is still there, stays registered: `remove` checks what is left of it.
   */
  async reconcile(): Promise<void> {
    this.requireWritable();
    const { root } = await this.paths();
    for (const id of await this.legacyIds()) {
      const known = (await this.registry()).has(id) || (await this.removedIds()).has(id);
      if (!known) {
        const info = await this.readLegacy(root, id);
        // Unreadable or no longer where the manager put it: left as it is, never adopted.
        if (!info || info.path !== path.join(root, id)) continue;
        await this.record('workspace.created', {
          workspaceId: id,
          workerId: info.workerId,
          baseCommit: info.baseCommit,
          ...(info.baseBranch !== undefined ? { baseBranch: info.baseBranch } : {}),
          migrated: true,
        });
      }
      // Only once it is in the log: a crash in between leaves the file for the next start.
      await rm(this.legacyPath(root, id), { force: true });
    }
    for (const id of (await this.registry()).keys()) {
      // Being created right now: its intent is recorded and git is still at work.
      if (this.#pending.has(id)) continue;
      const left = await this.leftOnDisk(id);
      if (left === false)
        await this.record('workspace.removed', { workspaceId: id, reason: 'gone' });
    }
    // A throwaway checkout a crash left registered (#238): nothing in it is kept.
    const failed: string[] = [];
    for (const info of (await this.registry()).values()) {
      if (!info.scratch || this.#pending.has(info.id)) continue;
      await this.remove(info.id, { force: true }).catch(() => failed.push(info.id));
    }
    if (failed.length > 0) {
      throw new Error(`could not remove leftover planner checkouts: ${failed.join(', ')}`);
    }
  }

  /**
   * Whether anything of a workspace is on disk: its checkout or its git admin directory.
   * Undefined when that cannot be told (an error other than "no such file"): never "gone" then.
   */
  private async leftOnDisk(id: string): Promise<boolean | undefined> {
    const { root } = await this.paths();
    const commonDirectory = await this.commonGitDirectory();
    for (const at of [path.join(root, id), path.join(commonDirectory, 'worktrees', id)]) {
      try {
        await lstat(at);
        return true;
      } catch (error) {
        const code = errorCode(error);
        if (code !== 'ENOENT' && code !== 'ENOTDIR') return undefined;
      }
    }
    return false;
  }

  private async registeredEntry(
    worktreeId: string,
  ): Promise<{ info: WorktreeInfo; missing: boolean } | undefined> {
    if (!worktreeIdPattern.test(worktreeId)) throw new Error('invalid worktree id');
    const { root } = await this.paths();
    const info =
      (await this.registry()).get(worktreeId) ?? (await this.readLegacy(root, worktreeId));
    if (!info || info.path !== path.join(root, worktreeId)) return undefined;
    let missing = false;
    try {
      if ((await realpath(info.path)) !== info.path) {
        throw new Error('worktree path no longer resolves to its managed location');
      }
    } catch (error) {
      // Only a checkout that is really gone skips the checks that need it.
      if (errorCode(error) !== 'ENOENT') throw error;
      missing = true;
    }
    return { info, missing };
  }

  async gc(options: WorktreeGcOptions): Promise<WorktreeGcResult> {
    this.requireWritable();
    if (!Number.isSafeInteger(options.olderThanMs) || options.olderThanMs < 0) {
      throw new Error('olderThanMs must be a non-negative safe integer');
    }
    const now = options.now ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0)
      throw new Error('now must be a non-negative safe integer');
    const active = new Set(options.activeWorktreeIds ?? []);
    const result: WorktreeGcResult = { removed: [], skipped: [], failed: [] };
    await this.sweepLockLitter();
    // Every ref and its tip (#254): a kept checkout is checked again once any of them moves, its
    // own tacet/<id> branch (an integration) included.
    const refs = await this.refsDigest().catch(() => undefined);

    for (const info of await this.list()) {
      if (active.has(info.id)) {
        result.skipped.push({ id: info.id, reason: 'active' });
        continue;
      }
      // Its planner removes it; a crash leaves it to the next `reconcile` (#238).
      if (info.scratch) {
        result.skipped.push({ id: info.id, reason: 'scratch' });
        continue;
      }
      // The newest of its creation and its last use (#238): an old checkout in use is kept.
      // An unreadable time reads as now: kept.
      const at = (t: number | undefined) =>
        t === undefined || Number.isFinite(t) ? (t ?? 0) : now;
      const used = Math.max(at(info.createdAt), at(options.lastActivity?.get(info.id)));
      if (now - used < options.olderThanMs) {
        result.skipped.push({ id: info.id, reason: 'not stale' });
        continue;
      }
      // Kept last time, and nothing it could depend on changed since (#254): not checked again.
      const kept = this.#kept.get(info.id);
      if (
        kept &&
        refs !== undefined &&
        kept.used === used &&
        kept.refs === refs &&
        now - kept.at >= 0 &&
        now - kept.at < keptRecheckMs
      ) {
        result.skipped.push({ id: info.id, reason: kept.reason });
        continue;
      }
      try {
        await this.removeWorktree(info, false);
        this.#kept.delete(info.id);
        result.removed.push(info.id);
      } catch (error) {
        if (error instanceof WorktreeKeptError) {
          if (refs !== undefined) {
            this.#kept.set(info.id, { used, refs, at: now, reason: error.reason });
          }
          result.skipped.push({ id: info.id, reason: error.reason });
        } else {
          this.#kept.delete(info.id);
          result.skipped.push({ id: info.id, reason: 'Git refused to remove the worktree' });
          result.failed.push({ id: info.id, message: (error as Error).message ?? String(error) });
        }
      }
    }
    return result;
  }

  /** A digest of every ref in the repository and its tip. */
  private async refsDigest(): Promise<string> {
    const out = await this.git(['for-each-ref', '--format=%(objectname) %(refname)']);
    return createHash('sha256').update(out).digest('hex');
  }

  async checkConflicts(worktreeId: string, targetBranch: string): Promise<string[]> {
    await this.requireWorktree(worktreeId);
    await this.requireLocalBranch(targetBranch);
    const release = await this.hold([worktreeId]);
    try {
      const info = await this.requireWorktree(worktreeId);
      const workerCommit = await this.integrate(info);
      if (!workerCommit) return [];
      try {
        await this.combineWithTarget(targetBranch, workerCommit);
        return [];
      } catch (error) {
        if (error instanceof MergeConflictError) return error.files;
        throw error;
      }
    } finally {
      await release();
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

  /**
   * Bring the Worker's commits into `tacet/<id>` and combine them with `targetBranch`, without
   * touching the target. `squash-to-branch` also stages the combined tree, uncommitted, in a new
   * worktree on its own `tacet/<staging-id>` branch. The Worker's work then lives only on those
   * branches, so `remove` keeps both worktrees until it is merged elsewhere or forced away.
   */
  async merge(
    worktreeId: string,
    strategy: MergeStrategy,
    targetBranch: string,
  ): Promise<MergeResult> {
    // It integrates (writes refs and objects) and may create a staging worktree.
    this.requireWritable();
    await this.requireWorktree(worktreeId);
    await this.requireLocalBranch(targetBranch);
    const release = await this.hold([worktreeId]);
    try {
      const info = await this.requireWorktree(worktreeId);
      return await this.mergeHeld(info, strategy, targetBranch);
    } finally {
      await release();
    }
  }

  private async mergeHeld(
    info: WorktreeInfo,
    strategy: MergeStrategy,
    targetBranch: string,
  ): Promise<MergeResult> {
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

    // Marked busy before it exists, so no manager's gc can take it while it is filled.
    const stagingId = this.newId(`squash-${info.id}`);
    const releaseStaging = await this.hold([stagingId]);
    let staging: WorktreeInfo | undefined;
    try {
      staging = await this.createWorktree(`squash-${info.id}`, targetTip, {}, stagingId);
      await this.options.onSquashStaging?.({ source: info.id, staging: staging.id });
      const stagingBase = await this.worktreeHead(staging);
      if (stagingBase !== targetTip) throw new Error('target branch moved while preparing squash');
      await this.attachStagingBranch(staging, stagingBase);
      // `-u` writes the combined tree to the working tree too, not only the index.
      await this.runWorktreeGit(staging, ['read-tree', '--reset', '-u', combinedCommit]);
      return {
        strategy,
        status: 'applied',
        branchName: info.branchName,
        headSha: workerCommit,
        targetBranch,
        conflicts: [],
        resultBranchName: staging.branchName,
        resultWorktreePath: staging.path,
      };
    } catch (error) {
      // Released first, or the forced remove would refuse it as busy.
      await releaseStaging();
      if (staging) await this.remove(staging.id, { force: true }).catch(() => {});
      throw error;
    } finally {
      await releaseStaging();
    }
  }

  private newId(workerId: string): string {
    if (!workerId.trim()) throw new Error('workerId must not be empty');
    return `${workerSlug(workerId)}-${randomUUID()}`;
  }

  private async createWorktree(
    workerId: string,
    base: string | undefined,
    options: CreateWorktreeOptions,
    id: string,
  ): Promise<WorktreeInfo> {
    if (!workerId.trim()) throw new Error('workerId must not be empty');
    if (options.setup) {
      const timeoutMs = options.setup.timeoutMs ?? commandTimeoutMs;
      if (!options.setup.command.trim()) throw new Error('setup command must not be empty');
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        throw new Error('setup timeoutMs must be a positive safe integer');
      }
    }
    this.requireWritable();
    const { root } = await this.paths();
    const { baseBranch, baseCommit } = await this.resolveBase(base);

    const branchName = taskBranch(id).slice('refs/heads/'.length);
    const worktreePath = path.join(root, id);
    // Intent first: a crash from here on leaves a record that `reconcile` settles.
    this.#pending.add(id);
    try {
      return await this.makeWorktree(id, workerId, baseBranch, baseCommit, worktreePath, options);
    } finally {
      this.#pending.delete(id);
    }
  }

  private async makeWorktree(
    id: string,
    workerId: string,
    baseBranch: string | undefined,
    baseCommit: string,
    worktreePath: string,
    options: CreateWorktreeOptions,
  ): Promise<WorktreeInfo> {
    await this.record('workspace.created', {
      workspaceId: id,
      workerId,
      baseCommit,
      ...(baseBranch !== undefined ? { baseBranch } : {}),
      ...(options.scratch ? { scratch: true } : {}),
    });
    try {
      await this.worktreeGit(['worktree', 'add', '--detach', worktreePath, baseCommit]);
      const commonDirectory = await this.commonGitDirectory();
      await mkdir(path.join(commonDirectory, 'worktrees', id, 'objects'), {
        recursive: true,
        mode: 0o700,
      });
    } catch (error) {
      try {
        await this.worktreeGit(['worktree', 'remove', '--force', worktreePath]);
      } catch {
        // Keep the original error; Git may still need manual cleanup.
      }
      // Gone only if nothing of it is left: otherwise it stays registered, for remove or purge.
      if ((await this.leftOnDisk(id).catch(() => undefined)) === false) {
        await this.record('workspace.removed', { workspaceId: id, reason: 'gone' }).catch(() => {});
      }
      throw error;
    }
    const info = (await this.registry()).get(id);
    if (!info) {
      // Recorded as gone meanwhile: nothing may be left on disk that the registry does not know.
      await this.worktreeGit(['worktree', 'remove', '--force', worktreePath]).catch(() => {});
      throw new Error(`worktree ${id} is missing from the registry`);
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
          const value = this.env[name];
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

  /** A full commit id, or a local branch (default: the current one). Never an option or range. */
  private async resolveBase(
    base: string | undefined,
  ): Promise<{ baseBranch?: string; baseCommit: string }> {
    if (base !== undefined && commitIdPattern.test(base)) {
      const commit = (
        await this.git(['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`])
      ).trim();
      if (commit !== base) throw new Error('base commit does not name a commit');
      return { baseCommit: commit };
    }
    const baseBranch = base ?? (await this.currentBranch());
    if (baseBranch === undefined) {
      // A detached repository HEAD: start where it is.
      const head = await this.refTip('HEAD');
      if (!head) throw new Error('the repository HEAD is not a commit');
      return { baseCommit: head };
    }
    await this.requireLocalBranch(baseBranch);
    const baseCommit = (
      await this.git(['rev-parse', '--verify', `refs/heads/${baseBranch}^{commit}`])
    ).trim();
    return { baseBranch, baseCommit };
  }

  private async removeWorktree(
    info: WorktreeInfo,
    force: boolean,
    missing = false,
    dryRun = false,
    options: { keepBranch?: boolean; landed?: readonly string[] } = {},
  ): Promise<void> {
    const { root } = await this.paths();
    // A dry run writes nothing: no lock, and stale markers are left where they are.
    const release = dryRun ? async () => {} : await this.lockRemoval(info.id);
    try {
      if (await this.isBusy(info.id, !dryRun)) {
        throw new WorktreeKeptError('in use by a merge', 'worktree is in use by a merge');
      }
      const branchRef = taskBranch(info.id);
      const branchTip = await this.refTip(branchRef);
      // The admin directory holds the Worker's HEAD, reflog and private objects, even when the
      // checkout itself was deleted by hand.
      const gitDirectory = await this.managerWorktreeGitDirectory(info).catch((error: unknown) => {
        if (missing && errorCode(error) === 'ENOENT') return undefined;
        throw error;
      });
      if (!force && !missing) {
        let status: string;
        try {
          status = await this.runWorktreeGit(info, [
            'status',
            '--porcelain',
            '--untracked-files=all',
            '--ignored=matching',
          ]);
        } catch (error) {
          throw new WorktreeKeptError(
            'worktree Git metadata is invalid',
            error instanceof Error ? error.message : undefined,
          );
        }
        if (isDirty(status)) {
          throw new WorktreeKeptError(
            'worktree contains local or ignored files',
            'worktree contains local or ignored files; pass { force: true } to remove it',
          );
        }
      }
      if (!force) await this.ensureWorkIsKept(info, gitDirectory, branchTip, options.landed ?? []);
      if (dryRun) return;
      if (missing) {
        // Only this worktree's registration: `git worktree prune` would also prune the user's own.
        if (gitDirectory) await rm(gitDirectory, { recursive: true, force: true });
      } else {
        if (!gitDirectory) throw new Error('worktree Git directory is missing');
        await this.removeCheckout(info, gitDirectory);
      }
      // Only the tip that was checked: a branch moved since then is left alone.
      if (branchTip && !options.keepBranch) {
        await this.git(['update-ref', '-d', branchRef, branchTip]).catch(() => {});
      }
      await this.record('workspace.removed', {
        workspaceId: info.id,
        reason: force ? 'forced' : 'removed',
      });
      // A pre-#126 file for it, if it was never imported.
      await rm(this.legacyPath(root, info.id), { force: true });
    } finally {
      await release();
    }
  }

  private async removeCheckout(info: WorktreeInfo, gitDirectory: string): Promise<void> {
    {
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
      await this.worktreeGit(['worktree', 'remove', '--force', info.path]);
    }
  }

  /**
   * Throws `WorktreeKeptError` unless every commit the checkout could hold is somewhere that
   * survives its removal: its `tacet/<id>` branch, its HEAD, every commit in its HEAD reflog (best
   * effort for a Worker that writes the shared store and then moves HEAD: it relies on git having
   * written that reflog), and its private loose commits. "Survives" means contained in a branch,
   * tag or remote-tracking ref other than `tacet/<id>`. A commit it cannot find anywhere, or a
   * private store it cannot fully read, keeps the worktree. `gitDirectory` is undefined only when
   * the Worker's Git admin directory is already gone; then only the branch is checked.
   */
  private async ensureWorkIsKept(
    info: WorktreeInfo,
    gitDirectory: string | undefined,
    branchTip: string | undefined,
    landed: readonly string[] = [],
  ): Promise<void> {
    const unverifiable = (reason: string) =>
      new WorktreeKeptError(
        'unable to verify Worker commits',
        `unable to verify Worker commits: ${reason}`,
      );
    const candidates = new Set<string>();
    if (branchTip) candidates.add(branchTip);
    let privateCommits: string[] = [];

    if (gitDirectory) {
      let head: string;
      try {
        head = readWorkerFile(path.join(gitDirectory, 'HEAD'), 512).trim();
      } catch {
        throw unverifiable('the Worker HEAD cannot be read');
      }
      if (commitIdPattern.test(head)) {
        candidates.add(head);
      } else {
        const ref = /^ref: (refs\/heads\/[A-Za-z0-9._/-]+)$/.exec(head)?.[1];
        if (!ref) throw unverifiable('the Worker HEAD is neither a commit nor a branch');
        const tip = await this.refTip(ref);
        // An unborn branch has nothing to lose.
        if (tip) candidates.add(tip);
      }

      let reflog = '';
      try {
        reflog = readWorkerFile(path.join(gitDirectory, 'logs', 'HEAD'), maxReflogBytes);
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw unverifiable('the Worker reflog cannot be read');
      }
      for (const line of reflog.split('\n')) {
        const commit = /^[0-9a-f]+ ([0-9a-f]{40}(?:[0-9a-f]{24})?) /.exec(line)?.[1];
        if (commit && !/^0+$/.test(commit)) candidates.add(commit);
      }

      try {
        privateCommits = await looseCommits(
          path.join(gitDirectory, 'objects'),
          Date.now() + commandTimeoutMs,
        );
      } catch (error) {
        throw unverifiable(
          error instanceof Error ? error.message : 'the object store is unreadable',
        );
      }
    }

    // Landed commits go to `rev-list --stdin`: anything but a full commit id could be read there as
    // a revision expression or an option.
    if (landed.some((commit) => !commitIdPattern.test(commit))) {
      throw unverifiable('a landed commit is not a full commit id');
    }
    const shared = await this.commitsInSharedStore([...candidates, ...privateCommits, ...landed]);
    // One that is gone (pruned by git gc) covers nothing, and keeps nothing either.
    const covering = landed.filter((commit) => shared.has(commit));
    if (privateCommits.some((commit) => !shared.has(commit))) {
      // Integration copies only what HEAD reaches: commits left behind by an amend or a reset
      // can never be integrated, so say how to let them go.
      throw new WorktreeKeptError(
        'Worker has unintegrated private commits',
        'Worker has unintegrated private commits; integrate and merge them, or discard them with { force: true }',
      );
    }
    if ([...candidates].some((commit) => !shared.has(commit))) {
      throw unverifiable('a commit the Worker HEAD, reflog or branch names was not found');
    }
    for (const commit of privateCommits) candidates.add(commit);
    if (candidates.size === 0) return;
    // On stdin, not argv: a long reflog can name tens of thousands of commits.
    const others = (
      await this.git([
        'for-each-ref',
        '--format=%(objectname) %(refname)',
        'refs/heads',
        'refs/tags',
        'refs/remotes',
      ])
    )
      .split('\n')
      .map((line) => line.split(' '))
      // Never another `tacet/*` branch: those are removable too, and two removals that each
      // counted the other's branch would leave a commit in no ref.
      .filter(
        ([tip, ref]) => tip && commitIdPattern.test(tip) && !ref?.startsWith('refs/heads/tacet/'),
      )
      .map(([tip]) => tip as string);
    const unique = (
      await this.git(
        ['rev-list', '--max-count=1', '--stdin'],
        `${[...candidates, ...[...others, ...covering].map((tip) => `^${tip}`)].join('\n')}\n`,
      )
    ).trim();
    if (unique) {
      throw new WorktreeKeptError(
        'Worker has commits no other ref contains',
        'Worker has commits no other ref contains; merge them, or discard them with { force: true }',
      );
    }
  }

  /** Which of `commits` are commits in the shared object store (never the Worker's). */
  private async commitsInSharedStore(commits: readonly string[]): Promise<Set<string>> {
    const unique = [...new Set(commits)];
    if (unique.length === 0) return new Set();
    const out = await this.git(
      ['cat-file', '--batch-check=%(objectname) %(objecttype)'],
      `${unique.join('\n')}\n`,
    );
    const found = new Set<string>();
    for (const line of out.split('\n')) {
      const [name, type] = line.split(' ');
      if (name && type === 'commit') found.add(name);
    }
    return found;
  }

  /**
   * The commit `ref` names, or undefined. Any failure reads as "no ref": safe because a branch is
   * only ever deleted by compare-and-swap against a tip read here.
   */
  private async refTip(ref: string): Promise<string | undefined> {
    const out = await this.git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).catch(
      () => '',
    );
    const tip = out.trim();
    return commitIdPattern.test(tip) ? tip : undefined;
  }

  private async locksDirectory(): Promise<string> {
    const { root } = await this.paths();
    const directory = path.join(root, locksDirectoryName);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return directory;
  }

  /**
   * Mark worktrees busy for an operation, across every manager on the repository: a marker file
   * per worktree, written before checking that none is being removed. Removal takes its lock
   * before checking for markers, so one of the two always sees the other.
   */
  private async hold(ids: readonly string[]): Promise<() => Promise<void>> {
    const directory = await this.locksDirectory();
    const markers: string[] = [];
    const release = async () => {
      const taken = markers.splice(0);
      await Promise.all(taken.map((marker) => rm(marker, { force: true })));
    };
    try {
      for (const id of ids) {
        const marker = path.join(directory, `${id}.busy.${process.pid}.${randomUUID()}`);
        await writeFile(marker, '', { flag: 'wx', mode: 0o600 });
        markers.push(marker);
      }
      // A removal may only be checking the worktree and then keep it: wait a little for it.
      for (const id of ids) {
        const deadline = Date.now() + (this.options.lockWaitMs ?? defaultLockWaitMs);
        let delay = 50;
        while (await this.removalLocked(directory, id)) {
          if (Date.now() >= deadline) throw new Error('worktree is being removed');
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay = Math.min(delay * 2, 1_000);
        }
      }
    } catch (error) {
      await release();
      throw error;
    }
    return release;
  }

  /** Lock drafts and stale locks moved aside, left behind by a manager that crashed. */
  private async sweepLockLitter(): Promise<void> {
    const directory = await this.locksDirectory();
    for (const name of await readdir(directory)) {
      if (!/\.(draft|stale)\.[0-9a-f-]+$/.test(name)) continue;
      const file = path.join(directory, name);
      const modified = (await stat(file).catch(() => undefined))?.mtimeMs;
      if (modified !== undefined && Date.now() - modified > lockLitterMs) {
        await rm(file, { force: true });
      }
    }
  }

  private async isBusy(id: string, sweep = true): Promise<boolean> {
    const { root } = await this.paths();
    const directory = path.join(root, locksDirectoryName);
    if (!sweep && !(await stat(directory).catch(() => undefined))) return false;
    if (sweep) await this.locksDirectory();
    const prefix = `${id}.busy.`;
    for (const name of await readdir(directory)) {
      if (!name.startsWith(prefix)) continue;
      const marker = path.join(directory, name);
      const pid = Number(name.slice(prefix.length).split('.')[0]);
      const modified = (await stat(marker).catch(() => undefined))?.mtimeMs;
      if (modified === undefined) continue;
      if (holderIsLive(pid, modified)) return true;
      // Left by a manager that died mid-merge.
      if (sweep) await rm(marker, { force: true });
    }
    return false;
  }

  /**
   * The removal lock's contents, `<pid> <token>`, or undefined when there is none. A lock is only
   * ever made by linking a complete file into place, so it is never seen empty; one that does not
   * parse anyway counts as stale.
   */
  private async readRemovalLock(lock: string): Promise<string | undefined> {
    try {
      return await readFile(lock, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async lockIsLive(lock: string, contents: string): Promise<boolean> {
    const pid = Number(/^(\d+) [0-9a-f-]+\n$/.exec(contents)?.[1]);
    const modified = (await stat(lock).catch(() => undefined))?.mtimeMs;
    return modified !== undefined && holderIsLive(pid, modified);
  }

  private async removalLocked(directory: string, id: string): Promise<boolean> {
    const lock = path.join(directory, `${id}.removing`);
    const contents = await this.readRemovalLock(lock);
    return contents !== undefined && (await this.lockIsLive(lock, contents));
  }

  private async lockRemoval(id: string): Promise<() => Promise<void>> {
    const directory = await this.locksDirectory();
    const lock = path.join(directory, `${id}.removing`);
    const mine = `${process.pid} ${randomUUID()}\n`;
    const draft = path.join(directory, `${id}.draft.${randomUUID()}`);
    await writeFile(draft, mine, { flag: 'wx', mode: 0o600 });
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await link(draft, lock);
          // Deletes the lock only while it is still this one.
          return async () => {
            if ((await this.readRemovalLock(lock)) === mine) await rm(lock, { force: true });
          };
        } catch (error) {
          if (errorCode(error) !== 'EEXIST') throw error;
        }
        const seen = await this.readRemovalLock(lock);
        if (seen === undefined) continue;
        if (await this.lockIsLive(lock, seen)) break;
        // Left by a process that died: move it aside, and put it back if another manager
        // replaced it with a live lock in the meantime.
        const aside = path.join(directory, `${id}.stale.${randomUUID()}`);
        try {
          await rename(lock, aside);
        } catch (error) {
          if (errorCode(error) === 'ENOENT') continue;
          throw error;
        }
        if ((await this.readRemovalLock(aside)) !== seen) {
          await link(aside, lock).catch(() => {});
        }
        await rm(aside, { force: true });
      }
    } finally {
      await rm(draft, { force: true });
    }
    throw new WorktreeKeptError(
      'being removed',
      `worktree is already being removed (lock ${lock}; delete it if no Tacet process holds it)`,
    );
  }

  private async paths(): Promise<ManagerPaths> {
    if (this.pathsPromise) return this.pathsPromise;
    const pathsPromise = (async () => {
      const repository = await realpath(
        (await runGit(this.repositoryPath, ['rev-parse', '--show-toplevel'], this.env)).trim(),
      );
      const commonDirectory = await realpath(
        (
          await runGit(
            repository,
            ['rev-parse', '--path-format=absolute', '--git-common-dir'],
            this.env,
          )
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

  private worktreeGit(args: readonly string[]): Promise<string> {
    const next = this.worktreeQueue.then(() => this.git(args));
    this.worktreeQueue = next.catch(() => {});
    return next;
  }

  private async git(args: readonly string[], input?: string): Promise<string> {
    const { repository, commonDirectory } = await this.paths();
    const env = trustedGitEnv(
      repository,
      { gitDir: commonDirectory, commonDir: commonDirectory },
      this.env,
    );
    try {
      return await runCommand(
        'git',
        [...managerGitArgs, ...args],
        repository,
        commandTimeoutMs,
        {
          ...env,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_NO_REPLACE_OBJECTS: '1',
        },
        input,
      );
    } catch (error) {
      throw gitFailure(error);
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
    try {
      return await runCommand('git', [...managerGitArgs, ...args], repository, commandTimeoutMs, {
        ...trustedGitEnv(info.path, worktree, this.env),
        GIT_NO_REPLACE_OBJECTS: '1',
      });
    } catch (error) {
      throw gitFailure(error);
    }
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

  private async worktreeHead(info: WorktreeInfo): Promise<string> {
    return (await this.runWorktreeGit(info, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  }

  private async commonGitDirectory(): Promise<string> {
    return (await this.paths()).commonDirectory;
  }

  /** The checked-out branch, or undefined when the repository HEAD is detached. */
  private async currentBranch(): Promise<string | undefined> {
    let branch: string;
    try {
      branch = (await this.git(['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim();
    } catch (error) {
      // `--quiet` exits 1, and only 1, for a detached HEAD.
      if (error instanceof Error && error.message.endsWith('(exit 1)')) return undefined;
      throw error;
    }
    return branch || undefined;
  }

  private async requireLocalBranch(branch: string): Promise<void> {
    await this.git(['check-ref-format', '--branch', branch]);
    await this.git(['rev-parse', '--verify', `refs/heads/${branch}^{commit}`]);
  }

  // ---- the registry (#126) -----------------------------------------------------------------

  /** In-memory registry, when there is no event log: never written anywhere. */
  readonly #memory = new Map<string, WorktreeInfo>();
  /** gc's last "kept" verdicts (#254): by id, with what they depended on. */
  readonly #kept = new Map<string, { used: number; refs: string; at: number; reason: string }>();
  readonly #memoryRemoved = new Set<string>();
  #view: { seq: number; state: WorkspacesState } | undefined;
  /** Ids between their recorded intent and the end of `git worktree add`: never reconciled. */
  readonly #pending = new Set<string>();

  private requireWritable(): void {
    if (this.options.log?.readonly) {
      throw new Error(
        'the worktree registry was opened read-only: nothing can be created or removed',
      );
    }
  }

  private workspacesState(): WorkspacesState | undefined {
    const log = this.options.log;
    if (!log) return undefined;
    // Folded on from the last event seen: `workspace.*` is never compacted, so this stays exact.
    let view = this.#view ?? { seq: 0, state: workspacesProjection.initial() };
    const fresh = log.store.query({ typePrefix: 'workspace', afterSeq: view.seq });
    if (fresh.length > 0 || !this.#view) {
      let state = view.state;
      for (const e of fresh) state = workspacesProjection.apply(state, e.envelope);
      view = { seq: fresh.at(-1)?.seq ?? view.seq, state };
      this.#view = view;
    }
    return view.state;
  }

  /** Every registered workspace, by id, in creation order. */
  private async registry(): Promise<Map<string, WorktreeInfo>> {
    const state = this.workspacesState();
    if (!state) return new Map(this.#memory);
    const { root } = await this.paths();
    const branchOf = (id: string) => taskBranch(id).slice('refs/heads/'.length);
    return new Map(
      Object.values(state.live)
        .filter((w) => worktreeIdPattern.test(w.workspaceId))
        .map((w) => [
          w.workspaceId,
          {
            id: w.workspaceId,
            workerId: w.workerId,
            branch: branchOf(w.workspaceId),
            branchName: branchOf(w.workspaceId),
            path: path.join(root, w.workspaceId),
            ...(w.baseBranch !== undefined ? { baseBranch: w.baseBranch } : {}),
            baseCommit: w.baseCommit,
            createdAt: Date.parse(w.createdAt),
            ...(w.scratch ? { scratch: true as const } : {}),
          },
        ]),
    );
  }

  private async removedIds(): Promise<Set<string>> {
    const state = this.workspacesState();
    return state ? new Set(Object.keys(state.removed)) : new Set(this.#memoryRemoved);
  }

  private async record(
    ...[type, data]:
      | ['workspace.created', WorkspaceCreated]
      | ['workspace.removed', WorkspaceRemoved]
  ): Promise<void> {
    const log = this.options.log;
    const id = data.workspaceId;
    if (!log) {
      if (type === 'workspace.created') {
        if (this.#memoryRemoved.has(id) || this.#memory.has(id)) return;
        const { root } = await this.paths();
        const branchName = taskBranch(id).slice('refs/heads/'.length);
        const created = data as WorkspaceCreated;
        this.#memory.set(id, {
          id,
          workerId: created.workerId,
          branch: branchName,
          branchName,
          path: path.join(root, id),
          ...(created.baseBranch !== undefined ? { baseBranch: created.baseBranch } : {}),
          baseCommit: created.baseCommit,
          createdAt: Date.now(),
          ...(created.scratch ? { scratch: true as const } : {}),
        });
      } else {
        this.#memory.delete(id);
        this.#memoryRemoved.add(id);
      }
      return;
    }
    this.requireWritable();
    const now = new Date();
    const envelope: EventEnvelope = {
      v: 1,
      id: newUlid(now.getTime()),
      ts: now.toISOString(),
      source: { kind: 'mini', id: log.miniId },
      ...(log.repo !== undefined ? { repo: log.repo } : {}),
      type,
      data,
    };
    log.store.append(envelope);
  }

  // ---- pre-#126 registry files: read to migrate or clean up, never written ------------------

  private legacyPath(root: string, id: string): string {
    if (!worktreeIdPattern.test(id)) throw new Error('invalid worktree id');
    return path.join(root, `.tacet-${id}.json`);
  }

  private async legacyIds(): Promise<string[]> {
    const { root } = await this.paths();
    const ids: string[] = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const id = /^\.tacet-([a-z0-9-]+)\.json$/.exec(entry.name)?.[1];
      if (entry.isFile() && id && worktreeIdPattern.test(id)) ids.push(id);
    }
    return ids;
  }

  private async readLegacy(root: string, id: string): Promise<WorktreeInfo | undefined> {
    try {
      const info = JSON.parse(await readFile(this.legacyPath(root, id), 'utf8')) as WorktreeInfo;
      if (
        info.id !== id ||
        typeof info.workerId !== 'string' ||
        typeof info.path !== 'string' ||
        (info.baseBranch !== undefined && typeof info.baseBranch !== 'string') ||
        typeof info.baseCommit !== 'string' ||
        !commitIdPattern.test(info.baseCommit) ||
        !Number.isSafeInteger(info.createdAt)
      ) {
        return undefined;
      }
      const branchName = taskBranch(id).slice('refs/heads/'.length);
      return {
        id,
        workerId: info.workerId,
        branch: branchName,
        branchName,
        path: info.path,
        ...(info.baseBranch !== undefined ? { baseBranch: info.baseBranch } : {}),
        baseCommit: info.baseCommit,
        createdAt: info.createdAt,
      };
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
