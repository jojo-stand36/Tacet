import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Where Claude Code's Linux sandbox may write and leave placeholders, and how Tacet keeps that
 * out of shared directories (#326; capability matrix, "Sandbox temp dir and placeholders (#326)",
 * Claude Code 2.1.319). The sandbox's write roots are the session's cwd and
 * `<CLAUDE_CODE_TMPDIR or TMPDIR>/claude-<uid>` (plus added dirs); it plants `.claude/...`
 * placeholders in each, and pins a `.git` skeleton where a `.git` directory already is.
 */

/**
 * Refuse a Claude session whose cwd is a shared directory or contains one: `/`, HOME, `/tmp`, the
 * temp dir (`os.tmpdir()`, `$TMPDIR`). The sandbox makes its cwd a write root and leaves
 * placeholders there, where every user of the machine would find them (a stray `/tmp/.git`
 * makes every path under `/tmp` look like a repo, #326). Compared after symlinks.
 */
export function refuseSharedCwd(
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  /** The HOME the session itself runs with, when it differs from `env`'s. */
  sessionHome?: string,
): void {
  const at = realPath(cwd);
  const shared = new Set(
    ['/', '/tmp', tmpdir(), env.TMPDIR, env.HOME, sessionHome, homedir()]
      .filter((p): p is string => typeof p === 'string' && p !== '' && isAbsolute(p))
      .map(realPath),
  );
  for (const dir of shared) {
    // The cwd is that directory, or one above it (whose write root would hold it).
    const rel = relative(at, dir);
    if (rel === '' || (rel.split(sep)[0] !== '..' && !isAbsolute(rel))) {
      throw new Error(
        `refusing a Claude session in ${at}: its sandbox writes placeholders into its working directory, which must not be (or contain) ${dir} (#326)`,
      );
    }
  }
}

/**
 * `p` after symlinks, also when it does not exist (yet): the deepest ancestor that exists is
 * resolved and the rest appended. A HOME or TMPDIR that is not there still compares in the same
 * form as a cwd that is (on macOS `/home` is `/System/Volumes/Data/home`, `/tmp` `/private/tmp`).
 */
function realPath(p: string): string {
  let at = resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(at), ...rest);
    } catch {
      const up = dirname(at);
      if (up === at) return resolve(p);
      rest.unshift(basename(at));
      at = up;
    }
  }
}

/** Name of the private temp dirs Tacet makes for Claude sessions: `tacet-c-` and mkdtemp's six. */
const PREFIX = 'tacet-c-';
const NAME = /^tacet-c-[A-Za-z0-9]{6}$/;

/**
 * The longest `<T>/claude-<uid>` Claude Code uses as its sandbox TMPDIR: past it, it falls back
 * to the shared `os.tmpdir()/claude-<uid>` with only a log line (`hNr=44`, an AF_UNIX path limit;
 * capability matrix row #326).
 */
export const CLAUDE_TMP_BUDGET = 44;

/** Who made a private temp dir: the host process, in this PID namespace. */
interface TmpOwner {
  host: number;
  ns: string;
}

function pidNamespace(): string {
  try {
    return readlinkSync('/proc/self/ns/pid');
  } catch {
    return '';
  }
}

