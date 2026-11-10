import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { isProcessRunning } from '@tacet/core/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ownerDirName,
  realish,
  removeMcpConfig,
  sweepStaleMcpConfigs,
  writeMcpConfig,
} from './mcp-config.js';

const servers = [
  { name: 'tacet', url: 'http://127.0.0.1:1/mcp', headers: { authorization: 'Bearer t' } },
];

describe('writeMcpConfig', () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tacet-mcp-')));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('writes a 0600 file in a 0700 directory outside the worktree, and removes it', () => {
    const dir = join(root, 'run', 'mcp');
    const path = writeMcpConfig(servers, { sessionId: 's1', worktree: join(root, 'wt'), dir });
    expect(path).toBe(join(dir, ownerDirName(), 's1.json'));
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

  it('refuses the worktree reached through symlinks or a ..-prefixed name', () => {
    const wt = join(root, 'wt');
    mkdirSync(wt);
    symlinkSync(wt, join(root, 'link'));
    // A symlinked parent of the directory points into the worktree.
    expect(() =>
      writeMcpConfig(servers, { sessionId: 's1', worktree: wt, dir: join(root, 'link', 'mcp') }),
    ).toThrow(/outside the worktree/);
    // The worktree itself is given through a symlink (as macOS tmpdir paths are).
    expect(() =>
      writeMcpConfig(servers, {
        sessionId: 's1',
        worktree: join(root, 'link'),
        dir: join(wt, '.x'),
      }),
    ).toThrow(/outside the worktree/);
    // A directory whose name starts with `..` is still inside.
    expect(() =>
      writeMcpConfig(servers, { sessionId: 's1', worktree: wt, dir: join(wt, '..cache') }),
    ).toThrow(/outside the worktree/);
    expect(readdirSync(wt)).toEqual([]);
  });

  it('follows symlinks before `..`, and writes to an absolute real path', () => {
    const wt = join(root, 'wt');
    mkdirSync(join(wt, 'sub'), { recursive: true });
    mkdirSync(join(root, 'outside'));
    // `outside/link/..` is `wt` once the link is followed; lexically it would be `outside`.
    symlinkSync(join(wt, 'sub'), join(root, 'outside', 'link'));
    expect(realish(`${join(root, 'outside', 'link')}/..`)).toBe(realish(wt));
    expect(() =>
      writeMcpConfig(servers, {
        sessionId: 's1',
        worktree: wt,
        dir: `${join(root, 'outside', 'link')}/../mcp`,
      }),
    ).toThrow(/outside the worktree/);
    // A symlinked directory pointing outside the worktree is used through its real path.
    mkdirSync(join(root, 'real'));
    symlinkSync(join(root, 'real'), join(root, 'mcp'));
    const path = writeMcpConfig(servers, { sessionId: 's2', worktree: wt, dir: join(root, 'mcp') });
    expect(path).toBe(join(realish(join(root, 'real')), ownerDirName(), 's2.json'));
  });

  it('resolves a relative directory to an absolute path', () => {
    const cwd = process.cwd();
    process.chdir(root);
    try {
      const path = writeMcpConfig(servers, {
        sessionId: 's3',
        worktree: join(root, 'wt'),
        dir: 'rel/mcp',
      });
      expect(isAbsolute(path)).toBe(true);
      expect(path).toBe(join(realish(root), 'rel', 'mcp', ownerDirName(), 's3.json'));
    } finally {
      process.chdir(cwd);
    }
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

  it('sweeps only the files of owners that are gone (#108)', async () => {
    const dir = join(root, 'run', 'mcp');
    const worktree = join(root, 'wt');
    const servers = [
      { name: 't', url: 'http://127.0.0.1:1/mcp', headers: { a: 'Bearer secret-token-1' } },
    ];
    // This process's own file, and one of another live owner.
    const mine = writeMcpConfig(servers, { sessionId: 'mine', worktree, dir });
    const live = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const deadExited = new Promise((r) => dead.once('exit', r));
    try {
      const plant = (owner: string, file: string) => {
        mkdirSync(join(dir, owner), { recursive: true, mode: 0o700 });
        writeFileSync(join(dir, owner, file), '{"token":"secret-token-1"}', { mode: 0o600 });
      };
      await new Promise((r) => setTimeout(r, 100));
      const liveOwner = ownerDirName(live.pid as number);
      plant(liveOwner, 'a.json');
      // A dead owner: its process has exited.
      const deadOwner = ownerDirName(dead.pid as number);
      await deadExited;
      await expect.poll(() => isProcessRunning(dead.pid as number)).toBe(false);
      plant(deadOwner, 'b.json');
      plant(deadOwner, 'c.json');
      // A live pid whose start time does not match: a reused pid, so a dead owner.
      plant(`${live.pid}-000000000000`, 'd.json');
      // Not an owner directory: never touched.
      writeFileSync(join(dir, 'legacy.json'), '{}');
      expect(sweepStaleMcpConfigs(dir)).toBe(3);
      expect(readdirSync(dir).sort()).toEqual([liveOwner, ownerDirName(), 'legacy.json'].sort());
      expect(existsSync(mine)).toBe(true);
      expect(existsSync(join(dir, liveOwner, 'a.json'))).toBe(true);
      expect(sweepStaleMcpConfigs(dir)).toBe(0);
    } finally {
      live.kill('SIGKILL');
    }
  });

  it('removes the owner directory with its last file', () => {
    const dir = join(root, 'run', 'mcp');
    const servers = [{ name: 't', url: 'http://127.0.0.1:1/mcp' }];
    const a = writeMcpConfig(servers, { sessionId: 'a', worktree: join(root, 'wt'), dir });
    const b = writeMcpConfig(servers, { sessionId: 'b', worktree: join(root, 'wt'), dir });
    removeMcpConfig(a);
    expect(existsSync(b)).toBe(true);
    removeMcpConfig(b);
    expect(readdirSync(dir)).toEqual([]);
  });
});
