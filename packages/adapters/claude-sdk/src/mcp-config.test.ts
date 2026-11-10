import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ownOwnerDirName, removeMcpConfig, writeMcpConfig } from './mcp-config.js';

const servers = [
  { name: 'tacet', url: 'http://127.0.0.1:1/mcp', headers: { authorization: 'Bearer t' } },
];

/** The secure file handling itself is tested in `@tacet/core/node` (session-files.test.ts). */
describe('writeMcpConfig', () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tacet-mcp-')));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("writes Claude Code's MCP config as a 0600 session file outside the worktree", () => {
    const dir = join(root, 'run', 'mcp');
    const path = writeMcpConfig(servers, { sessionId: 's1', worktree: join(root, 'wt'), dir });
    expect(path).toBe(join(dir, ownOwnerDirName(), 's1.json'));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      mcpServers: { tacet: { type: 'http', url: servers[0]?.url, headers: servers[0]?.headers } },
    });
    removeMcpConfig(path);
    expect(existsSync(path)).toBe(false);
    const wt = join(root, 'wt');
    expect(() => writeMcpConfig(servers, { sessionId: 's1', worktree: wt, dir: wt })).toThrow(
      /outside the worktree/,
    );
  });

  it('rejects path-like session ids', () => {
    expect(() =>
      writeMcpConfig(servers, { sessionId: '../x', worktree: join(root, 'wt'), dir: root }),
    ).toThrow(/invalid session id/);
  });
});
