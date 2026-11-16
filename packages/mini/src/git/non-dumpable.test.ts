import { execFileSync } from 'node:child_process';
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  makeNonDumpable,
  type NonDumpable,
  ownOwnerDirName,
  workerGitEnv,
  workerWorktree,
} from '@tacet/core/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { integrateWorktree, taskBranch } from './integrate.js';

/**
 * `tacet run` makes itself non-dumpable (#316). Its own `/proc/self/*` entries are then owned by
 * root (fs/proc/base.c `task_dump_owner`), and Tacet reads several of them: the fd directory
 * walk that copies a Worker's objects (`integrate.ts`), `/proc/self/fd/<n>` links (the PTY
 * transcript check), `/proc/self/ns/pid` (session files, the Codex adapter), `/proc/self/stat`
 * and `/proc/self/mountinfo`. This file makes its own Vitest worker non-dumpable (each test file
 * runs in a process of its own, Vitest's default `forks` pool) and checks they all still work.
 */
let hardened: NonDumpable = { state: 'unavailable', reason: 'not tried' };
const linuxFfi = process.platform === 'linux' && !!process.getBuiltinModule('node:ffi');

beforeAll(() => {
  if (linuxFfi) hardened = makeNonDumpable();
  if (hardened.state !== 'set') {
    process.stderr.write(
      `non-dumpable.test.ts: skipped: ${'reason' in hardened ? hardened.reason : ''}\n`,
    );
  }
});

describe('a non-dumpable Mini-conductor still reads its own /proc entries (#316)', () => {
  // On CI the Ubuntu Node 26 job has node:ffi, so the checks below must really run there.
  it.runIf(process.env.CI === 'true' && linuxFfi)('runs on CI wherever Node has node:ffi', () => {
    expect(hardened).toEqual({ state: 'set' });
  });

  it.skipIf(!linuxFfi)('reads /proc/self links, fds, stat and mountinfo', () => {
    if (hardened.state !== 'set') return;
    expect(readlinkSync('/proc/self/ns/pid')).toMatch(/^pid:\[\d+\]$/);
    expect(ownOwnerDirName()).toMatch(/^\d+-\d+-/);
    expect(ownOwnerDirName()).not.toMatch(/^0-/);
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tacet-nondump-')));
    try {
      writeFileSync(join(dir, 'f'), 'x');
      const fd = openSync(dir, 'r');
      try {
        expect(readlinkSync(`/proc/self/fd/${fd}`)).toBe(dir);
        expect(readdirSync(`/proc/self/fd/${fd}`)).toEqual(['f']);
        closeSync(openSync(`/proc/self/fd/${fd}/f`, 'r'));
      } finally {
        closeSync(fd);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(readFileSync('/proc/self/stat', 'utf8')).toMatch(/^\d+ /);
    expect(readFileSync('/proc/self/mountinfo', 'utf8').length).toBeGreaterThan(0);
  });

  describe('integrating a Worker commit', () => {
    let root = '';
    afterAll(() => {
      if (root) rmSync(root, { recursive: true, force: true });
    });

    it.skipIf(!linuxFfi)(
      "copies the Worker's objects through /proc/self/fd and moves its branch",
      { timeout: 30_000 },
      async () => {
        if (hardened.state !== 'set') return;
        root = realpathSync(mkdtempSync(join(tmpdir(), 'tacet-nondump-git-')));
        const repo = join(root, 'repo');
        mkdirSync(join(root, 'home'));
        const env = {
          PATH: process.env.PATH ?? '',
          HOME: join(root, 'home'),
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_AUTHOR_NAME: 'Tacet Test',
          GIT_AUTHOR_EMAIL: 'test@example.invalid',
          GIT_COMMITTER_NAME: 'Tacet Test',
          GIT_COMMITTER_EMAIL: 'test@example.invalid',
        };
        const git = (cwd: string, args: string[], extra: Record<string, string> = {}) =>
          execFileSync('git', ['-C', cwd, ...args], {
            env: { ...env, ...extra },
            encoding: 'utf8',
          }).trim();
        mkdirSync(repo);
        git(repo, ['init', '-q', '-b', 'main']);
        writeFileSync(join(repo, 'README'), 'hi\n');
        git(repo, ['add', 'README']);
        git(repo, ['commit', '-qm', 'init']);
        // A Worker checkout as the adapter leaves it: detached, with its own object store.
        const dir = join(root, 'wt');
        git(repo, ['worktree', 'add', '-q', '--detach', dir, 'main']);
        const wt = workerWorktree(dir, repo);
        if (!wt) throw new Error('not a worktree');
        mkdirSync(join(wt.gitDir, 'objects'), { recursive: true });
        const wenv = workerGitEnv(wt);
        writeFileSync(join(dir, 'a.txt'), 'a\n');
        git(dir, ['add', 'a.txt'], wenv);
        git(dir, ['commit', '-qm', 'add a.txt'], wenv);
        const sha = git(dir, ['rev-parse', 'HEAD'], wenv);

        const ref = taskBranch('01JTASK/1');
        expect(await integrateWorktree({ cwd: dir, repoRoot: repo, ref, env })).toEqual({
          commit: sha,
          ref,
        });
        expect(git(repo, ['rev-parse', ref])).toBe(sha);
        git(repo, ['fsck', '--no-progress']);
      },
    );
  });
});
