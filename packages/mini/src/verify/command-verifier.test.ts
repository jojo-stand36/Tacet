import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task, VerifyCommandResult } from '@tacet/core';
import { isProcessRunning, newWorkerMarker } from '@tacet/core/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type VerifyContext, WorktreeRefusedError } from '../daemon/ports.js';
import { CommandVerifier } from './command-verifier.js';

const TASK = { id: 't/1' } as Task;

describe('CommandVerifier (#19)', () => {
  let root: string;
  let repo: string;
  let wt: string;
  let commit: string;
  /** Pids a command reported, ended after each test whatever happened. */
  const started: number[] = [];
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    }).trim();

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tacet-verify-')));
    repo = join(root, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    writeFileSync(join(repo, 'README'), 'x\n');
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'init');
    wt = join(root, 'wt');
    git(repo, 'worktree', 'add', '-q', '--detach', wt, 'main');
    commit = git(wt, 'rev-parse', 'HEAD');
  });
  afterEach(() => {
    for (const pid of started.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  });

  const verifier = (
    commands: string[],
    extra: { timeoutMs?: number; env?: Record<string, string> } = {},
  ) =>
    new CommandVerifier({
      repoRoot: repo,
      commands,
      env: extra.env ?? { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root },
      killGraceMs: 500,
      ...(extra.timeoutMs !== undefined ? { timeoutMs: extra.timeoutMs } : {}),
    });
  const ctx = (
    over: Partial<VerifyContext> = {},
  ): VerifyContext & { seen: VerifyCommandResult[] } => {
    const seen: VerifyCommandResult[] = [];
    return {
      commit,
      signal: new AbortController().signal,
      marker: newWorkerMarker(),
      onCommand: (r) => seen.push(r),
      seen,
      ...over,
    };
  };
  const ws = () => ({ id: 'w1', path: wt });

  it('passes when every command passes, in order, with nothing to tell the Worker', async () => {
    const c = ctx();
    const r = await verifier(['true', 'echo two > /dev/null']).verify(TASK, ws(), c);
    expect(r).toMatchObject({ status: 'passed', commands: ['true', 'echo two > /dev/null'] });
    expect(r.feedback).toBeUndefined();
    expect(c.seen.map((x) => [x.command, x.status, x.exitCode])).toEqual([
      ['true', 'passed', 0],
      ['echo two > /dev/null', 'passed', 0],
    ]);
  });

  it('stops at the first failure and gives the Worker the end of its output, redacted', async () => {
    const c = ctx();
    const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCD';
    // The command prints the key without holding it: what is redacted is its output.
    const printKey = `printf 'key %s%s\\n' ${key.slice(0, 20)} ${key.slice(20)}`;
    const r = await verifier([`echo "lots of output"; ${printKey}; exit 3`, 'true']).verify(
      TASK,
      ws(),
      c,
    );
    expect(r.status).toBe('failed');
    expect(c.seen.map((x) => x.status)).toEqual(['failed']);
    expect(c.seen[0]?.exitCode).toBe(3);
    expect(r.feedback).toMatch(/^Verification failed: `echo .*` exited with code 3\./);
    expect(r.feedback).toContain('lots of output');
    expect(r.feedback).toMatch(/key \[redacted\]/);
    expect(r.notes).toContain('command output, untrusted');
    for (const text of [r.feedback, r.notes]) expect(text).not.toContain(key);
  });

  it('runs commands as Worker code: Worker environment, CI=true, the marker, in the checkout', async () => {
    const c = ctx();
    const out = join(root, 'env.txt');
    const r = await verifier([`env > ${out}; pwd >> ${out}`], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root },
    }).verify(TASK, ws(), c);
    expect(r.status).toBe('passed');
    const seen = readFileSync(out, 'utf8');
    expect(seen).toContain('CI=true');
    expect(seen).toContain(`TACET_WORKER_MARKER=${c.marker}`);
    expect(seen.trim().split('\n').at(-1)).toBe(wt);
    // Only what it was given: nothing of the test process's environment besides that.
    expect(seen).not.toMatch(/^VITEST=/m);
  });

  it('ends a command that runs too long, and what it started', async () => {
    const c = ctx();
    const pidFile = join(root, 'pid');
    const r = await verifier([`sleep 60 & echo $! > ${pidFile}; sleep 60`], {
      timeoutMs: 300,
    }).verify(TASK, ws(), c);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    started.push(pid);
    expect(r.status).toBe('failed');
    expect(c.seen[0]?.status).toBe('timed_out');
    expect(r.feedback).toMatch(/ran longer than 0 s and was stopped/);
    await expect.poll(() => isProcessRunning(pid)).toBe(false);
  });

  it('ends a server a passing command left running in the background', async () => {
    const pidFile = join(root, 'pid');
    // setsid: out of the command's process group, like a daemon; the marker still finds it.
    const r = await verifier([`setsid sleep 60 > /dev/null 2>&1 & echo $! > ${pidFile}`]).verify(
      TASK,
      ws(),
      ctx(),
    );
    const pid = Number(readFileSync(pidFile, 'utf8'));
    started.push(pid);
    expect(r.status).toBe('passed');
    await expect.poll(() => isProcessRunning(pid)).toBe(false);
  });

  it('stops when aborted, and reports the run as not run', async () => {
    const abort = new AbortController();
    const c = ctx({ signal: abort.signal });
    const run = verifier(['sleep 60', 'true']).verify(TASK, ws(), c);
    setTimeout(() => abort.abort(), 200);
    const r = await run;
    expect(r.status).toBe('not_run');
    expect(c.seen.map((x) => x.status)).toEqual(['aborted']);
  });

  it('fails a checkout that is not exactly the integrated commit, before running anything', async () => {
    const touched = join(root, 'ran');
    const cmd = `touch ${touched}`;
    // An uncommitted change to a tracked file.
    writeFileSync(join(wt, 'README'), 'changed\n');
    let r = await verifier([cmd]).verify(TASK, ws(), ctx());
    expect(r).toMatchObject({ status: 'failed', results: [] });
    expect(r.feedback).toMatch(/1 changed tracked file.* commit it/);
    git(wt, 'checkout', '--', 'README');
    // An untracked file that is not ignored; an ignored one is fine.
    writeFileSync(join(wt, 'new.txt'), 'x');
    r = await verifier([cmd]).verify(TASK, ws(), ctx());
    expect(r.feedback).toMatch(/1 untracked file/);
    rmSync(join(wt, 'new.txt'));
    execFileSync('mkdir', ['-p', join(wt, 'node_modules')]);
    writeFileSync(join(wt, 'node_modules', 'dep.js'), 'x');
    // Another commit than the integrated one.
    r = await verifier([cmd]).verify(TASK, ws(), ctx({ commit: '0'.repeat(40) }));
    expect(r.feedback).toMatch(/not the integrated commit/);
    expect(() => readFileSync(touched)).toThrow();
    r = await verifier([cmd]).verify(TASK, ws(), ctx());
    expect(r.status).toBe('passed');
  });

  it('fails when the commands themselves changed the checkout', async () => {
    const r = await verifier(['echo formatted > README']).verify(TASK, ws(), ctx());
    expect(r.status).toBe('failed');
    expect(r.feedback).toMatch(/passed, but then the checkout has 1 changed tracked file/);
  });

  it('refuses the main checkout and anything that is not a linked worktree', async () => {
    await expect(
      verifier(['true']).verify(TASK, { id: 'main', path: repo }, ctx()),
    ).rejects.toThrow(WorktreeRefusedError);
    const other = join(root, 'other');
    execFileSync('git', ['init', '-q', other]);
    await expect(verifier(['true']).verify(TASK, { id: 'x', path: other }, ctx())).rejects.toThrow(
      WorktreeRefusedError,
    );
  });

  it('passes with no commands, without looking at the checkout', async () => {
    const r = await verifier([]).verify(TASK, { id: 'none', path: join(root, 'missing') }, ctx());
    expect(r).toMatchObject({ status: 'passed', commands: [] });
  });
});
