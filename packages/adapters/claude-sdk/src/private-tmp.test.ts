import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_TMP_BUDGET,
  claudeTmpEnv,
  makeClaudeTmpdir,
  refuseSharedCwd,
  releaseClaudeTmpdir,
  sweepClaudeTmpdirs,
} from './private-tmp.js';

const linux = process.platform === 'linux';
const root0 = process.getuid?.() === 0;

let root: string;
beforeEach(() => {
  // Short, so a private dir fits Claude's budget.
  root = realpathSync(mkdtempSync(join(tmpdir(), 't326-')));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A pid that is certainly gone: a child that ran and was reaped. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', '']);
  return r.pid as number;
}

function ns(): string {
  return readlinkSync('/proc/self/ns/pid');
}

/** A `tacet-c-` dir as a host would have left it. */
function leftDir(name: string, owner?: object): string {
  const dir = join(root, name);
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(dir, 'f'), 'x');
  if (owner) writeFileSync(`${dir}.owner`, JSON.stringify(owner));
  return dir;
}

describe('refuseSharedCwd', () => {
  const env = { HOME: '/home/someone', TMPDIR: '/var/tmp/x' };
  it('refuses a shared dir, or one that holds it', () => {
    for (const cwd of ['/', '/tmp', tmpdir(), '/home/someone', '/home', '/var/tmp/x', '/var']) {
      expect(() => refuseSharedCwd(cwd, env), cwd).toThrow(/refusing a Claude session/);
    }
  });
  it('takes a dir below a shared one', () => {
    for (const cwd of [root, '/home/someone/repo', '/var/tmp/x/wt', '/srv/repo']) {
      expect(() => refuseSharedCwd(cwd, env), cwd).not.toThrow();
    }
    // A sibling whose name starts with `..` is not above anything.
    expect(() => refuseSharedCwd('/home/someone/..repo', env)).not.toThrow();
  });
  it('compares after symlinks', () => {
    const link = join(root, 'to-tmp');
    symlinkSync('/tmp', link);
    // `/tmp` itself may be a link (macOS: `/private/tmp`): the message names the real dir.
    expect(() => refuseSharedCwd(link, env)).toThrow(`in ${realpathSync('/tmp')}:`);
    const home = join(root, 'home');
    mkdirSync(home);
    const alias = join(root, 'home-link');
    symlinkSync(home, alias);
    expect(() => refuseSharedCwd(home, { HOME: alias })).toThrow(/refusing/);
    expect(() => refuseSharedCwd(join(home, 'repo'), { HOME: alias })).not.toThrow();
  });

  it('compares a HOME or TMPDIR that does not exist after the links above it', () => {
    // As on macOS, where `/home` is `/System/Volumes/Data/home` and `/var` is `/private/var`.
    const data = join(root, 'data', 'home');
    mkdirSync(data, { recursive: true });
    const link = join(root, 'home');
    symlinkSync(data, link);
    const env = { HOME: join(link, 'someone'), TMPDIR: join(link, 'tmp', 'x') };
    for (const cwd of [link, data, root, join(data, 'someone')]) {
      expect(() => refuseSharedCwd(cwd, env), cwd).toThrow(/refusing a Claude session/);
    }
    expect(() => refuseSharedCwd(join(data, 'someone', 'repo'), env)).not.toThrow();
    expect(() => refuseSharedCwd(join(data, 'other'), env)).not.toThrow();
  });
});

describe.runIf(linux)('makeClaudeTmpdir and releaseClaudeTmpdir', () => {
  it('makes a 0700 dir with an owner record, and removes both', () => {
    const { dir, warning } = makeClaudeTmpdir(root);
    expect(warning).toBeUndefined();
    if (!dir) throw new Error('no dir');
    expect(dir).toMatch(/\/tacet-c-[A-Za-z0-9]{6}$/);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(`${dir}.owner`, 'utf8'))).toEqual({
      host: process.pid,
      ns: ns(),
    });
    expect(claudeTmpEnv(dir)).toEqual({ TMPDIR: dir, CLAUDE_CODE_TMPDIR: dir });
    // What the sandbox leaves: read-only dirs and a read-only placeholder.
    const deep = join(dir, `claude-${process.getuid?.()}`, '.claude', 'commands');
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'p'), '');
    chmodSync(join(deep, 'p'), 0o444);
    chmodSync(deep, 0o500);
    releaseClaudeTmpdir(dir);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(`${dir}.owner`)).toBe(false);
  });

  it('makes no dir, and warns, when Claude would fall back to the shared dir', () => {
    const long = join(root, 'x'.repeat(CLAUDE_TMP_BUDGET));
    mkdirSync(long);
    const made = makeClaudeTmpdir(long);
    expect(made.dir).toBeUndefined();
    expect(made.warning).toMatch(/too long/);
  });

  it('makes none off Linux', () => {
    expect(makeClaudeTmpdir(root, 'darwin')).toEqual({});
  });

  it('never follows a symlink inside the dir', () => {
    const { dir } = makeClaudeTmpdir(root);
    if (!dir) throw new Error('no dir');
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep'), 'x');
    symlinkSync(outside, join(dir, 'link'));
    releaseClaudeTmpdir(dir);
    expect(existsSync(dir)).toBe(false);
    expect(readFileSync(join(outside, 'keep'), 'utf8')).toBe('x');
  });
});

