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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ownerDirName,
  ownOwnerDirName,
  realish,
  removeSessionFile,
  sweepStaleSessionFiles,
  writeSessionFile,
} from './session-files.js';
import { isProcessRunning } from './worker-processes.js';

const DATA = '{"token":"Bearer t"}';
/** A session file named after the session, as the adapters write them. */
const write = (opts: { sessionId: string; worktree: string; dir?: string }) =>
  writeSessionFile(`${opts.sessionId}.json`, DATA, opts);

describe('session files', () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tacet-session-files-')));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('writes a 0600 file in a 0700 directory outside the worktree, and removes it', () => {
    const dir = join(root, 'run', 'mcp');
    const path = write({ sessionId: 's1', worktree: join(root, 'wt'), dir });
    expect(path).toBe(join(dir, ownOwnerDirName(), 's1.json'));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readFileSync(path, 'utf8')).toBe(DATA);
    removeSessionFile(path);
    expect(existsSync(path)).toBe(false);
  });

  it('refuses a directory inside the worktree', () => {
    const wt = join(root, 'wt');
    expect(() => write({ sessionId: 's1', worktree: wt, dir: wt })).toThrow(
      /must be outside the worktree/,
    );
    expect(() => write({ sessionId: 's1', worktree: wt, dir: join(wt, '.tacet') })).toThrow(
      /must be outside the worktree/,
    );
  });

  it('refuses the worktree reached through symlinks or a ..-prefixed name', () => {
    const wt = join(root, 'wt');
    mkdirSync(wt);
    symlinkSync(wt, join(root, 'link'));
    // A symlinked parent of the directory points into the worktree.
    expect(() => write({ sessionId: 's1', worktree: wt, dir: join(root, 'link', 'mcp') })).toThrow(
      /must be outside the worktree/,
    );
    // The worktree itself is given through a symlink (as macOS tmpdir paths are).
    expect(() =>
      write({
        sessionId: 's1',
        worktree: join(root, 'link'),
        dir: join(wt, '.x'),
      }),
    ).toThrow(/must be outside the worktree/);
    // A directory whose name starts with `..` is still inside.
    expect(() => write({ sessionId: 's1', worktree: wt, dir: join(wt, '..cache') })).toThrow(
      /must be outside the worktree/,
    );
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
      write({
        sessionId: 's1',
        worktree: wt,
        dir: `${join(root, 'outside', 'link')}/../mcp`,
      }),
    ).toThrow(/must be outside the worktree/);
    // A symlinked directory pointing outside the worktree is used through its real path.
    mkdirSync(join(root, 'real'));
    symlinkSync(join(root, 'real'), join(root, 'mcp'));
    const path = write({ sessionId: 's2', worktree: wt, dir: join(root, 'mcp') });
    expect(path).toBe(join(realish(join(root, 'real')), ownOwnerDirName(), 's2.json'));
  });

  it('resolves a relative directory to an absolute path', () => {
    const cwd = process.cwd();
    process.chdir(root);
    try {
      const path = write({
        sessionId: 's3',
        worktree: join(root, 'wt'),
        dir: 'rel/mcp',
      });
      expect(isAbsolute(path)).toBe(true);
      expect(path).toBe(join(realish(root), 'rel', 'mcp', ownOwnerDirName(), 's3.json'));
    } finally {
      process.chdir(cwd);
    }
  });

  it('refuses to overwrite an existing file and rejects path-like session ids', () => {
    const dir = join(root, 'mcp');
    write({ sessionId: 's1', worktree: join(root, 'wt'), dir });
    expect(() => write({ sessionId: 's1', worktree: join(root, 'wt'), dir })).toThrow();
    expect(() => write({ sessionId: '../x', worktree: join(root, 'wt'), dir })).toThrow(
      /invalid session file name/,
    );
  });

  it('sweeps only the files of owners that are gone (#108)', async () => {
    const dir = join(root, 'run', 'mcp');
    const worktree = join(root, 'wt');
    const ns = ownOwnerDirName().split('-')[0];
    // This process's own file, and one of another live owner.
    const mine = write({ sessionId: 'mine', worktree, dir });
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
      // Every file counts, not only MCP configs (e.g. a PTY hook settings file).
      plant(deadOwner, 'b.hooks.settings');
      plant(deadOwner, 'c.json');
      // A live pid whose start time does not match: a reused pid, so a dead owner.
      plant(`${ns}-${live.pid}-000000000000`, 'd.json');
      // A writer that could not read its own start time: kept while its pid lives, not after.
      plant(`${ns}-${live.pid}-unknown`, 'e.json');
      plant(`${ns}-${dead.pid}-unknown`, 'f.json');
      // Another pid namespace (a container sharing the home directory): never touched.
      plant(`${ns}7-${dead.pid}-000000000000`, 'g.json');
      // A symlinked owner directory: never followed or removed.
      mkdirSync(join(root, 'elsewhere'));
      writeFileSync(join(root, 'elsewhere', 'keep.json'), '{}');
      symlinkSync(join(root, 'elsewhere'), join(dir, `${ns}-${dead.pid}-111111111111`));
      // Not an owner directory: never touched.
      writeFileSync(join(dir, 'legacy.json'), '{}');
      expect(sweepStaleSessionFiles(dir)).toBe(5);
      expect(readdirSync(dir).sort()).toEqual(
        [
          liveOwner,
          ownOwnerDirName(),
          'legacy.json',
          `${ns}-${live.pid}-unknown`,
          `${ns}7-${dead.pid}-000000000000`,
          `${ns}-${dead.pid}-111111111111`,
        ].sort(),
      );
      expect(existsSync(join(root, 'elsewhere', 'keep.json'))).toBe(true);
      expect(existsSync(mine)).toBe(true);
      expect(existsSync(join(dir, liveOwner, 'a.json'))).toBe(true);
      expect(sweepStaleSessionFiles(dir)).toBe(0);
    } finally {
      live.kill('SIGKILL');
    }
  });

  it('accepts only plain file names', () => {
    const opts = { worktree: join(root, 'wt'), dir: join(root, 'files') };
    for (const name of ['', '.', '..', '.hidden', 'a/b', '../x', 'a\\b', 'a\nb']) {
      expect(() => writeSessionFile(name, 'x', opts), name).toThrow(/invalid session file name/);
    }
    expect(writeSessionFile('s-1.hooks.json', 'x', opts)).toBe(
      join(realish(join(root, 'files')), ownOwnerDirName(), 's-1.hooks.json'),
    );
  });

  it('removes the owner directory with its last file', () => {
    const dir = join(root, 'run', 'mcp');
    const a = write({ sessionId: 'a', worktree: join(root, 'wt'), dir });
    const b = write({ sessionId: 'b', worktree: join(root, 'wt'), dir });
    removeSessionFile(a);
    expect(existsSync(b)).toBe(true);
    removeSessionFile(b);
    expect(readdirSync(dir)).toEqual([]);
  });
});
