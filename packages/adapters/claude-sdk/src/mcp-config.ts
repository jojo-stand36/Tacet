import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmdirSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative, sep } from 'node:path';
import type { McpServerConfig } from '@tacet/core';
import { processStartTime } from '@tacet/core/node';

/** Where per-session MCP config files live: outside every repo, mode 0700. */
export function defaultMcpConfigDir(): string {
  return join(homedir(), '.tacet', 'run', 'mcp');
}

/**
 * `path` with every symlink resolved, walking it one segment at a time from the root (or the
 * current directory) so that a symlink is followed before a later `..` is applied: `a/link/..` is
 * the parent of the link's target, not `a`. `path.resolve()` would collapse `..` lexically first.
 * Missing parts are kept as written, so a worktree that does not exist yet still compares.
 */
export function realish(path: string): string {
  let cur = isAbsolute(path) ? parse(path).root : realpathSync(process.cwd());
  let missing = false;
  for (const seg of path.split(/[\\/]+/)) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      cur = dirname(cur);
      continue;
    }
    const next = join(cur, seg);
    // Once a part is missing, nothing below it exists, so there is nothing more to follow.
    if (!missing && existsSync(next)) {
      cur = realpathSync(next);
    } else {
      cur = next;
      missing = true;
    }
  }
  return cur;
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/** `<namespace>-<pid>-<hash>`, or `<namespace>-<pid>-unknown`; see `ownerDirName`. */
const OWNER_DIR = /^(\d+)-(\d+)-([0-9a-f]{12}|unknown)$/;

/**
 * This machine's pid namespace (Linux: the inode of `/proc/self/ns/pid`; elsewhere `0`). A pid
 * means a different process in another namespace, e.g. a container sharing the home directory, so
 * the sweep leaves other namespaces' directories alone.
 */
function pidNamespace(): string {
  if (process.platform !== 'linux') return '0';
  try {
    return /\[(\d+)\]/.exec(readlinkSync('/proc/self/ns/pid'))?.[1] ?? '0';
  } catch {
    return '0';
  }
}

const startHash = (start: string): string =>
  createHash('sha256').update(start).digest('hex').slice(0, 12);

/**
 * `<namespace>-<pid>-<hash>`: the process that writes a set of MCP config files, and a hash of its
 * start time, so a later process that gets the same pid is not taken for it (#108). When the start
 * time cannot be read, the hash is `unknown`, and only the pid being gone lets a sweep remove the
 * directory.
 */
export function ownerDirName(pid = process.pid): string {
  const start = processStartTime(pid);
  return `${pidNamespace()}-${pid}-${start === undefined ? 'unknown' : startHash(start)}`;
}

/** This process's owner directory name, worked out once, so all its files share one directory. */
let ownName: string | undefined;
export function ownOwnerDirName(): string {
  ownName ??= ownerDirName();
  return ownName;
}

/**
 * Whether the process an owner directory is named after is still running. A process that exists
 * but whose start time cannot be read now counts as running: a sweep must never remove a live
 * Mini-conductor's files.
 */
function ownerRunning(pid: number, hash: string): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  if (hash === 'unknown') return true;
  const start = processStartTime(pid);
  if (start === undefined) return true;
  return startHash(start) === hash;
}

/**
 * Remove the MCP config files of owners that are no longer running (#108): after a crash or a
 * kill their files stay behind. Several Mini-conductors can share `dir`, so only directories whose
 * owner is gone go, never this process's or another live one's. Files are never read. Returns how
 * many config files were removed. Files directly in `dir` (written before owner directories
 * existed) have no known owner and are left alone.
 */
export function sweepStaleMcpConfigs(dir = defaultMcpConfigDir()): number {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  const own = ownOwnerDirName();
  const ns = pidNamespace();
  let removed = 0;
  for (const name of entries) {
    const m = OWNER_DIR.exec(name);
    if (!m || name === own || m[1] !== ns) continue;
    const path = join(dir, name);
    try {
      const st = lstatSync(path);
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
      if (typeof process.getuid === 'function' && st.uid !== process.getuid()) continue;
      if (ownerRunning(Number(m[2]), m[3] ?? '')) continue;
      const files = readdirSync(path).filter((f) => f.endsWith('.json')).length;
      rmSync(path, { recursive: true, force: true });
      removed += files;
    } catch {
      // Gone already, or not readable or removable: the next sweep tries again.
    }
  }
  return removed;
}

/**
 * Write the Worker's MCP config (which holds its per-worker token) to
 * `<dir>/<owner>/<sessionId>.json` with mode 0600 (`<owner>` is `ownOwnerDirName()`, for
 * `sweepStaleMcpConfigs`), and refuse a location inside the worktree, so it can
 * never be committed (owner decision 2026-11-09). Containment is checked on real paths (symlinks
 * followed before `..`), so a symlinked directory or worktree cannot route the file into the
 * repo, and the file is written to that real, absolute path. The directory must be owned by this
 * user. The Claude Code binary reads the file through
 * `--mcp-config <path>`, which keeps the token out of the process list; the SDK's `mcpServers`
 * option would put the JSON on the command line. Returns the path; call `removeMcpConfig` when
 * the session closes.
 */
export function writeMcpConfig(
  servers: McpServerConfig[],
  opts: { sessionId: string; worktree: string; dir?: string },
): string {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(opts.sessionId)) throw new Error('invalid session id');
  // Real and absolute: the binary resolves `--mcp-config` against its own cwd (the worktree),
  // and every later check and write uses this same resolved path.
  const dir = realish(opts.dir ?? defaultMcpConfigDir());
  const worktree = realish(opts.worktree);
  if (isInside(dir, worktree)) {
    throw new Error('MCP config directory must be outside the worktree');
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory()) throw new Error(`MCP config directory ${dir} is not a directory`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new Error(`MCP config directory ${dir} is not owned by this user`);
  }
  // Check again now that the directory exists, in case it changed under us.
  if (isInside(realpathSync(dir), worktree)) {
    throw new Error('MCP config directory must be outside the worktree');
  }
  chmodSync(dir, 0o700);
  const ownerDir = join(dir, ownOwnerDirName());
  mkdirSync(ownerDir, { mode: 0o700, recursive: true });
  const ost = lstatSync(ownerDir);
  if (!ost.isDirectory() || ost.isSymbolicLink()) {
    throw new Error(`MCP config directory ${ownerDir} is not a directory`);
  }
  chmodSync(ownerDir, 0o700);
  const path = join(ownerDir, `${opts.sessionId}.json`);
  const config = {
    mcpServers: Object.fromEntries(
      servers.map((s) => [
        s.name,
        { type: 'http', url: s.url, ...(s.headers ? { headers: s.headers } : {}) },
      ]),
    ),
  };
  const data = Buffer.from(JSON.stringify(config));
  // `wx` fails if the path exists, including as a symlink, so nothing is written through one.
  const fd = openSync(path, 'wx', 0o600);
  try {
    for (let off = 0; off < data.length; ) off += writeSync(fd, data, off);
  } catch (err) {
    closeSync(fd);
    rmSync(path, { force: true });
    throw err;
  }
  closeSync(fd);
  return path;
}

export function removeMcpConfig(path: string): void {
  rmSync(path, { force: true });
  // The owner directory goes with its last file (the write is synchronous, so no other session
  // of this process can be between creating the directory and writing its file).
  if (OWNER_DIR.test(basename(dirname(path)))) {
    try {
      rmdirSync(dirname(path));
    } catch {
      // Not empty: other sessions of this Mini-conductor still have files there.
    }
  }
}
