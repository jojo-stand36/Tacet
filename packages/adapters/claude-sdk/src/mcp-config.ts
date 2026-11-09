import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, sep } from 'node:path';
import type { McpServerConfig } from '@tacet/core';

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

/**
 * Write the Worker's MCP config (which holds its per-worker token) to
 * `<dir>/<sessionId>.json` with mode 0600, and refuse a location inside the worktree, so it can
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
  const path = join(dir, `${opts.sessionId}.json`);
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
}
