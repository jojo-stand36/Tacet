import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { SAFE_GIT_ARGS } from '@tacet/core/node';
import { MergeConflictError } from '../daemon/ports.js';

export { MergeConflictError };

const exec = promisify(execFile);
const COMMIT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const TASK_REF_PREFIX = 'refs/heads/tacet/';

/**
 * Who the Mini-conductor's own merge commits are by: they combine Workers' commits and are made
 * by Tacet, not by the user, so the user's git identity is not borrowed for them.
 */
const IDENTITY = {
  GIT_AUTHOR_NAME: 'Tacet Mini-conductor',
  GIT_AUTHOR_EMAIL: 'mini-conductor@tacet.invalid',
  GIT_COMMITTER_NAME: 'Tacet Mini-conductor',
  GIT_COMMITTER_EMAIL: 'mini-conductor@tacet.invalid',
};

export interface RepoGitOptions {
  /** The repo's main checkout. */
  repoRoot: string;
  /** PATH and HOME are taken from here; nothing else. */
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

interface GitResult {
  code: number;
  stdout: string;
}

/**
 * Git in the main repo only (#134): everything here works on commits already in the repo's own
 * object store (integrated and checked by `integrateWorktree`), never in a Worker's checkout.
 * Still run without hooks or config surprises: `SAFE_GIT_ARGS`, only PATH and HOME.
 */
function repoGit(o: RepoGitOptions) {
  const env = o.env ?? process.env;
  const gitEnv: Record<string, string> = {
    ...(env.PATH !== undefined ? { PATH: env.PATH } : {}),
    ...(env.HOME !== undefined ? { HOME: env.HOME } : {}),
    GIT_DIR: join(o.repoRoot, '.git'),
    ...IDENTITY,
  };
  return async (args: string[], okCodes: readonly number[] = [0]): Promise<GitResult> => {
    try {
      const { stdout } = await exec('git', [...SAFE_GIT_ARGS, ...args], {
        cwd: o.repoRoot,
        env: gitEnv,
        timeout: o.timeoutMs ?? 60_000,
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8',
      });
      return { code: 0, stdout: stdout.trim() };
    } catch (err) {
      const e = err as { code?: unknown; stdout?: string; stderr?: string; killed?: boolean };
      if (typeof e.code === 'number' && okCodes.includes(e.code)) {
        return { code: e.code, stdout: (e.stdout ?? '').trim() };
      }
      const why = e.killed ? 'timed out' : (e.stderr ?? String(err)).trim().slice(0, 500);
      throw new Error(`git ${args.slice(0, 3).join(' ')}: ${why}`);
    }
  };
}

/**
 * One commit with the work of every commit given (#134). None gives undefined; commits that
 * another one already contains are dropped, so one left is returned as it is; several are merged
 * in order with `git merge-tree --write-tree` (git 2.38 or later) and `commit-tree`, without a
 * checkout. Throws `MergeConflictError` naming the conflicting files.
 */
export async function combineCommits(
  commits: readonly string[],
  o: RepoGitOptions,
): Promise<string | undefined> {
  const unique = [...new Set(commits)];
  for (const c of unique) {
    if (!COMMIT_ID.test(c)) throw new Error(`not a commit id: ${c.slice(0, 80)}`);
  }
  if (unique.length === 0) return undefined;
  const git = repoGit(o);
  for (const c of unique) await git(['cat-file', '-e', `${c}^{commit}`]);
  if (unique.length === 1) return unique[0];
  // Keep the given order among the commits no other one contains.
  const independent = new Set(
    (await git(['merge-base', '--independent', ...unique])).stdout.split('\n').filter(Boolean),
  );
  const tips = unique.filter((c) => independent.has(c));
  let head = tips[0] as string;
  for (const next of tips.slice(1)) {
    const merged = await git(
      ['merge-tree', '--write-tree', '--name-only', '--no-messages', head, next],
      [1],
    );
    const [tree = '', ...files] = merged.stdout.split('\n').filter(Boolean);
    if (merged.code === 1) {
      throw new MergeConflictError(`${head.slice(0, 12)} and ${next.slice(0, 12)} conflict`, [
        ...new Set(files),
      ]);
    }
    head = (
      await git([
        'commit-tree',
        tree,
        '-p',
        head,
        '-p',
        next,
        '-m',
        `tacet: combine ${head.slice(0, 12)} and ${next.slice(0, 12)}`,
      ])
    ).stdout;
  }
  return head;
}

/**
 * Point `ref` (only under `refs/heads/tacet/`) at `commit`, as a compare-and-swap from what it
 * was when read. Returns false when it already pointed there.
 */
export async function setTaskBranch(
  ref: string,
  commit: string,
  o: RepoGitOptions,
): Promise<boolean> {
  if (!ref.startsWith(TASK_REF_PREFIX)) {
    throw new Error(`only branches under ${TASK_REF_PREFIX} are written`);
  }
  if (!COMMIT_ID.test(commit)) throw new Error(`not a commit id: ${commit.slice(0, 80)}`);
  const git = repoGit(o);
  await git(['check-ref-format', ref]);
  const current = (await git(['rev-parse', '--verify', '-q', ref], [1])).stdout;
  if (current === commit) return false;
  await git(['update-ref', '--no-deref', ref, commit, current || '0'.repeat(commit.length)]);
  return true;
}
