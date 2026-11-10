import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { SAFE_GIT_ARGS } from '@tacet/core/node';

const COMMIT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const BRANCH_REF = /^refs\/heads\/[A-Za-z0-9._/-]+$/;

export interface DetectLandedOptions {
  /** The repo's main checkout. Only its own object store and refs are read; nothing is fetched. */
  repoRoot: string;
  /** The task's published result commit. */
  commit: string;
  /** The branch it should land in, `refs/heads/<branch>`. */
  target: string;
  /** PATH and HOME are taken from here; nothing else. */
  env?: Record<string, string | undefined>;
  /** At most this many target commits after the fork point are compared. Default 1000. */
  maxScan?: number;
  timeoutMs?: number;
}

export interface Landed {
  how: 'merge' | 'squash';
  /** For a squash merge: the target commit that makes the same change. */
  landedAs?: string;
}

/**
 * Whether a task's published result has landed in `target` (#210), from the repo's own refs and
 * objects only (never a fetch, which would use the user's credentials and the network):
 * - merge: `target` contains the commit;
 * - squash: one of the newest `maxScan` non-merge commits on `target` since the fork point
 *   (`merge-base target commit`) has the same `git patch-id --stable` as the whole change from the
 *   fork point to the commit.
 * A result with no change of its own, a rebase merge (several commits), or a branch that is
 * missing reads as not landed, so the worktree is kept. Throws only on a bad argument.
 */
export async function detectLanded(o: DetectLandedOptions): Promise<Landed | undefined> {
  if (!COMMIT_ID.test(o.commit)) throw new Error('detectLanded: commit must be a full commit id');
  if (!BRANCH_REF.test(o.target) || o.target.includes('..')) {
    throw new Error('detectLanded: target must be a branch ref');
  }
  const maxScan = o.maxScan ?? 1000;
  if (!Number.isSafeInteger(maxScan) || maxScan <= 0) {
    throw new Error('detectLanded: maxScan must be a positive integer');
  }
  const git = repoGit(o);
  const tip = (
    await git(['rev-parse', '--verify', '--quiet', `${o.target}^{commit}`]).catch(() => '')
  ).trim();
  if (!COMMIT_ID.test(tip)) return undefined;
  if ((await git(['cat-file', '-t', o.commit]).catch(() => '')).trim() !== 'commit') {
    return undefined;
  }
  if (
    await git(['merge-base', '--is-ancestor', o.commit, tip]).then(
      () => true,
      () => false,
    )
  ) {
    return { how: 'merge' };
  }
  const forkPoint = (await git(['merge-base', tip, o.commit]).catch(() => '')).trim();
  if (!COMMIT_ID.test(forkPoint)) return undefined;

  const ours = patchIds(
    await git(
      ['patch-id', '--stable'],
      await git(['diff-tree', '-p', '--no-color', '--no-ext-diff', forkPoint, o.commit]),
    ),
  );
  const wanted = ours[0]?.patchId;
  // An empty change has no patch-id: nothing to find.
  if (!wanted) return undefined;
  let theirs: Array<{ patchId: string; commit: string }>;
  try {
    const log = await git([
      'log',
      '-p',
      '--no-color',
      '--no-ext-diff',
      '--no-merges',
      `--max-count=${maxScan}`,
      '--format=commit %H',
      `${forkPoint}..${tip}`,
    ]);
    theirs = patchIds(await git(['patch-id', '--stable'], log));
  } catch {
    // Too much history to compare within the limits: not known to have landed.
    return undefined;
  }
  const match = theirs.find(({ patchId }) => patchId === wanted);
  return match ? { how: 'squash', landedAs: match.commit } : undefined;
}

function patchIds(out: string): Array<{ patchId: string; commit: string }> {
  const ids: Array<{ patchId: string; commit: string }> = [];
  for (const line of out.split('\n')) {
    const [patchId, commit] = line.trim().split(' ');
    if (patchId && commit && COMMIT_ID.test(patchId) && COMMIT_ID.test(commit)) {
      ids.push({ patchId, commit });
    }
  }
  return ids;
}

/** Git in the main repo only, as `combineCommits` runs it, plus stdin and no replace refs. */
function repoGit(o: DetectLandedOptions) {
  const env = o.env ?? process.env;
  const gitEnv: Record<string, string> = {
    ...(env.PATH !== undefined ? { PATH: env.PATH } : {}),
    ...(env.HOME !== undefined ? { HOME: env.HOME } : {}),
    GIT_DIR: join(o.repoRoot, '.git'),
    GIT_NO_REPLACE_OBJECTS: '1',
  };
  return (args: string[], input?: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const child = execFile(
        'git',
        [...SAFE_GIT_ARGS, '-c', 'core.useReplaceRefs=false', ...args],
        {
          cwd: o.repoRoot,
          env: gitEnv,
          timeout: o.timeoutMs ?? 60_000,
          maxBuffer: 64 * 1024 * 1024,
          encoding: 'utf8',
        },
        (error, stdout) => {
          // Never git's stderr: it can carry paths.
          if (error) reject(new Error(`git ${args[0]} failed`));
          else resolve(stdout);
        },
      );
      child.stdin?.on('error', () => {});
      child.stdin?.end(input ?? '');
    });
}
