import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeMcpConfig, writeMcpConfig } from './mcp-config.js';

const servers = [
  { name: 'tacet', url: 'http://127.0.0.1:1/mcp', headers: { authorization: 'Bearer t' } },
];

describe('writeMcpConfig', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tacet-mcp-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('writes a 0600 file in a 0700 directory outside the worktree, and removes it', () => {
    const dir = join(root, 'run', 'mcp');
    const path = writeMcpConfig(servers, { sessionId: 's1', worktree: join(root, 'wt'), dir });
    expect(path).toBe(join(dir, 's1.json'));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      mcpServers: { tacet: { type: 'http', url: servers[0]?.url, headers: servers[0]?.headers } },
    });
    removeMcpConfig(path);
    expect(existsSync(path)).toBe(false);
  });

  it('refuses a directory inside the worktree', () => {
    const wt = join(root, 'wt');
    expect(() => writeMcpConfig(servers, { sessionId: 's1', worktree: wt, dir: wt })).toThrow(
      /outside the worktree/,
    );
    expect(() =>
      writeMcpConfig(servers, { sessionId: 's1', worktree: wt, dir: join(wt, '.tacet') }),
    ).toThrow(/outside the worktree/);
  });

  it('refuses to overwrite an existing file and rejects path-like session ids', () => {
    const dir = join(root, 'mcp');
    writeMcpConfig(servers, { sessionId: 's1', worktree: join(root, 'wt'), dir });
    expect(() =>
      writeMcpConfig(servers, { sessionId: 's1', worktree: join(root, 'wt'), dir }),
    ).toThrow();
    expect(() =>
      writeMcpConfig(servers, { sessionId: '../x', worktree: join(root, 'wt'), dir }),
    ).toThrow(/invalid session id/);
  });
});
