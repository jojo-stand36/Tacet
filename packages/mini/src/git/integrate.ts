import { spawn } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { inflateSync, constants as zlibConstants } from 'node:zlib';
import {
  readWorkerFile,
  SAFE_GIT_ARGS,
  type WorkerWorktree,
  workerWorktree,
} from '@tacet/core/node';
import { type Integrator, type Workspace, WorktreeRefusedError } from '../daemon/ports.js';
import { detectLanded, type Landed } from './landed.js';
import { combineCommits, setTaskBranch } from './merge.js';

export { WorktreeRefusedError };

/** A Worker's commit, now in the repo's shared object store under its task branch. */
export interface Integration {
  commit: string;
  ref: string;
}

const COMMIT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const LOOSE_DIR = /^[0-9a-f]{2}$/;
const LOOSE_FILE = /^[0-9a-f]{38}([0-9a-f]{24})?$/;
const TASK_REF_PREFIX = 'refs/heads/tacet/';

export interface IntegrateOptions {
  /** The Worker's checkout. */
  cwd: string;
  /** The repo's main worktree: the trusted anchor. */
  repoRoot: string;
  /** Branch to point at the Worker's commit; must be under `refs/heads/tacet/`. */
  ref: string;
  /** Environment to take PATH and HOME from. Nothing else is passed to git. */
  env?: Record<string, string | undefined>;
  /** Longest one git command may run. Default 2 minutes. */
  timeoutMs?: number;
  /** Most bytes of Worker objects copied for one integration. Default 512 MiB. */
  maxBytes?: number;
  /**
   * The commit the checkout started at (#134), when not a branch: a HEAD still there is no work
   * of its own, and its objects are already in the repo.
   */
  base?: string;
}

/**
 * Bring a Worker's commits into the repo (owner decision on #119): from the main repo, outside
 * the sandbox, copy the objects reachable from the Worker's HEAD into the shared store, check
 * them, then point `ref` at the commit. Workers never write the shared `.git` themselves.
 *
 * Everything in the Worker's worktree is untrusted, and can change at any moment:
 * - The worktree is checked against the repo root first (`workerWorktree`); a forged pointer
 *   throws `WorktreeRefusedError` and no git runs there.
 * - The Worker's HEAD is read as data (never through a symlink or a FIFO, bounded).
 * - The Worker's object store is never given to git. Only its loose objects with well-formed
 *   names, opened without following symlinks and only if they are regular files, are copied
 *   into a snapshot the Mini-conductor owns, up to `maxBytes`. Its `info/alternates`, packs and
 *   indexes are never read. (Unattended Codex Workers run with `gc.auto=0`, so their commits are
 *   loose; a store with packs is refused.)
 * - Git runs in the main repo with an explicit `GIT_DIR`, only PATH and HOME, `SAFE_GIT_ARGS`,
 *   and a timeout; the snapshot is only ever an alternate. `index-pack --strict` checks every
 *   object (and that each one is what its name says) before anything lands in the shared store.
 * - Objects are selected with `--not --branches --tags`, never `--all`: `--all` includes every
 *   worktree's HEAD, and another Worker's unintegrated HEAD would make it fail (#124).
 *
 * Returns undefined when `cwd` is not a linked worktree of the repo, or when the Worker made no
 * commit of its own (its HEAD is already in the repo's checked-out branch).
 */