describe.runIf(linux)('sweepClaudeTmpdirs', () => {
  it("removes a dir whose host is gone, in this namespace, and the dir's record", () => {
    const dir = leftDir('tacet-c-aB3dE9', { host: deadPid(), ns: ns() });
    expect(sweepClaudeTmpdirs(root)).toBe(1);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(`${dir}.owner`)).toBe(false);
  });

  it('keeps a dir whose host runs', () => {
    const dir = leftDir('tacet-c-aB3dE9', { host: process.pid, ns: ns() });
    expect(sweepClaudeTmpdirs(root)).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });

  it('keeps a dir from another PID namespace', () => {
    const dir = leftDir('tacet-c-aB3dE9', { host: deadPid(), ns: 'pid:[1]' });
    expect(sweepClaudeTmpdirs(root)).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });

  it('keeps a dir whose record has no namespace', () => {
    const dir = leftDir('tacet-c-aB3dE9', { host: deadPid(), ns: '' });
    expect(sweepClaudeTmpdirs(root)).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });

  it('trusts no record that is a link, has other links, or is not a file', () => {
    const owner = JSON.stringify({ host: deadPid(), ns: ns() });
    const real = join(root, 'real-record');
    writeFileSync(real, owner);
    const linked = leftDir('tacet-c-llllll');
    symlinkSync(real, `${linked}.owner`);
    const hard = leftDir('tacet-c-hhhhhh');
    spawnSync('ln', [real, `${hard}.owner`]);
    const dirRecord = leftDir('tacet-c-dddddd');
    mkdirSync(`${dirRecord}.owner`);
    expect(sweepClaudeTmpdirs(root)).toBe(0);
    for (const p of [linked, hard, dirRecord]) expect(existsSync(p)).toBe(true);
  });

  it.runIf(root0)("trusts no record of another user's", () => {
    const dir = leftDir('tacet-c-oooooo', { host: deadPid(), ns: ns() });
    chownSync(`${dir}.owner`, 4242, 4242);
    expect(sweepClaudeTmpdirs(root)).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });

  it('keeps a dir with no record, or an unreadable one, however old', () => {
    const none = leftDir('tacet-c-aaaaaa');
    const bad = leftDir('tacet-c-bbbbbb');
    writeFileSync(`${bad}.owner`, 'not json');
    const old = new Date(Date.now() - 365 * 24 * 3600 * 1000);
    spawnSync('touch', ['-d', old.toISOString(), none, bad]);
    expect(sweepClaudeTmpdirs(root)).toBe(0);
    expect(existsSync(none)).toBe(true);
    expect(existsSync(bad)).toBe(true);
  });

  it("keeps what is not Tacet's: another name, or not a dir", () => {
    const owner = { host: deadPid(), ns: ns() };
    const other = leftDir('tacet-cx-aaaaaa', owner);
    const longer = leftDir('tacet-c-aaaaaaa', owner);
    const review = leftDir('tacet-review-aaaaaa', owner);
    const file = join(root, 'tacet-c-cccccc');
    writeFileSync(file, 'x');
    writeFileSync(`${file}.owner`, JSON.stringify(owner));
    expect(sweepClaudeTmpdirs(root)).toBe(0);
    for (const p of [other, longer, review, file]) expect(existsSync(p)).toBe(true);
  });

  it('never follows or removes a symlink, even with a dead owner', () => {
    const target = join(root, 'target');
    mkdirSync(target);
    writeFileSync(join(target, 'keep'), 'x');
    const link = join(root, 'tacet-c-dddddd');
    symlinkSync(target, link);
    writeFileSync(`${link}.owner`, JSON.stringify({ host: deadPid(), ns: ns() }));
    expect(sweepClaudeTmpdirs(root)).toBe(0);
    expect(readlinkSync(link)).toBe(target);
    expect(readFileSync(join(target, 'keep'), 'utf8')).toBe('x');
  });

  it('never follows a symlink inside a dir it removes', () => {
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep'), 'x');
    const dir = leftDir('tacet-c-eeeeee', { host: deadPid(), ns: ns() });
    symlinkSync(outside, join(dir, 'link'));
    expect(sweepClaudeTmpdirs(root)).toBe(1);
    expect(readFileSync(join(outside, 'keep'), 'utf8')).toBe('x');
  });

  it.runIf(root0)("keeps another user's dir, even with a dead owner", () => {
    const dir = leftDir('tacet-c-ffffff', { host: deadPid(), ns: ns() });
    chownSync(dir, 4242, 4242);
    expect(sweepClaudeTmpdirs(root)).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });

  it('removes a record whose dir is gone, and only that', () => {
    const owner = JSON.stringify({ host: process.pid, ns: ns() });
    writeFileSync(join(root, 'tacet-c-gggggg.owner'), owner);
    writeFileSync(join(root, 'tacet-c-gggggg.owner.123'), owner);
    leftDir('tacet-c-hhhhhh', { host: process.pid, ns: ns() });
    expect(sweepClaudeTmpdirs(root)).toBe(0);
    expect(existsSync(join(root, 'tacet-c-gggggg.owner'))).toBe(false);
    expect(existsSync(join(root, 'tacet-c-gggggg.owner.123'))).toBe(true);
    expect(existsSync(join(root, 'tacet-c-hhhhhh.owner'))).toBe(true);
  });

  it('returns 0 for a root that is not there', () => {
    expect(sweepClaudeTmpdirs(join(root, 'none'))).toBe(0);
  });
});
