import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { SAFE_GIT_ARGS } from '@tacet/core/node';

const COMMIT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/** A branch ref: no whitespace or characters git refuses in a ref, never `..` or `@{`. */
const BRANCH_REF = /^refs\/heads\/[^\s~^:?*[\\]+$/;

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
 * A result with no change of its own, a rebase merge (several commits), a branch that is missing,
 * a partial clone (diffing would fetch), or any git failure reads as not landed, so the worktree
 * is kept. Throws only on a bad argument.
 */
export async function detectLanded(o: DetectLandedOptions): Promise<Landed | undefined> {
  if (!COMMIT_ID.test(o.commit)) throw new Error('detectLanded: commit must be a full commit id');
  if (!BRANCH_REF.test(o.target) || o.target.includes('..') || o.target.includes('@{')) {
    throw new Error('detectLanded: target must be a branch ref');
  }
  const maxScan = o.maxScan ?? 1000;
  if (!Number.isSafeInteger(maxScan) || maxScan <= 0) {
    throw new Error('detectLanded: maxScan must be a positive integer');
  }
  try {
    return await detect(o, maxScan);
  } catch {
    // A git failure (a timeout, too much output): not known to have landed, so kept.
    return undefined;
  }
}

/** The commit `target` points at in the repo, or undefined. Cheap: for caching a negative. */
export async function branchTip(
  o: Pick<DetectLandedOptions, 'repoRoot' | 'target' | 'env' | 'timeoutMs'>,
): Promise<string | undefined> {
  if (!BRANCH_REF.test(o.target) || o.target.includes('..') || o.target.includes('@{')) {
    return undefined;
  }
  const tip = (
    await repoGit(o)(['rev-parse', '--verify', '--quiet', `${o.target}^{commit}`]).catch(() => '')
  ).trim();
  return COMMIT_ID.test(tip) ? tip : undefined;
}

async function detect(o: DetectLandedOptions, maxScan: number): Promise<Landed | undefined> {
  const git = repoGit(o);
  // A partial clone fetches missing objects on demand while diffing: never from here.
  if (await isPartialClone(git)) return undefined;
  const tip = await branchTip(o);
  if (!tip) return undefined;
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
      await git(['diff-tree', '-p', ...DIFF_ARGS, forkPoint, o.commit]),
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
      ...DIFF_ARGS,
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

/**
 * Whether `later` replaces `earlier` as an amend does (#210): both are commits of the repo with the
 * same first parent, so `later` is a new version of the same work, not unrelated work after a
 * reset. False on any doubt.
 */
export async function isReplacement(
  o: Pick<DetectLandedOptions, 'repoRoot' | 'env' | 'timeoutMs'>,
  earlier: string,
  later: string,
): Promise<boolean> {
  if (!COMMIT_ID.test(earlier) || !COMMIT_ID.test(later) || earlier === later) return false;
  const git = repoGit(o);
  const parent = async (commit: string) =>
    (await git(['rev-parse', '--verify', '--quiet', `${commit}^1`]).catch(() => '')).trim();
  const [a, b] = await Promise.all([parent(earlier), parent(later)]);
  return COMMIT_ID.test(a) && a === b;
}

/**
 * The same diff options on both sides, so a patch-id compares like with like: no rename detection
 * (on by default for `log`, never for `diff-tree`), no textconv or external diff.
 */
const DIFF_ARGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-renames'] as const;

async function isPartialClone(git: (args: string[]) => Promise<string>): Promise<boolean> {
  const partial = await git(['config', '--get', 'extensions.partialClone']).catch(() => '');
  if (partial.trim()) return true;
  const promisors = await git([
    'config',
    '--type=bool',
    '--get-regexp',
    '^remote\\..*\\.promisor$',
  ]).catch(() => '');
  return promisors.split('\n').some((line) => line.trim().endsWith(' true'));
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
function repoGit(o: Pick<DetectLandedOptions, 'repoRoot' | 'env' | 'timeoutMs'>) {
  const env = o.env ?? process.env;
  const gitEnv: Record<string, string> = {
    ...(env.PATH !== undefined ? { PATH: env.PATH } : {}),
    ...(env.HOME !== undefined ? { HOME: env.HOME } : {}),
    GIT_DIR: join(o.repoRoot, '.git'),
    GIT_NO_REPLACE_OBJECTS: '1',
    // Only the repo's own config: the user's could switch on renames, textconv or a pager.
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    // Belt and braces next to the partial-clone check; git versions that do not know it ignore it.
    GIT_NO_LAZY_FETCH: '1',
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
