import type { McpServerConfig } from '@tacet/core';
import {
  defaultSessionFileDir,
  ownerDirName,
  ownOwnerDirName,
  realish,
  removeSessionFile,
  sweepStaleSessionFiles,
  writeSessionFile,
} from '@tacet/core/node';

/**
 * Claude Code's `--mcp-config` file for a Worker session. The secure file handling (0600, outside
 * the worktree, owner directories, crash sweep) lives in `@tacet/core/node` (session files), shared
 * with the PTY adapter (#15); the names below are kept for existing callers.
 */
export {
  defaultSessionFileDir as defaultMcpConfigDir,
  ownerDirName,
  ownOwnerDirName,
  realish,
  removeSessionFile as removeMcpConfig,
  sweepStaleSessionFiles as sweepStaleMcpConfigs,
};

/**
 * Write the Worker's MCP config (which holds its per-worker token) as `<sessionId>.json`, with
 * `writeSessionFile`: mode 0600, outside the worktree (owner decision 2026-11-09). The Claude Code
 * binary reads it through `--mcp-config <path>`, which keeps the token out of the process list;
 * the SDK's `mcpServers` option would put the JSON on the command line. Returns the path; call
 * `removeMcpConfig` when the session closes.
 */
export function writeMcpConfig(
  servers: McpServerConfig[],
  opts: { sessionId: string; worktree: string; dir?: string },
): string {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(opts.sessionId)) throw new Error('invalid session id');
  const config = {
    mcpServers: Object.fromEntries(
      servers.map((s) => [
        s.name,
        { type: 'http', url: s.url, ...(s.headers ? { headers: s.headers } : {}) },
      ]),
    ),
  };
  return writeSessionFile(`${opts.sessionId}.json`, JSON.stringify(config), {
    worktree: opts.worktree,
    ...(opts.dir !== undefined ? { dir: opts.dir } : {}),
  });
}