export async function integrateWorktree(opts: IntegrateOptions): Promise<Integration | undefined> {
  if (!opts.ref.startsWith(TASK_REF_PREFIX)) {
    throw new Error(`integration only writes branches under ${TASK_REF_PREFIX}`);
  }
  let wt: WorkerWorktree | undefined;
  try {
    wt = workerWorktree(opts.cwd, opts.repoRoot);
  } catch (err) {
    throw new WorktreeRefusedError((err as Error).message);
  }
  if (!wt) return undefined;
  const env = opts.env ?? process.env;
  const base: Record<string, string> = {
    ...(env.PATH !== undefined ? { PATH: env.PATH } : {}),
    ...(env.HOME !== undefined ? { HOME: env.HOME } : {}),
    GIT_DIR: wt.commonDir,
  };
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const git = (args: string[], gitEnv: Record<string, string> = base, input?: string) =>
    run(['git', ...SAFE_GIT_ARGS, ...args], { cwd: opts.repoRoot, env: gitEnv, timeoutMs, input });
  const ok = async (args: string[], gitEnv: Record<string, string> = base) => {
    try {
      await git(args, gitEnv);
      return true;
    } catch {
      return false;
    }
  };

  await git(['check-ref-format', opts.ref]);
  const head = await workerHead(wt, git);
  if (!head) return undefined;
  const { commit } = head;
  if (opts.base !== undefined && !COMMIT_ID.test(opts.base)) throw new Error('bad base commit');
  if (commit === opts.base) return undefined;
  const current = await git(['rev-parse', '--verify', '-q', opts.ref]).catch(() => '');
  if (current === commit) return { commit, ref: opts.ref };
  // No commit of its own: the HEAD is something a branch or tag of the repo already has (its
  // base, or any other existing commit), other than its own task branch or Worker branch.
  const containing = await git([
    'for-each-ref',
    '--contains',
    commit,
    '--format=%(refname)',
    'refs/heads',
    'refs/tags',
  ]).catch(() => '');
  const others = containing.split('\n').filter((r) => r && r !== opts.ref && r !== head.branch);
  if (others.length > 0) return undefined;

  const reachable = [
    'rev-list',
    '--objects',
    commit,
    '--not',
    '--branches',
    '--tags',
    ...(opts.base !== undefined ? [opts.base] : []),
  ];
  if (!(await ok(reachable))) {
    // Inside the shared .git, which the Worker cannot write: a snapshot in a temp dir the
    // sandbox can write could be given an `info/alternates` of the Worker's choosing.
    const snapshot = mkdtempSync(join(wt.commonDir, 'tacet-snapshot-'));
    try {
      await snapshotLooseObjects(join(wt.gitDir, 'objects'), snapshot, {
        maxBytes: opts.maxBytes ?? 512 * 1024 * 1024,
        deadline: Date.now() + timeoutMs,
      });
      const withSnapshot = { ...base, GIT_ALTERNATE_OBJECT_DIRECTORIES: snapshot };
      const list = await git(reachable, withSnapshot);
      // index-pack writes into a directory of ours, so a rejected pack leaves nothing in the
      // shared store; only a checked pack is moved into objects/pack (same filesystem).
      const incoming = mkdtempSync(join(wt.commonDir, 'tacet-incoming-'));
      try {
        let out: string;
        try {
          // Streamed from pack-objects into index-pack, never held in memory.
          out = await pipe(
            ['git', ...SAFE_GIT_ARGS, 'pack-objects', '--stdout', '-q'],
            [
              'git',
              ...SAFE_GIT_ARGS,
              'index-pack',
              '--stdin',
              '--strict',
              '-o',
              join(incoming, 'incoming.idx'),
              join(incoming, 'incoming.pack'),
            ],
            { cwd: opts.repoRoot, env: withSnapshot, env2: base, timeoutMs, input: `${list}\n` },
          );
        } catch (err) {
          throw new Error(
            `the Worker's objects failed the integrity check: ${(err as Error).message}`,
          );
        }
        const hash = /^pack\s+([0-9a-f]{40}(?:[0-9a-f]{24})?)$/m.exec(out)?.[1];
        if (!hash) throw new Error('index-pack did not report a pack');
        const packDir = join(wt.commonDir, 'objects', 'pack');
        mkdirSync(packDir, { recursive: true });
        // The index last: git sees a pack once its .idx is there.
        for (const ext of ['pack', 'rev', 'idx']) {
          const from = join(incoming, `incoming.${ext}`);
          if (ext === 'rev' && !existsSync(from)) continue;
          renameSync(from, join(packDir, `pack-${hash}.${ext}`));
        }
      } finally {
        rmSync(incoming, { recursive: true, force: true });
      }
    } finally {
      rmSync(snapshot, { recursive: true, force: true });
    }
    if (!(await ok(reachable)))
      throw new Error('the Worker commit is still incomplete after copying');
  }
  // Only moves the ref if nobody else did in the meantime.
  await git(['update-ref', '--no-deref', opts.ref, commit, current || '0'.repeat(commit.length)]);
  return { commit, ref: opts.ref };
}

