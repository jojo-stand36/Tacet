import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Safe handling of a Worker's git worktree from outside its sandbox (#116, #119). Everything in
 * the worktree and its git dir is written by the Worker and so untrusted: these helpers check it
 * against the trusted repo root and run git so that nothing the Worker wrote is loaded as config,
 * hooks or a different repository.
 */

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A linked worktree's own git dir and the repo's shared one, both canonical. */
export interface WorkerWorktree {
  gitDir: string;
  commonDir: string;
}

const real = (p: string): string => realpathSync.native(p);

/**
 * Read a small file the Worker may have written, safely: never through a symlink, never blocking
 * (a FIFO), only a regular file (checked on the open descriptor, so it cannot be swapped between
 * the check and the read), and at most `maxBytes`.
 */
export function readWorkerFile(file: string, maxBytes = 4096): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${file} is not a regular file`);
    if (st.size > maxBytes) throw new Error(`${file} is larger than ${maxBytes} bytes`);
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function readPointer(file: string, prefix: string): string {
  const text = readWorkerFile(file).trim();
  return text.startsWith(prefix) ? text.slice(prefix.length).trim() : text;
}

/**
 * The linked worktree of `repoRoot` checked out at `cwd`, or undefined when `cwd` is the main
 * worktree or not a git checkout. The Worker can rewrite `<cwd>/.git` and its git dir (#116
 * review): a forged `commondir` would make a later git command outside the sandbox load config
 * and hooks the Worker wrote. So nothing is taken from git; the pointer files are read and must
 * agree with the trusted repo root, and a `config.worktree` is refused. Throws when they do not.
 */
export function workerWorktree(cwd: string, repoRoot: string): WorkerWorktree | undefined {
  try {
    return checkWorktree(cwd, repoRoot);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('refusing worktree')) throw err;
    throw new Error(`refusing worktree ${cwd}: ${errorMessage(err)}`);
  }
}

function checkWorktree(cwd: string, repoRoot: string): WorkerWorktree | undefined {
  const dotGit = join(cwd, '.git');
  if (!existsSync(dotGit)) return undefined;
  const commonDir = real(join(repoRoot, '.git'));
  const fail = (why: string): never => {
    throw new Error(`refusing worktree ${cwd}: ${why}`);
  };
  if (!lstatSync(commonDir).isDirectory()) fail(`${commonDir} is not a git directory`);
  if (lstatSync(dotGit).isDirectory()) {
    if (real(cwd) === real(repoRoot)) return undefined;
    fail(`it is a separate git repository, not a worktree of ${repoRoot}`);
  }
  const gitDir = real(resolve(cwd, readPointer(dotGit, 'gitdir:')));
  if (dirname(gitDir) !== join(commonDir, 'worktrees')) fail('its git dir is outside the repo');
  if (lstatSync(gitDir).isSymbolicLink() || !lstatSync(gitDir).isDirectory()) {
    fail('its git dir is not a directory');
  }
  if (real(resolve(gitDir, readPointer(join(gitDir, 'commondir'), ''))) !== commonDir) {
    fail('its commondir does not point at the repo');
  }
  if (real(resolve(gitDir, readPointer(join(gitDir, 'gitdir'), ''))) !== real(dotGit)) {
    fail('its git dir does not point back at it');
  }
  if (existsSync(join(gitDir, 'config.worktree'))) fail('it has a config.worktree');
  // With this extension git reads `<git dir>/config.worktree`, which the Worker can write at any
  // time (e.g. `core.sshCommand`), so no git run outside the sandbox would be safe.
  if (worktreeConfigEnabled(commonDir)) {
    fail('the repo sets extensions.worktreeConfig (e.g. sparse-checkout), not supported yet');
  }
  return { gitDir, commonDir };
}

/**
 * Git environment of an unattended Worker in `wt` (#116): new objects go to the worktree's own
 * git dir, existing ones are read from the repo's shared store. Git run outside the sandbox on
 * the worktree (the Mini-conductor's integration) uses `trustedGitEnv` and `SAFE_GIT_ARGS` after
 * checking the worktree again with `workerWorktree`.
 */
export function workerGitEnv(wt: WorkerWorktree): Record<string, string> {
  return {
    GIT_OBJECT_DIRECTORY: join(wt.gitDir, 'objects'),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(wt.commonDir, 'objects'),
  };
}

/**
 * For git commands run outside the sandbox on a Worker's worktree: no hooks, no fsmonitor, no
 * reflog writes (the Worker could symlink `logs/HEAD` at any file), no commit-graph from the
 * Worker's object store.
 */
export const SAFE_GIT_ARGS = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.logAllRefUpdates=false',
  '-c',
  'core.commitGraph=false',
] as const;

/**
 * Environment for a git command run outside the sandbox on a Worker's worktree: only PATH and
 * HOME from `env`, the Worker's object store, and the git dirs given explicitly. `GIT_COMMON_DIR`
 * makes git ignore the worktree's `commondir` file, which the Worker could rewrite between the
 * `workerWorktree` check and the command.
 */
export function trustedGitEnv(
  cwd: string,
  wt: WorkerWorktree,
  env: Record<string, string | undefined>,
): Record<string, string> {
  return {
    ...(env.PATH !== undefined ? { PATH: env.PATH } : {}),
    ...(env.HOME !== undefined ? { HOME: env.HOME } : {}),
    ...workerGitEnv(wt),
    GIT_DIR: wt.gitDir,
    GIT_COMMON_DIR: wt.commonDir,
    GIT_WORK_TREE: cwd,
  };
}

/** `extensions.worktreeConfig` from the repo's own (trusted) config file. */
function worktreeConfigEnabled(commonDir: string): boolean {
  try {
    const out = execFileSync(
      'git',
      [
        'config',
        '--file',
        join(commonDir, 'config'),
        '--type=bool',
        '--get',
        'extensions.worktreeConfig',
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { PATH: process.env.PATH ?? '' },
      },
    ).trim();
    return out === 'true';
  } catch {
    // Exit 1: not set.
    return false;
  }
}
