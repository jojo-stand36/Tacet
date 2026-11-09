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
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { McpServerConfig } from '@tacet/core';

/** Where per-session MCP config files live: outside every repo, mode 0700. */
export function defaultMcpConfigDir(): string {
  return join(homedir(), '.tacet', 'run', 'mcp');
}

/**
 * `path` with every symlink resolved. Missing trailing parts are kept as written under the real
 * path of their nearest existing ancestor, so a worktree that does not exist yet still compares.
 */
function realish(path: string): string {
  const abs = resolve(path);
  if (existsSync(abs)) return realpathSync(abs);
  const parent = dirname(abs);
  return parent === abs ? abs : join(realish(parent), basename(abs));
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/**
 * Write the Worker's MCP config (which holds its per-worker token) to
 * `<dir>/<sessionId>.json` with mode 0600, and refuse a location inside the worktree, so it can
 * never be committed (owner decision 2026-11-09). Containment is checked on real paths, so a
 * symlinked directory or worktree cannot route the file into the repo. The directory must be a
 * real directory owned by this user. The Claude Code binary reads the file through
 * `--mcp-config <path>`, which keeps the token out of the process list; the SDK's `mcpServers`
 * option would put the JSON on the command line. Returns the path; call `removeMcpConfig` when
 * the session closes.
 */
export function writeMcpConfig(
  servers: McpServerConfig[],
  opts: { sessionId: string; worktree: string; dir?: string },
): string {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(opts.sessionId)) throw new Error('invalid session id');
  const dir = opts.dir ?? defaultMcpConfigDir();
  const worktree = realish(opts.worktree);
  if (isInside(realish(dir), worktree)) {
    throw new Error('MCP config directory must be outside the worktree');
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory()) throw new Error(`MCP config directory ${dir} is not a directory`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new Error(`MCP config directory ${dir} is not owned by this user`);
  }
  // Check again now that the directory exists: a parent may have been a symlink all along.
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