/**
 * The commit the Worker's HEAD names, read as data: a detached HEAD must be a full commit id; a
 * branch HEAD (a Worker without a sandbox, e.g. Claude) is resolved in the main repo, where its
 * branch lives. Undefined for an unborn branch.
 */
async function workerHead(
  wt: WorkerWorktree,
  git: (args: string[]) => Promise<string>,
): Promise<{ commit: string; branch?: string } | undefined> {
  let head: string;
  try {
    head = readWorkerFile(join(wt.gitDir, 'HEAD'), 512).trim();
  } catch (err) {
    throw new WorktreeRefusedError(
      `the Worker HEAD cannot be read safely: ${(err as Error).message}`,
    );
  }
  if (COMMIT_ID.test(head)) return { commit: head };
  const ref = /^ref: (refs\/heads\/\S+)$/.exec(head)?.[1];
  if (!ref) throw new WorktreeRefusedError('the Worker HEAD is neither a commit nor a branch');
  try {
    await git(['check-ref-format', ref]);
  } catch {
    throw new WorktreeRefusedError('the Worker HEAD names an invalid branch');
  }
  const sha = await git(['rev-parse', '--verify', '-q', `${ref}^{commit}`]).catch(() => '');
  return COMMIT_ID.test(sha) ? { commit: sha, branch: ref } : undefined;
}

const MAX_FILES = 100_000;
/** Every file counts at least this much against the byte budget, so empty files are not free. */
const MIN_FILE_COST = 4096;
/** On Linux, files are opened through the open directory itself, so a swapped path is moot. */
const PROC_FD = existsSync('/proc/self/fd');

interface OpenDir {
  fd: number;
  path: string;
  dev: number;
  ino: number;
}

/**
 * Open `name` inside `parent` (or the absolute path `name` when there is no parent), never
 * following a symlink in the last component and never blocking. On Linux the open goes through
 * `/proc/self/fd/<parent fd>`, so the Worker swapping a directory on the path for a symlink after
 * it was checked has no effect. Elsewhere the parent's identity is checked again after the open.
 */
