import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { workerGitEnv, workerWorktree } from '@tacet/core/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  commitWorktree,
  integrateWorktree,
  TACET_WORKER_IDENTITY,
  taskBranch,
  uncommittedChanges,
  WorktreeRefusedError,
} from './integrate.js';

/**
 * Integration of Worker commits (#119) against real git: a Worker in a linked worktree commits on
 * a detached HEAD into its own object store (#116); the Mini-conductor brings the commit into the
 * repo from outside the sandbox. The Worker controls everything in its worktree.
 */
describe('integrateWorktree', () => {
  let root: string;
  let repo: string;
  let env: Record<string, string>;

  const git = (cwd: string, args: string[], extra: Record<string, string> = {}, input?: string) =>
    execFileSync('git', ['-C', cwd, ...args], {
      env: { ...env, ...extra },
      encoding: 'utf8',
      ...(input !== undefined ? { input } : {}),
    }).trim();

  /** A Worker checkout as the adapter leaves it: detached, with its own object store. */
  const worker = (name: string) => {
    const dir = join(root, 'worktrees', name);
    git(repo, ['worktree', 'add', '-q', '--detach', dir, 'main']);
    const wt = workerWorktree(dir, repo);
    if (!wt) throw new Error('not a worktree');
    mkdirSync(join(wt.gitDir, 'objects'), { recursive: true });
    return { dir, wt, wenv: workerGitEnv(wt) };
  };
  type Worker = ReturnType<typeof worker>;
  const commitIn = (w: Worker, file: string, text: string) => {
    writeFileSync(join(w.dir, file), text);
    git(w.dir, ['add', file], w.wenv);
    git(w.dir, ['commit', '-qm', `add ${file}`], w.wenv);
    return git(w.dir, ['rev-parse', 'HEAD'], w.wenv);
  };
  const hasObject = (sha: string) => {
    try {
      git(repo, ['cat-file', '-e', sha]);
      return true;
    } catch {
      return false;
    }
  };
  const packs = () => readdirSync(join(repo, '.git', 'objects', 'pack')).sort();
  const integrate = (w: Worker, name: string, extra: { timeoutMs?: number } = {}) =>
    integrateWorktree({ cwd: w.dir, repoRoot: repo, ref: taskBranch(name), env, ...extra });
  const refExists = (name: string) => {
    try {
      git(repo, ['rev-parse', '--verify', '-q', taskBranch(name)]);
      return true;
    } catch {
      return false;
    }
  };
  /** Write a loose object of `type` into the Worker's store under `name` (default: its hash). */
  const looseObject = (w: Worker, type: string, body: Buffer, name?: string) => {
    const raw = Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]);
    const sha = name ?? createHash('sha1').update(raw).digest('hex');
    mkdirSync(join(w.wt.gitDir, 'objects', sha.slice(0, 2)), { recursive: true });
    writeFileSync(join(w.wt.gitDir, 'objects', sha.slice(0, 2), sha.slice(2)), deflateSync(raw));
    return sha;
  };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tacet-integrate-')));
    repo = join(root, 'repo');
    mkdirSync(join(root, 'home'));
    env = {
      PATH: process.env.PATH ?? '',
      HOME: join(root, 'home'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Tacet Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Tacet Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    };
    mkdirSync(repo);
    git(repo, ['init', '-q', '-b', 'main']);
    writeFileSync(join(repo, 'README'), 'hi\n');
    git(repo, ['add', 'README']);
    git(repo, ['commit', '-qm', 'init']);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('finds what a checkout changed, deleted or added beyond a commit, from the repo side (#261)', async () => {
    const w = worker('u');
    const main = git(repo, ['rev-parse', 'main']);
    const changes = (commit?: string) =>
      uncommittedChanges({ cwd: w.dir, repoRoot: repo, commit, env });
    expect(await changes(main)).toEqual([]);
    writeFileSync(join(w.dir, '.gitignore'), 'build/\n');
    mkdirSync(join(w.dir, 'build'));
    writeFileSync(join(w.dir, 'build', 'out.js'), 'x');
    writeFileSync(join(w.dir, 'README'), 'changed\n');
    writeFileSync(join(w.dir, 'new.txt'), 'new\n');
    // The Worker hides its change in its own index: the check never reads that index.
    git(w.dir, ['update-index', '--assume-unchanged', 'README'], w.wenv);
    const found = (await changes(main))?.sort((a, b) => (a.path < b.path ? -1 : 1));
    expect(found).toEqual([
      { path: '.gitignore', untracked: true },
      { path: 'README', untracked: false },
      { path: 'new.txt', untracked: true },
    ]);
    // Without a commit, the Worker's HEAD (here still main) is the one compared with.
    expect((await changes())?.length).toBe(3);
    // A deletion counts too.
    rmSync(join(w.dir, 'README'));
    expect((await changes(main))?.some((c) => c.path === 'README' && !c.untracked)).toBe(true);
  });

  it("never runs a filter a Worker's .gitattributes names, and reports a self-ignoring .gitignore (#261)", async () => {
    // A clean filter in the user's own config, which a Worker-written attribute would name.
    const ran = join(root, 'filter-ran');
    git(repo, ['config', '--global', 'filter.evil.clean', `touch ${ran}; cat`]);
    const w = worker('attr');
    const main = git(repo, ['rev-parse', 'main']);
    writeFileSync(join(w.dir, '.gitattributes'), '* filter=evil\n');
    writeFileSync(join(w.dir, 'README'), 'changed\n');
    const found = await uncommittedChanges({ cwd: w.dir, repoRoot: repo, commit: main, env });
    expect(existsSync(ran)).toBe(false);
    expect(found?.map((c) => c.path).sort()).toEqual(['.gitattributes', 'README']);
    // A new .gitignore that ignores everything, itself included, still shows.
    const v = worker('ign');
    writeFileSync(join(v.dir, '.gitignore'), '*\n');
    mkdirSync(join(v.dir, 'sub'));
    writeFileSync(join(v.dir, 'sub', '.gitignore'), '*\n');
    writeFileSync(join(v.dir, 'hidden.txt'), 'x\n');
    const hidden = await uncommittedChanges({ cwd: v.dir, repoRoot: repo, commit: main, env });
    expect(hidden?.map((c) => c.path).sort()).toEqual(['.gitignore', 'sub/.gitignore']);
    // The compared commit's attributes are the ones used: a filter it names does run.
    const x = worker('attr2');
    writeFileSync(join(x.dir, '.gitattributes'), '* filter=evil\n');
    git(x.dir, ['add', '.gitattributes'], x.wenv);
    git(x.dir, ['commit', '-qm', 'attrs'], x.wenv);
    await integrateWorktree({ cwd: x.dir, repoRoot: repo, ref: taskBranch('attr2'), env });
    const own = git(repo, ['rev-parse', taskBranch('attr2')]);
    writeFileSync(join(x.dir, 'README'), 'changed\n');
    await uncommittedChanges({ cwd: x.dir, repoRoot: repo, commit: own, env });
    expect(existsSync(ran)).toBe(true);
  });

  it('honours a committed .gitignore, stops at maxPaths, and reads FIFOs and symlinks as data (#261)', async () => {
    writeFileSync(join(repo, '.gitignore'), 'build/\n');
    git(repo, ['add', '.gitignore']);
    git(repo, ['commit', '-qm', 'ignore build']);
    const main = git(repo, ['rev-parse', 'main']);
    const w = worker('cap');
    mkdirSync(join(w.dir, 'build'));
    writeFileSync(join(w.dir, 'build', 'out.js'), 'x');
    for (let i = 0; i < 30; i += 1) writeFileSync(join(w.dir, `f${i}.txt`), `${i}\n`);
    const all = await uncommittedChanges({ cwd: w.dir, repoRoot: repo, commit: main, env });
    expect(all).toHaveLength(30);
    expect(all?.some((c) => c.path.startsWith('build/'))).toBe(false);
    const some = await uncommittedChanges({
      cwd: w.dir,
      repoRoot: repo,
      commit: main,
      env,
      maxPaths: 7,
    });
    expect(some).toHaveLength(7);
    // A FIFO does not hang the check (git cannot track one, so it is no change); a symlink to a
    // file outside is a change of its own, not followed.
    const v = worker('odd');
    execFileSync('mkfifo', [join(v.dir, 'pipe')]);
    writeFileSync(join(root, 'outside.txt'), 'secret\n');
    symlinkSync(join(root, 'outside.txt'), join(v.dir, 'link'));
    const odd = await uncommittedChanges({
      cwd: v.dir,
      repoRoot: repo,
      commit: main,
      env,
      timeoutMs: 20_000,
    });
    expect(odd).toEqual([{ path: 'link', untracked: true }]);
  });

  describe('commitWorktree (#260)', () => {
    const protectedPath = (p: string) => p.startsWith('.claude/');
    const commitFor = (
      w: Worker,
      name: string,
      extra: Partial<Parameters<typeof commitWorktree>[0]> = {},
    ) =>
      commitWorktree({
        cwd: w.dir,
        repoRoot: repo,
        ref: taskBranch(name),
        message: 'do the work\n\nTacet-Task: t',
        protectedPath,
        env,
        ...extra,
      });

    it("commits changed, deleted and new files as Tacet's own Worker, unsigned, and moves the checkout to it", async () => {
      // Signing would fail: the commit must not try.
      git(repo, ['config', '--global', 'commit.gpgSign', 'true']);
      git(repo, ['config', '--global', 'gpg.program', 'false']);
      git(repo, ['config', '--global', 'user.name', 'The User']);
      git(repo, ['config', '--global', 'user.email', 'user@example.invalid']);
      writeFileSync(join(repo, 'gone.txt'), 'bye\n');
      git(repo, ['add', 'gone.txt']);
      git(repo, ['commit', '-qm', 'gone', '--no-gpg-sign']);
      const main = git(repo, ['rev-parse', 'main']);
      const w = worker('c1');
      writeFileSync(join(w.dir, 'README'), 'changed\n');
      rmSync(join(w.dir, 'gone.txt'));
      writeFileSync(join(w.dir, 'new.txt'), 'new\n');
      const r = await commitFor(w, 'c1');
      if (!r || !('commit' in r)) throw new Error(`no commit: ${JSON.stringify(r)}`);
      expect(r.paths.sort()).toEqual(['README', 'gone.txt', 'new.txt']);
      expect(git(repo, ['rev-parse', taskBranch('c1')])).toBe(r.commit);
      expect(git(repo, ['rev-parse', `${r.commit}^`])).toBe(main);
      expect(git(repo, ['log', '-1', '--format=%an <%ae>|%cn <%ce>', r.commit])).toBe(
        `${TACET_WORKER_IDENTITY.name} <${TACET_WORKER_IDENTITY.email}>|${TACET_WORKER_IDENTITY.name} <${TACET_WORKER_IDENTITY.email}>`,
      );
      expect(git(repo, ['cat-file', 'commit', r.commit])).not.toContain('gpgsig');
      expect(git(repo, ['log', '-1', '--format=%B', r.commit])).toBe(
        'do the work\n\nTacet-Task: t',
      );
      expect(git(repo, ['show', `${r.commit}:new.txt`])).toBe('new');
      expect(() => git(repo, ['cat-file', '-e', `${r.commit}:gone.txt`])).toThrow();
      // The checkout is at the commit, detached, and clean by its own index too.
      expect(git(w.dir, ['rev-parse', 'HEAD'], w.wenv)).toBe(r.commit);
      expect(() => git(w.dir, ['symbolic-ref', '-q', 'HEAD'], w.wenv)).toThrow();
      expect(git(w.dir, ['status', '--porcelain'], w.wenv)).toBe('');
      expect(
        await uncommittedChanges({ cwd: w.dir, repoRoot: repo, commit: r.commit, env }),
      ).toEqual([]);
      // Nothing more: no commit. More work: a commit on top of the last.
      expect(await commitFor(w, 'c1', { parent: r.commit })).toBeUndefined();
      writeFileSync(join(w.dir, 'more.txt'), 'more\n');
      const next = await commitFor(w, 'c1', { parent: r.commit });
      if (!next || !('commit' in next)) throw new Error('no second commit');
      expect(git(repo, ['rev-parse', `${next.commit}^`])).toBe(r.commit);
      expect(next.paths).toEqual(['more.txt']);
    });

    it('commits again when the checkout was left at its parent after a failed HEAD write', async () => {
      const w = worker('c6');
      const main = git(repo, ['rev-parse', 'main']);
      writeFileSync(join(w.dir, 'work.txt'), 'work\n');
      const first = await commitFor(w, 'c6');
      if (!first || !('commit' in first)) throw new Error('no commit');
      // The index moved, then the HEAD write failed: HEAD is still the parent.
      git(w.dir, ['update-ref', '--no-deref', 'HEAD', main], w.wenv);
      const again = await commitFor(w, 'c6');
      if (!again || !('commit' in again)) throw new Error('no second commit');
      expect(again.paths).toEqual(['work.txt']);
      expect(git(w.dir, ['rev-parse', 'HEAD'], w.wenv)).toBe(again.commit);
      expect(git(w.dir, ['status', '--porcelain'], w.wenv)).toBe('');
    });

    it('stores a symlink as a link, never what it points at', async () => {
      const w = worker('c2');
      writeFileSync(join(root, 'outside.txt'), 'secret\n');
      symlinkSync(join(root, 'outside.txt'), join(w.dir, 'link'));
      const r = await commitFor(w, 'c2');
      if (!r || !('commit' in r)) throw new Error('no commit');
      const entry = git(repo, ['ls-tree', r.commit, 'link']);
      expect(entry).toMatch(/^120000 blob /);
      expect(git(repo, ['cat-file', '-p', `${r.commit}:link`])).toBe(join(root, 'outside.txt'));
    });

    it('refuses protected config, committing nothing', async () => {
      const w = worker('c3');
      mkdirSync(join(w.dir, '.claude'));
      writeFileSync(join(w.dir, '.claude', 'settings.json'), '{}\n');
      writeFileSync(join(w.dir, 'work.txt'), 'work\n');
      expect(await commitFor(w, 'c3')).toEqual({
        refused: { why: 'protected', paths: ['.claude/settings.json'] },
      });
      expect(refExists('c3')).toBe(false);
    });

    it('refuses a change too big, by files or bytes, committing nothing', async () => {
      const w = worker('c4');
      for (let i = 0; i < 4; i += 1) writeFileSync(join(w.dir, `f${i}.txt`), 'x'.repeat(100));
      // Over the file cap: it stops counting at one over.
      expect(await commitFor(w, 'c4', { maxFiles: 3 })).toEqual({
        refused: { why: 'too-big', bytes: 400, files: 4 },
      });
      expect(await commitFor(w, 'c4', { maxBytes: 399 })).toEqual({
        refused: { why: 'too-big', bytes: 400, files: 4 },
      });
      expect(refExists('c4')).toBe(false);
      const r = await commitFor(w, 'c4', { maxFiles: 4, maxBytes: 400 });
      expect(r && 'commit' in r ? r.paths.length : 0).toBe(4);
    });

    it("leaves out skipped paths and nested repositories, and runs no filter a Worker's .gitattributes names", async () => {
      const ran = join(root, 'filter-ran');
      git(repo, ['config', '--global', 'filter.evil.clean', `touch ${ran}; cat`]);
      const w = worker('c5');
      writeFileSync(join(w.dir, '.gitattributes'), '* filter=evil\n');
      writeFileSync(join(w.dir, 'package.json'), '');
      writeFileSync(join(w.dir, 'work.txt'), 'work\n');
      mkdirSync(join(w.dir, 'nested'));
      git(join(w.dir, 'nested'), ['init', '-q']);
      writeFileSync(join(w.dir, 'nested', 'x'), 'x\n');
      git(join(w.dir, 'nested'), ['add', 'x']);
      git(join(w.dir, 'nested'), ['commit', '-qm', 'x']);
      const r = await commitFor(w, 'c5', { skip: (c) => c.path === 'package.json' });
      if (!r || !('commit' in r)) throw new Error('no commit');
      expect(r.paths.sort()).toEqual(['.gitattributes', 'work.txt']);
      expect(existsSync(ran)).toBe(false);
      expect(git(repo, ['ls-tree', '--name-only', r.commit]).split('\n').sort()).toEqual([
        '.gitattributes',
        'README',
        'work.txt',
      ]);
    });
  });

  it('cannot tell, rather than read the Worker store, for a commit only the Worker has (#261)', async () => {
    const w = worker('v');
    const own = commitIn(w, 'mine.txt', 'mine\n');
    expect(hasObject(own)).toBe(false);
    expect(await uncommittedChanges({ cwd: w.dir, repoRoot: repo, env })).toBeUndefined();
    expect(
      await uncommittedChanges({ cwd: w.dir, repoRoot: repo, commit: own, env }),
    ).toBeUndefined();
  });

  it('brings a Worker commit into the repo under its task branch, and gc works again', async () => {
    const w = worker('t1');
    const sha = commitIn(w, 'a.txt', 'a\n');
    expect(hasObject(sha)).toBe(false);
    // Before integration the repo's own gc trips over the Worker's HEAD.
    expect(() => git(repo, ['gc', '-q'])).toThrow();

    const ref = taskBranch('01JTASK/1');
    expect(ref).toBe('refs/heads/tacet/01JTASK/1');
    expect(await integrate(w, '01JTASK/1')).toEqual({ commit: sha, ref });
    expect(git(repo, ['rev-parse', ref])).toBe(sha);
    git(repo, ['gc', '-q']);
    git(repo, ['fsck', '--no-progress']);
    // Again with nothing new: idempotent; then a second commit moves the branch on.
    expect(await integrate(w, '01JTASK/1')).toEqual({ commit: sha, ref });
    const next = commitIn(w, 'b.txt', 'b\n');
    expect(await integrate(w, '01JTASK/1')).toEqual({ commit: next, ref });
  });

  it('reports nothing for a turn without a commit, and does not move a branch', async () => {
    const w = worker('idle');
    expect(await integrate(w, 'idle')).toBeUndefined();
    expect(refExists('idle')).toBe(false);
  });

  it.each([
    ['first', 'second'],
    ['second', 'first'],
  ])(
    'integrates two Workers with unintegrated commits in either order (%s first)',
    async (a, b) => {
      const ws: Record<string, Worker> = { first: worker('w1'), second: worker('w2') };
      const shas: Record<string, string> = {
        first: commitIn(ws.first as Worker, 'one.txt', '1\n'),
        second: commitIn(ws.second as Worker, 'two.txt', '2\n'),
      };
      for (const k of [a, b] as string[]) {
        await integrate(ws[k] as Worker, `task-${k}`);
        expect(git(repo, ['rev-parse', taskBranch(`task-${k}`)])).toBe(shas[k]);
      }
      git(repo, ['gc', '-q']);
    },
  );

  it('integrates a Worker on a branch HEAD (no sandbox), whose commits are already shared', async () => {
    const dir = join(root, 'worktrees', 'claude');
    git(repo, ['worktree', 'add', '-q', dir, '-b', 'feature']);
    writeFileSync(join(dir, 'c.txt'), 'c\n');
    git(dir, ['add', 'c.txt']);
    git(dir, ['commit', '-qm', 'c']);
    const sha = git(dir, ['rev-parse', 'HEAD']);
    const result = await integrateWorktree({
      cwd: dir,
      repoRoot: repo,
      ref: taskBranch('t-claude'),
      env,
    });
    expect(result?.commit).toBe(sha);
  });

  it('only ever writes branches under refs/heads/tacet/', async () => {
    const w = worker('ref');
    commitIn(w, 'r.txt', 'r\n');
    await expect(
      integrateWorktree({ cwd: w.dir, repoRoot: repo, ref: 'refs/heads/main', env }),
    ).rejects.toThrow(/refs\/heads\/tacet/);
  });

  describe('refuses a forged checkout without running git or a hook in it', () => {
    const marker = () => join(root, 'hook-ran');
    const evilDir = (w: Worker) => {
      const evil = join(w.dir, 'evil');
      mkdirSync(join(evil, 'hooks'), { recursive: true });
      writeFileSync(join(evil, 'config'), `[core]\n\thooksPath = ${join(evil, 'hooks')}\n`);
      for (const h of ['reference-transaction', 'post-index-change']) {
        writeFileSync(join(evil, 'hooks', h), `#!/bin/sh\ntouch ${marker()}\n`, { mode: 0o755 });
      }
      return evil;
    };
    it.each([
      ['commondir', (w: Worker) => writeFileSync(join(w.wt.gitDir, 'commondir'), evilDir(w))],
      ['.git file', (w: Worker) => writeFileSync(join(w.dir, '.git'), `gitdir: ${evilDir(w)}\n`)],
      ['config.worktree', (w: Worker) => writeFileSync(join(w.wt.gitDir, 'config.worktree'), '')],
      [
        'HEAD symlink',
        (w: Worker) => {
          rmSync(join(w.wt.gitDir, 'HEAD'));
          symlinkSync(join(repo, '.git', 'HEAD'), join(w.wt.gitDir, 'HEAD'));
        },
      ],
      [
        'HEAD naming another ref kind',
        (w: Worker) => writeFileSync(join(w.wt.gitDir, 'HEAD'), 'ref: refs/remotes/origin/main\n'),
      ],
    ])('%s', async (_name, tamper) => {
      const w = worker('evil');
      commitIn(w, 'e.txt', 'e\n');
      tamper(w);
      await expect(integrate(w, 'evil')).rejects.toBeInstanceOf(WorktreeRefusedError);
      expect(existsSync(marker())).toBe(false);
      expect(refExists('evil')).toBe(false);
    });
  });

  describe('rejects forged objects: nothing lands in the shared store and no branch moves', () => {
    const tree = (w: Worker, entryName: string) => {
      const blob = looseObject(w, 'blob', Buffer.from('x\n'));
      return looseObject(
        w,
        'tree',
        Buffer.concat([Buffer.from(`100644 ${entryName}\0`), Buffer.from(blob, 'hex')]),
      );
    };
    const commit = (w: Worker, treeSha: string, author = 'x <x@example.invalid> 0 +0000') =>
      looseObject(
        w,
        'commit',
        Buffer.from(
          `tree ${treeSha}\nparent ${git(repo, ['rev-parse', 'main'])}\nauthor ${author}\ncommitter ${author}\n\nforged\n`,
        ),
      );
    it.each([
      ['a commit whose tree exists nowhere', (w: Worker) => commit(w, 'a'.repeat(40))],
      ['a malformed author line', (w: Worker) => commit(w, tree(w, 'ok.txt'), 'x <bad 0 +0000')],
      ['a tree with a .git entry', (w: Worker) => commit(w, tree(w, '.git'))],
      [
        'an object stored under the wrong name',
        (w: Worker) => {
          const real = tree(w, 'ok.txt');
          const forgedName = `${real.slice(0, 39)}${real.endsWith('0') ? '1' : '0'}`;
          looseObject(
            w,
            'tree',
            Buffer.concat([Buffer.from('100644 other.txt\0'), Buffer.alloc(20, 7)]),
            forgedName,
          );
          return commit(w, forgedName);
        },
      ],
    ])('%s', async (_name, forge) => {
      const w = worker('forged');
      const before = packs();
      const head = forge(w);
      writeFileSync(join(w.wt.gitDir, 'HEAD'), `${head}\n`);
      await expect(integrate(w, 'forged')).rejects.toThrow();
      expect(hasObject(head)).toBe(false);
      expect(packs()).toEqual(before);
      expect(refExists('forged')).toBe(false);
      expect(
        readdirSync(join(repo, '.git')).filter((f) => f.startsWith('tacet-incoming-')),
      ).toEqual([]);
    });
  });

  it('never follows the Worker store to other repositories (alternates, symlinks)', async () => {
    const other = join(root, 'other');
    mkdirSync(other);
    git(other, ['init', '-q', '-b', 'main']);
    writeFileSync(join(other, 'secret'), 'SECRET\n');
    git(other, ['add', 'secret']);
    git(other, ['commit', '-qm', 'secret']);
    const secret = git(other, ['rev-parse', 'HEAD']);
    const w = worker('thief');
    mkdirSync(join(w.wt.gitDir, 'objects', 'info'), { recursive: true });
    writeFileSync(
      join(w.wt.gitDir, 'objects', 'info', 'alternates'),
      `${join(other, '.git', 'objects')}\n`,
    );
    symlinkSync(
      join(other, '.git', 'objects', secret.slice(0, 2)),
      join(w.wt.gitDir, 'objects', secret.slice(0, 2)),
    );
    writeFileSync(join(w.wt.gitDir, 'HEAD'), `${secret}\n`);
    await expect(integrate(w, 'thief')).rejects.toThrow();
    expect(hasObject(secret)).toBe(false);
    expect(refExists('thief')).toBe(false);
  });

  it('does not hang on FIFOs planted in the Worker store or as its HEAD', async () => {
    const w = worker('fifo');
    const sha = commitIn(w, 'f.txt', 'f\n');
    mkdirSync(join(w.wt.gitDir, 'objects', 'info'), { recursive: true });
    execFileSync('mkfifo', [join(w.wt.gitDir, 'objects', 'info', 'alternates')]);
    // The alternates file is never read: integration completes.
    expect(await integrate(w, 'fifo', { timeoutMs: 10_000 })).toEqual({
      commit: sha,
      ref: taskBranch('fifo'),
    });
    rmSync(join(w.wt.gitDir, 'HEAD'));
    execFileSync('mkfifo', [join(w.wt.gitDir, 'HEAD')]);
    await expect(integrate(w, 'fifo', { timeoutMs: 10_000 })).rejects.toBeInstanceOf(
      WorktreeRefusedError,
    );
  }, 20_000);

  it('refuses a Worker store with packs', async () => {
    const w = worker('packed');
    commitIn(w, 'p.txt', 'p\n');
    git(w.dir, ['repack', '-adq'], w.wenv);
    await expect(integrate(w, 'packed')).rejects.toThrow(/packs/);
  });

  it('keeps its working copies inside the repo .git and leaves none behind', async () => {
    const w = worker('clean');
    commitIn(w, 'k.txt', 'k\n');
    // Only the integrator's own prefixes: other test files create and remove `tacet-*` temp
    // dirs in parallel.
    const own = () => readdirSync(tmpdir()).filter((f) => /^tacet-(snapshot|incoming)-/.test(f));
    const tmpBefore = own();
    await integrate(w, 'clean');
    expect(own()).toEqual(tmpBefore);
    expect(readdirSync(join(repo, '.git')).filter((f) => f.startsWith('tacet-'))).toEqual([]);
  });

  it('records no commit for a HEAD set to an existing branch tip', async () => {
    git(repo, ['branch', 'release']);
    git(repo, ['commit', '--allow-empty', '-qm', 'later on main']);
    const w = worker('borrow');
    writeFileSync(join(w.wt.gitDir, 'HEAD'), `${git(repo, ['rev-parse', 'release'])}\n`);
    expect(await integrate(w, 'borrow')).toBeUndefined();
    expect(refExists('borrow')).toBe(false);
  });

  it('records no commit when the main checkout is on another branch', async () => {
    const w = worker('base');
    git(repo, ['checkout', '-q', '-b', 'elsewhere']);
    git(repo, ['commit', '--allow-empty', '-qm', 'unrelated']);
    expect(await integrate(w, 'base')).toBeUndefined();
  });

  it('counts empty files against the size cap', async () => {
    const w = worker('many');
    commitIn(w, 'm.txt', 'm\n');
    mkdirSync(join(w.wt.gitDir, 'objects', 'ee'), { recursive: true });
    for (let i = 0; i < 300; i++) {
      writeFileSync(join(w.wt.gitDir, 'objects', 'ee', i.toString(16).padStart(38, '0')), '');
    }
    await expect(
      integrateWorktree({
        cwd: w.dir,
        repoRoot: repo,
        ref: taskBranch('many'),
        env,
        maxBytes: 64 * 4096,
      }),
    ).rejects.toThrow(/too large/);
  });
});
