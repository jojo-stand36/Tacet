import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, rmSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { McpServerConfig } from '@tacet/core';

/** Where per-session MCP config files live: outside every repo, mode 0700. */
export function defaultMcpConfigDir(): string {
  return join(homedir(), '.tacet', 'run', 'mcp');
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Write the Worker's MCP config (which holds its per-worker token) to
 * `<dir>/<sessionId>.json` with mode 0600, and refuse a location inside the worktree, so it can
 * never be committed (owner decision 2026-11-09). The Claude Code binary reads it through
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
  if (isInside(dir, opts.worktree)) {
    throw new Error('MCP config directory must be outside the worktree');
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory()) throw new Error(`MCP config directory ${dir} is not a directory`);
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
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeSync(fd, JSON.stringify(config));
  } finally {
    closeSync(fd);
  }
  return path;
}

export function removeMcpConfig(path: string): void {
  rmSync(path, { force: true });
}