/** Whether `pid` still runs. Unknown counts as running. */
function running(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function uid(): number | undefined {
  return process.getuid?.();
}

/**
 * A private temp dir for one Claude session, for both `TMPDIR` and `CLAUDE_CODE_TMPDIR` (#326):
 * a fresh 0700 `tacet-c-XXXXXX` under `root` (the temp dir), with an owner record beside it for
 * the sweep. Claude Code then keeps its own files and sandbox placeholders in
 * `<dir>/claude-<uid>`, apart from every other session's. No dir on any platform but Linux, where
 * this was not verified; none, with a warning, when that path would be longer than Claude's
 * budget (it would fall back to the shared dir anyway).
 */
export function makeClaudeTmpdir(
  root = tmpdir(),
  platform: NodeJS.Platform = process.platform,
): { dir?: string; warning?: string } {
  if (platform !== 'linux') return {};
  const probe = join(root, `${PREFIX}XXXXXX`, `claude-${uid() ?? 0}`);
  if (Buffer.byteLength(probe) > CLAUDE_TMP_BUDGET) {
    return {
      warning: `temp dir ${root} is too long for a private Claude temp dir (${probe} is over ${CLAUDE_TMP_BUDGET} bytes): this session shares ${join(root, `claude-${uid() ?? 0}`)} with other Claude sessions (#326)`,
    };
  }
  const dir = mkdtempSync(join(root, PREFIX));
  try {
    chmodSync(dir, 0o700);
    const tmp = `${dir}.owner.${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ host: process.pid, ns: pidNamespace() }), {
      mode: 0o600,
      flag: 'wx',
    });
    renameSync(tmp, `${dir}.owner`);
  } catch (err) {
    rmSync(`${dir}.owner.${process.pid}`, { force: true });
    releaseClaudeTmpdir(dir);
    throw err;
  }
  return { dir };
}

/** Remove a private temp dir, read-only placeholders included, then its record. Never throws. */
export function releaseClaudeTmpdir(dir: string): void {
  removeTree(dir);
  if (existsSync(dir)) return;
  try {
    rmSync(`${dir}.owner`, { force: true });
  } catch {
    // Left for the sweep: a record whose dir is gone.
  }
}

/**
 * `rm -r` that never follows a symlink, making read-only directories writable first. The unlock
 * pass checks each entry with `lstat` before it chmods and lists it, so it is safe while nothing
 * else writes in the tree; a writer swapping a directory for a link in between could make it
 * chmod a directory of the user's elsewhere (never remove one: `rmSync` does not follow links).
 */
function removeTree(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
    return;
  } catch {
    // Below: unlock and retry.
  }
  const unlock = (d: string): void => {
    try {
      if (!lstatSync(d).isDirectory()) return;
      chmodSync(d, 0o700);
      for (const name of readdirSync(d)) unlock(join(d, name));
    } catch {
      // Not ours to fix; the retry below leaves it.
    }
  };
  unlock(dir);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Left behind.
  }
}

/** The owner record of `dir`: only a regular file of this user's, never through a link. */
function readOwner(dir: string, me: number | undefined): TmpOwner | undefined {
  try {
    const st = lstatSync(`${dir}.owner`);
    if (!st.isFile() || st.nlink !== 1 || (me !== undefined && st.uid !== me)) return undefined;
    const o = JSON.parse(readFileSync(`${dir}.owner`, 'utf8')) as Partial<TmpOwner>;
    if (!Number.isInteger(o.host) || typeof o.ns !== 'string') return undefined;
    return o as TmpOwner;
  } catch {
    return undefined;
  }
}

/**
 * Remove the private temp dirs under `root` that hosts killed before they could clean up left:
 * only a real directory (never a symlink) named `tacet-c-XXXXXX`, owned by this user, whose owner
 * record names a host in this PID namespace that is gone. A dir with no readable record, from
 * another namespace (or where either namespace is unknown), or whose host still runs is kept,
 * whatever its age. Only the host is checked: a Claude Code process that outlived its host (#127)
 * may still be writing in a dir this removes. A record whose dir is
 * gone goes too. Returns how many dirs were removed; never throws.
 */
export function sweepClaudeTmpdirs(root = tmpdir()): number {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return 0;
  }
  const here = pidNamespace();
  const me = uid();
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(PREFIX)) continue;
    const path = join(root, name);
    try {
      const st = lstatSync(path);
      if (me !== undefined && st.uid !== me) continue;
      const base = name.split('.')[0] as string;
      if (!NAME.test(base)) continue;
      if (name !== base) {
        // An owner record whose dir is gone.
        if (name === `${base}.owner` && st.isFile() && !existsSync(join(root, base))) {
          rmSync(path, { force: true });
        }
        continue;
      }
      if (!st.isDirectory()) continue;
      const owner = readOwner(path, me);
      if (!owner?.ns || !here || owner.ns !== here || running(owner.host)) continue;
      releaseClaudeTmpdir(path);
      if (!existsSync(path)) removed++;
    } catch {
      // Left for the next sweep.
    }
  }
  return removed;
}

/** The environment a Claude session gets for its private temp dir. */
export function claudeTmpEnv(dir: string): Record<string, string> {
  return { TMPDIR: dir, CLAUDE_CODE_TMPDIR: dir };
}