function openIn(parent: OpenDir | undefined, name: string, flags: number): number {
  const path = !parent
    ? name
    : PROC_FD
      ? `/proc/self/fd/${parent.fd}/${name}`
      : join(parent.path, name);
  const fd = openSync(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  if (parent && !PROC_FD) {
    const now = lstatSync(parent.path);
    if (now.dev !== parent.dev || now.ino !== parent.ino) {
      closeSync(fd);
      throw new Error("the Worker's object store changed while it was copied");
    }
  }
  return fd;
}

function openDir(parent: OpenDir | undefined, name: string, strict = false): OpenDir | undefined {
  let fd: number;
  try {
    fd = openIn(parent, name, constants.O_RDONLY | constants.O_DIRECTORY);
  } catch (err) {
    if ((err as Error).message.includes('changed while')) throw err;
    // Strict callers vouch for what they did not see: only a missing directory is empty.
    if (strict && (err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return undefined;
  }
  const st = fstatSync(fd);
  return { fd, path: parent ? join(parent.path, name) : name, dev: st.dev, ino: st.ino };
}

function listDir(dir: OpenDir): string[] {
  return readdirSync(PROC_FD ? `/proc/self/fd/${dir.fd}` : dir.path);
}

/**
 * Copy the Worker's loose objects into `dest`: only `xx/yyyy…` names, only regular files, never
 * through a symlink or a FIFO, at most `maxBytes` (each file costing at least 4 KiB) and 100,000
 * files, before `deadline`, yielding to the event loop as it goes. Anything else in the store is
 * ignored, except packs, which are refused.
 */
async function snapshotLooseObjects(
  src: string,
  dest: string,
  limits: { maxBytes: number; deadline: number },
): Promise<void> {
  const root = openDir(undefined, src);
  if (!root) return;
  let cost = 0;
  let files = 0;
  try {
    for (const d of listDir(root)) {
      if (d === 'pack') {
        const pack = openDir(root, d);
        if (pack) {
          try {
            if (listDir(pack).some((f) => !f.startsWith('.'))) {
              throw new Error("the Worker's object store has packs, which are not supported");
            }
          } finally {
            closeSync(pack.fd);
          }
        }
        continue;
      }
      if (!LOOSE_DIR.test(d)) continue;
      const sub = openDir(root, d);
      if (!sub) continue;
      try {
        for (const f of listDir(sub)) {
          if (!LOOSE_FILE.test(f)) continue;
          files += 1;
          if (files > MAX_FILES) throw new Error("the Worker's object store has too many objects");
          if (files % 500 === 0) {
            if (Date.now() > limits.deadline)
              throw new Error('copying the Worker objects timed out');
            await new Promise((r) => setImmediate(r));
          }
          const data = readRegular(sub, f, limits.maxBytes - cost);
          cost += Math.max(data.length, MIN_FILE_COST);
          if (cost > limits.maxBytes) {
            throw new Error("the Worker's new objects are too large to integrate");
          }
          mkdirSync(join(dest, d), { recursive: true, mode: 0o700 });
          writeFileSync(join(dest, d, f), data, { flag: 'wx', mode: 0o400 });
        }
      } finally {
        closeSync(sub.fd);
      }
    }
  } finally {
    closeSync(root.fd);
  }
}

/**
 * The commits among the Worker's loose objects (`<objects>/xx/yyyy…`), found the way
 * `snapshotLooseObjects` walks the store: well-formed names only, regular files only, never
 * through a symlink or a FIFO, at most 100,000 files, before `deadline`. Only each object's
 * header is read and inflated; the store is never given to git. Throws when the store has packs
 * (it cannot be checked without git) or cannot be read safely.
 */
export async function looseCommits(objectsDir: string, deadline: number): Promise<string[]> {
  const root = openDir(undefined, objectsDir, true);
  if (!root) return [];
  const commits: string[] = [];
  let files = 0;
  try {
    for (const d of listDir(root)) {
      if (d === 'pack') {
        const pack = openDir(root, d, true);
        if (pack) {
          try {
            // Any entry: git also loads packs whose names start with a dot.
            if (listDir(pack).length > 0) {
              throw new Error("the Worker's object store has packs, which are not supported");
            }
          } finally {
            closeSync(pack.fd);
          }
        }
        continue;
      }
      if (!LOOSE_DIR.test(d)) continue;
      const sub = openDir(root, d, true);
      if (!sub) continue;
      try {
        for (const f of listDir(sub)) {
          if (!LOOSE_FILE.test(f)) continue;
          files += 1;
          if (files > MAX_FILES) throw new Error("the Worker's object store has too many objects");
          if (files % 500 === 0) {
            if (Date.now() > deadline) throw new Error('reading the Worker objects timed out');
            await new Promise((r) => setImmediate(r));
          }
          if (objectType(sub, f) === 'commit') commits.push(`${d}${f}`);
        }
      } finally {
        closeSync(sub.fd);
      }
    }
  } finally {
    closeSync(root.fd);
  }
  return commits;
}

/** The type in a loose object's header (`<type> <size>\0`), from its first compressed bytes. */
function objectType(dir: OpenDir, name: string): string {
  const fd = openIn(dir, name, constants.O_RDONLY);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('a Worker object is not a regular file');
    const head = Buffer.alloc(64);
    const n = readSync(fd, head, 0, head.length, 0);
    const text = inflateSync(head.subarray(0, n), {
      finishFlush: zlibConstants.Z_SYNC_FLUSH,
    }).toString('latin1');
    const type = /^(blob|tree|commit|tag) /.exec(text)?.[1];
    if (!type) throw new Error('a Worker object has no valid header');
    return type;
  } finally {
    closeSync(fd);
  }
}

function readRegular(dir: OpenDir, name: string, budget: number): Buffer {
  const fd = openIn(dir, name, constants.O_RDONLY);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error('a Worker object is not a regular file');
    if (st.size > budget) throw new Error("the Worker's new objects are too large to integrate");
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off);
  } finally {
    closeSync(fd);
  }
}

interface RunOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  input?: string | undefined;
}

