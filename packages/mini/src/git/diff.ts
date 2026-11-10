import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { SAFE_GIT_ARGS } from '@tacet/core/node';

const COMMIT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export interface ReviewDiffOptions {
  /** The repo's main checkout: the diff is read from its object store, never a Worker's. */
  repoRoot: string;
  /** PATH and HOME are taken from here; nothing else is passed to git. */
  env?: Record<string, string | undefined>;
  /** Most bytes of patch kept. Default 64 KiB. */
  maxBytes?: number;
  timeoutMs?: number;
}

export interface ReviewDiff {
  /** The commit the diff starts from. */
  base: string;
  /** `git diff --stat`: every file changed, even when the patch is cut. */
  stat: string;
  patch: string;
  /** The patch was longer than `maxBytes` and was cut. */
  truncated: boolean;
}

function git(
  o: ReviewDiffOptions,
  args: string[],
  maxBuffer: number,
): Promise<{ stdout: string; truncated: boolean }> {
  const env = o.env ?? process.env;
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...SAFE_GIT_ARGS, ...args],
      {
        cwd: o.repoRoot,
        env: {
          ...(env.PATH !== undefined ? { PATH: env.PATH } : {}),
          ...(env.HOME !== undefined ? { HOME: env.HOME } : {}),
          GIT_DIR: join(o.repoRoot, '.git'),
        },
        timeout: o.timeoutMs ?? 60_000,
        maxBuffer,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
        // Longer than wanted: what came first is kept, and said to be cut.
        if (e?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          return resolve({ stdout, truncated: true });
        }
        if (e) {
          const why = e.killed
            ? 'timed out'
            : String(stderr || e.message)
                .trim()
                .slice(0, 300);
          return reject(new Error(`git ${args[0]}: ${why}`));
        }
        resolve({ stdout, truncated: false });
      },
    );
  });
}

/**
 * The change a reviewer judges (#19): `base..commit`, read in the main repo from commits already
 * integrated and checked (#119), without hooks, external diff drivers or textconv filters, so no
 * program the repo or a Worker names runs. Without a `base` (the checkout started at the main
 * branch), the diff starts where `commit` left the main checkout's HEAD.
 */
export async function reviewDiff(
  commit: string,
  base: string | undefined,
  o: ReviewDiffOptions,
): Promise<ReviewDiff> {
  if (!COMMIT_ID.test(commit) || (base !== undefined && !COMMIT_ID.test(base))) {
    throw new Error('reviewDiff takes full commit ids');
  }
  const from = base ?? (await git(o, ['merge-base', 'HEAD', commit], 4096)).stdout.trim();
  if (!COMMIT_ID.test(from)) throw new Error('no merge base to diff from');
  const flags = ['--no-ext-diff', '--no-textconv', '--no-color', '-M'];
  const stat = await git(o, ['diff', ...flags, '--stat=200', from, commit], 1024 * 1024);
  const maxBytes = o.maxBytes ?? 64 * 1024;
  const patch = await git(o, ['diff', ...flags, from, commit], maxBytes);
  return {
    base: from,
    stat: stat.stdout.trimEnd(),
    patch: patch.stdout,
    truncated: patch.truncated || stat.truncated,
  };
}