/** Run a command; resolves with its trimmed stdout, rejects with its stderr or a timeout. */
function run(argv: string[], o: RunOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0] as string, argv.slice(1), {
      cwd: o.cwd,
      env: o.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let errBytes = 0;
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => {
      if (errBytes < 4096) err.push(c);
      errBytes += c.length;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), o.timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out).toString('utf8').trim());
      else {
        const why = signal === 'SIGKILL' ? 'timed out' : Buffer.concat(err).toString('utf8').trim();
        reject(new Error(`${argv.slice(0, 5).join(' ')}: ${why.slice(0, 500)}`));
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(o.input ?? '');
  });
}

/** `a | b`, both under the timeout; resolves with b's stdout, rejects if either fails. */
function pipe(
  a: string[],
  b: string[],
  o: RunOptions & { env2: Record<string, string> },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const first = spawn(a[0] as string, a.slice(1), {
      cwd: o.cwd,
      env: o.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const second = spawn(b[0] as string, b.slice(1), {
      cwd: o.cwd,
      env: o.env2,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    first.stdout.pipe(second.stdin);
    const out: Buffer[] = [];
    second.stdout.on('data', (c: Buffer) => {
      if (out.length < 64) out.push(c);
    });
    const errs: string[] = [];
    for (const p of [first, second]) {
      p.stderr.on('data', (c: Buffer) => {
        if (errs.join('').length < 4096) errs.push(c.toString('utf8'));
      });
      p.stdin.on('error', () => {});
    }
    const timer = setTimeout(() => {
      first.kill('SIGKILL');
      second.kill('SIGKILL');
    }, o.timeoutMs);
    let pending = 2;
    let failed = false;
    const done = (code: number | null, signal: NodeJS.Signals | null) => {
      if (code !== 0) failed = true;
      if (signal === 'SIGKILL') errs.push('timed out');
      pending -= 1;
      if (pending > 0) return;
      clearTimeout(timer);
      if (failed) reject(new Error(errs.join('').trim().slice(0, 500) || 'failed'));
      else resolve(Buffer.concat(out).toString('utf8'));
    };
    first.on('close', done);
    second.on('close', done);
    first.on('error', reject);
    second.on('error', reject);
    first.stdin.end(o.input ?? '');
  });
}

/**
 * `refs/heads/tacet/<task>`, with the task id made safe for a ref name. Task ids are ULIDs (and
 * `<ulid>/<n>` for sub-tasks), so the replacement never merges two real ids.
 */
export function taskBranch(taskId: string): string {
  return `${TASK_REF_PREFIX}${taskId.replace(/[^A-Za-z0-9/_-]/g, '_').replace(/\/+/g, '/')}`;
}

/**
 * `refs/heads/tacet/<task>/result`: a task's combined result (#134). Not `tacet/<task>` itself,
 * which git cannot have next to the sub-task branches `tacet/<task>/<n>`.
 */
export function resultBranch(taskId: string): string {
  return `${taskBranch(taskId)}/result`;
}

/** The Mini-conductor's `Integrator` for git worktrees of `repoRoot`. */
export class GitIntegrator implements Integrator {
  readonly #repoRoot: string;
  readonly #env: Record<string, string | undefined>;

  constructor(repoRoot: string, env: Record<string, string | undefined> = process.env) {
    this.#repoRoot = repoRoot;
    this.#env = env;
  }

  integrate(
    subtaskId: string,
    workspace: Workspace,
    base?: string,
  ): Promise<Integration | undefined> {
    return integrateWorktree({
      cwd: workspace.path,
      repoRoot: this.#repoRoot,
      ref: taskBranch(subtaskId),
      env: this.#env,
      ...(base !== undefined ? { base } : {}),
    });
  }

  combine(commits: readonly string[]): Promise<string | undefined> {
    return combineCommits(commits, { repoRoot: this.#repoRoot, env: this.#env });
  }

  landed(commit: string, target: string): Promise<Landed | undefined> {
    return detectLanded({ repoRoot: this.#repoRoot, commit, target, env: this.#env });
  }

  async publish(taskId: string, commit: string): Promise<string> {
    const ref = resultBranch(taskId);
    await setTaskBranch(ref, commit, { repoRoot: this.#repoRoot, env: this.#env });
    return ref;
  }
}
