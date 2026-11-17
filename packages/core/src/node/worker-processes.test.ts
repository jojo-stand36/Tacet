import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  endMarkedProcesses,
  isProcessRunning,
  isWorkerMarker,
  markedProcesses,
  newWorkerMarker,
  type OrphanCandidate,
  type OrphanProbe,
  type ProcessInfo,
  parseLstart,
  processTable,
  unreadableOrphans,
  WORKER_MARKER_VAR,
  withTrees,
} from './worker-processes.js';

const alive = isProcessRunning;

const started: ChildProcess[] = [];

/**
 * A process carrying `marker` that starts a detached child (its own process group), as Claude Code
 * does with its Bash tools. Resolves with the grandchild's pid.
 */
function worker(marker: string, opts: { ignoreTerm?: boolean } = {}) {
  const ignore = opts.ignoreTerm ? "process.on('SIGTERM', () => {});" : '';
  const kid = `${ignore} setInterval(() => {}, 1000);`;
  const script = `${ignore}
    const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(kid)}], { detached: true, stdio: 'ignore' });
    c.unref();
    console.log(c.pid);
    setInterval(() => {}, 1000);`;
  const leader = spawn(process.execPath, ['-e', script], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', [WORKER_MARKER_VAR]: marker },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  started.push(leader);
  const grandchild = new Promise<number>((resolve) =>
    leader.stdout?.once('data', (b: Buffer) => {
      const pid = Number.parseInt(b.toString(), 10);
      grandchildren.push(pid);
      resolve(pid);
    }),
  );
  return { leader, grandchild };
}

const grandchildren: number[] = [];

afterEach(async () => {
  for (const p of started.splice(0)) p.kill('SIGKILL');
  for (const pid of grandchildren.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Gone.
    }
  }
});

describe.skipIf(process.platform === 'win32')('Worker processes by marker (#127)', () => {
  it('makes markers that only match their own form', () => {
    const m = newWorkerMarker();
    expect(isWorkerMarker(m)).toBe(true);
    for (const bad of ['', 'PATH=/usr/bin', '*', `${m}\n`, `${m} x`, 42]) {
      expect(isWorkerMarker(bad)).toBe(false);
    }
  });

  it('counts a zombie as not running, though kill(pid, 0) still reaches it', async () => {
    // The shell becomes `sleep 5` before its child `sleep 1` exits, and `sleep` never reaps it.
    const parent = spawn('sh', ['-c', 'sleep 1 & echo $!; exec sleep 5'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    started.push(parent);
    const zombie = await new Promise<number>((resolve) =>
      parent.stdout?.once('data', (b: Buffer) => resolve(Number.parseInt(b.toString(), 10))),
    );
    expect(isProcessRunning(zombie)).toBe(true);
    await expect.poll(() => isProcessRunning(zombie), { timeout: 4000 }).toBe(false);
    expect(() => process.kill(zombie, 0)).not.toThrow();
    expect(isProcessRunning(parent.pid as number)).toBe(true);
    expect(isProcessRunning(2 ** 22 + 12345)).toBe(false);
  });

  it('follows a found process by pid, even once its marker can no longer be read', async () => {
    const m = newWorkerMarker();
    const w = worker(m, { ignoreTerm: true });
    await w.grandchild;
    const pid = w.leader.pid as number;
    // The scan finds it once, then never again, as if its environment could no longer be read.
    let scans = 0;
    const find = () => new Map(scans++ === 0 ? [[m, [pid]]] : []);
    const ended = await endMarkedProcesses([m], { graceMs: 300, find });
    expect(ended).toEqual({ found: [pid], left: [] });
    await expect.poll(() => alive(pid)).toBe(false);
  });

  it('finds the processes that carry a marker, and no others', async () => {
    const mine = newWorkerMarker();
    const other = newWorkerMarker();
    const a = worker(mine);
    const b = worker(other);
    const kidA = await a.grandchild;
    await b.grandchild;
    const found = markedProcesses([mine, 'not-a-marker']);
    expect(found.get(mine)).toEqual(expect.arrayContaining([a.leader.pid, kidA]));
    expect(found.has(other)).toBe(false);
    expect(found.get(mine)).not.toContain(b.leader.pid);
    expect(markedProcesses([])).toEqual(new Map());
  });

  it('ends them, also in another session, and SIGKILLs what ignores SIGTERM', async () => {
    const m1 = newWorkerMarker();
    const m2 = newWorkerMarker();
    const a = worker(m1);
    const b = worker(m2, { ignoreTerm: true });
    const other = worker(newWorkerMarker());
    const kids = [await a.grandchild, await b.grandchild];
    const bystander = await other.grandchild;
    const pids = [a.leader.pid, b.leader.pid, ...kids] as number[];
    const ended = await endMarkedProcesses([m1, m2], { graceMs: 300 });
    expect(ended.found).toEqual(expect.arrayContaining(pids));
    expect(ended.left).toEqual([]);
    for (const pid of pids) await expect.poll(() => alive(pid)).toBe(false);
    expect(alive(bystander)).toBe(true);
    expect(alive(other.leader.pid as number)).toBe(true);
    expect(await endMarkedProcesses([m1, m2])).toEqual({ found: [], left: [] });
  });
});

describe('process trees of marked processes (#367)', () => {
  const row = (pid: number, ppid: number, pgid = pid, sid?: number): ProcessInfo => ({
    pid,
    ppid,
    pgid,
    ...(sid !== undefined ? { sid } : {}),
    zombie: false,
  });

  it('adds descendants, and members of groups and sessions they lead, and nothing else', () => {
    const m = newWorkerMarker();
    const table = [
      row(100, 50), // marked
      row(101, 100), // child
      row(102, 101), // grandchild
      row(200, 1, 100), // orphan still in the marked process's group
      row(201, 1, 201, 101), // orphan in a session the child leads (Linux)
      row(300, 1), // unrelated orphan
      row(301, 50, 50), // a sibling: same parent, the parent's group
      { ...row(103, 100), zombie: true },
    ];
    const out = withTrees(new Map([[m, [100]]]), table);
    expect(out.get(m)?.sort()).toEqual([100, 101, 102, 200, 201]);
  });

  it('never adds this process, and follows no group or session 0 or 1', () => {
    const m = newWorkerMarker();
    const table = [row(process.pid, 100), row(500, 1, 1, 0), row(501, 1, 0, 1)];
    expect(withTrees(new Map([[m, [100]]]), table).get(m)).toEqual([100]);
    expect(withTrees(new Map([[m, [1]]]), table).get(m)).toEqual([1]);
  });

  it.runIf(process.platform === 'linux')(
    'finds a child whose environment shows no marker through its marked parent',
    async () => {
      const m = newWorkerMarker();
      // `env -i` clears the child's environment, as macOS hides a platform binary's.
      const leader = spawn('/bin/sh', ['-c', 'env -i /bin/sleep 60 & wait'], {
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', [WORKER_MARKER_VAR]: m },
        stdio: 'ignore',
      });
      started.push(leader);
      let kid: number | undefined;
      await expect
        .poll(() => {
          kid = processTable().find((p) => p.ppid === leader.pid)?.pid;
          return kid;
        })
        .toBeDefined();
      grandchildren.push(kid as number);
      expect(markedProcesses([m]).get(m)).toEqual(
        expect.arrayContaining([leader.pid, kid as number]),
      );
      const ended = await endMarkedProcesses([m], { graceMs: 300 });
      expect(ended.found).toEqual(expect.arrayContaining([leader.pid, kid as number]));
      await expect.poll(() => alive(kid as number)).toBe(false);
    },
  );
});

describe('unreadable orphans on macOS (#367)', () => {
  const since = Date.UTC(2026, 10, 17, 10, 0, 0, 500);
  const dir = '/tmp';
  const real = realpathSync('/tmp');
  // Real directories: a working directory that does not exist is never taken.
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orph-base-')));
  for (const d of ['wt', 'wt-other', 'a', 'b']) mkdirSync(join(base, d));
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  const ok = (over: Partial<OrphanCandidate> = {}): OrphanCandidate => ({
    pid: 4242,
    ppid: 1,
    startMs: since + 2000,
    envHidden: true,
    command: '/bin/sleep 600',
    ...over,
  });
  const probe = (
    cands: OrphanCandidate[],
    cwds: Record<number, string>,
    platform: NodeJS.Platform = 'darwin',
  ): OrphanProbe & { asked: number[][] } => {
    const asked: number[][] = [];
    return {
      platform,
      asked,
      candidates: () => cands,
      cwdOf: (pids) => {
        asked.push([...pids]);
        return new Map(pids.flatMap((p) => (cwds[p] ? [[p, cwds[p]] as [number, string]] : [])));
      },
    };
  };

  it('takes an orphan whose environment is hidden, started since, in the directory', () => {
    const p = probe([ok()], { 4242: join(base, 'wt') });
    expect(unreadableOrphans([{ since, dir: base }], p)).toEqual([
      { pid: 4242, command: '/bin/sleep 600' },
    ]);
    // The same second as `since` counts: ps reports whole seconds.
    const same = probe([ok({ startMs: since - 500 })], { 4242: real });
    expect(unreadableOrphans([{ since, dir }], same)).toHaveLength(1);
  });

  it('takes nothing that fails any condition', () => {
    const cases: [string, OrphanCandidate, string | undefined][] = [
      ['has a live parent', ok({ ppid: 77 }), real],
      ['shows its environment', ok({ envHidden: false }), real],
      ['started before', ok({ startMs: since - 1500 }), real],
      ['start unknown', ok({ startMs: Number.NaN }), real],
      ['is this process', ok({ pid: process.pid }), real],
      ['runs elsewhere', ok(), '/var'],
      ['in a sibling named alike', ok(), join(base, 'wt-other')],
      ['cwd unknown', ok(), undefined],
      ['cwd not absolute', ok(), 'tmp'],
      ['cwd gone', ok(), join(real, `no-such-dir-${process.pid}`)],
    ];
    for (const [why, c, cwd] of cases) {
      const p = probe([c], cwd === undefined ? {} : { [c.pid]: cwd });
      expect(unreadableOrphans([{ since, dir: join(base, 'wt') }], p), why).toEqual([]);
    }
  });

  it('compares directories after symlinks', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'orph-')));
    try {
      mkdirSync(join(root, 'wt', 'sub'), { recursive: true });
      symlinkSync(join(root, 'wt'), join(root, 'link'));
      mkdirSync(join(root, 'link-not'));
      // The checkout named through a link: compared by its real path.
      const p = probe([ok()], { 4242: join(root, 'wt', 'sub') });
      expect(unreadableOrphans([{ since, dir: join(root, 'link') }], p)).toHaveLength(1);
      const out = probe([ok()], { 4242: join(root, 'link-not') });
      expect(unreadableOrphans([{ since, dir: join(root, 'link') }], out)).toEqual([]);
      // A working directory reported through a link is doubt: never taken.
      const viaLink = probe([ok()], { 4242: join(root, 'link', 'sub') });
      expect(unreadableOrphans([{ since, dir: join(root, 'wt') }], viaLink)).toEqual([]);
      // Nor anything for a checkout that cannot be resolved.
      const gone = probe([ok()], { 4242: join(root, 'wt', 'sub') });
      expect(unreadableOrphans([{ since, dir: join(root, 'gone') }], gone)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('matches each scope with its own start time', () => {
    const p = probe([ok({ startMs: since + 2000 })], { 4242: join(base, 'b') });
    const scopes = [
      { since, dir: join(base, 'a') },
      { since: since + 60_000, dir: join(base, 'b') },
    ];
    expect(unreadableOrphans(scopes, p)).toEqual([]);
    // The scope that started before it does take it.
    expect(unreadableOrphans([{ since, dir: join(base, 'b') }], p)).toHaveLength(1);
  });

  it('does nothing off macOS or with no scope, and asks for no working directory needlessly', () => {
    const linux = probe([ok()], { 4242: real }, 'linux');
    expect(unreadableOrphans([{ since, dir }], linux)).toEqual([]);
    const none = probe([ok({ ppid: 5 })], {});
    expect(unreadableOrphans([], none)).toEqual([]);
    expect(unreadableOrphans([{ since, dir }], none)).toEqual([]);
    expect(none.asked).toEqual([]);
  });

  it.runIf(process.platform === 'darwin')(
    'finds, with the real ps and lsof, an orphan with no environment in its directory',
    async () => {
      // `env -i` empties the environment, so `ps -E` adds nothing, as for a platform binary under
      // SIP; the short-lived parent leaves it orphaned (parent pid 1), each in its own directory.
      const here = realpathSync(mkdtempSync(join(tmpdir(), 'orph-live-')));
      const there = realpathSync(mkdtempSync(join(tmpdir(), 'orph-other-')));
      const since = Date.now();
      const orphanIn = (cwd: string): Promise<number> =>
        new Promise((done) => {
          const p = spawn(
            process.execPath,
            [
              '-e',
              "const c=require('node:child_process').spawn('/usr/bin/env',['-i','/bin/sleep','60'],{detached:true,stdio:'ignore'});console.log(c.pid);c.unref()",
            ],
            { cwd, stdio: ['ignore', 'pipe', 'ignore'] },
          );
          p.stdout?.once('data', (b: Buffer) => done(Number.parseInt(b.toString(), 10)));
        });
      const mine = await orphanIn(here);
      const other = await orphanIn(there);
      grandchildren.push(mine, other);
      try {
        await expect
          .poll(() => unreadableOrphans([{ since, dir: here }]).map((o) => o.pid), {
            timeout: 5000,
          })
          .toEqual([mine]);
      } finally {
        rmSync(here, { recursive: true, force: true });
        rmSync(there, { recursive: true, force: true });
      }
    },
  );

  it('reads ps lstart in UTC', () => {
    expect(parseLstart('Tue Nov 17 10:48:32 2026'.split(' '))).toBe(
      Date.UTC(2026, 10, 17, 10, 48, 32),
    );
    expect(parseLstart(['Tue', 'Xyz', '1', '00:00:00', '2026'])).toBeNaN();
  });

  it.runIf(process.platform !== 'win32')(
    'takes no orphan whose pid now names another process, and still reports when ps fails',
    async () => {
      const a = spawn('/bin/sleep', ['60'], { stdio: 'ignore', detached: true });
      a.unref();
      grandchildren.push(a.pid as number);
      const b = spawn('/bin/sleep', ['60'], { stdio: 'ignore', detached: true });
      b.unref();
      grandchildren.push(b.pid as number);
      const p = probe(
        [
          // Found with a start time it no longer has: the pid was reused meanwhile.
          ok({ pid: a.pid as number, startMs: Date.now(), start: 'Thu Jan  1 00:00:00 1970' }),
          ok({ pid: b.pid as number, startMs: Date.now() }),
        ],
        { [a.pid as number]: real, [b.pid as number]: real },
      );
      const ended = await endMarkedProcesses([newWorkerMarker()], {
        graceMs: 300,
        orphans: [{ since: Date.now() - 5000, dir }],
        probe: p,
        // The marker scan failing every round does not lose what was ended.
        find: () => {
          throw new Error('ps failed');
        },
      });
      expect(ended.found).toEqual([b.pid]);
      expect(ended.orphans).toEqual([{ pid: b.pid, command: '/bin/sleep 600' }]);
      await expect.poll(() => alive(b.pid as number)).toBe(false);
      expect(alive(a.pid as number)).toBe(true);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'never reports a process its marker found as an unmarked orphan',
    async () => {
      const m = newWorkerMarker();
      const w = worker(m);
      await w.grandchild;
      const pid = w.leader.pid as number;
      const p = probe([ok({ pid, startMs: Date.now() })], { [pid]: real });
      const ended = await endMarkedProcesses([m], {
        graceMs: 300,
        orphans: [{ since: Date.now() - 5000, dir }],
        probe: p,
      });
      expect(ended.found).toContain(pid);
      expect(ended.orphans).toEqual([]);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'ends the orphans it takes, and returns them for the caller to record',
    async () => {
      const victim = spawn('/bin/sleep', ['60'], { stdio: 'ignore', detached: true });
      victim.unref();
      grandchildren.push(victim.pid as number);
      const bystander = spawn('/bin/sleep', ['60'], { stdio: 'ignore', detached: true });
      bystander.unref();
      grandchildren.push(bystander.pid as number);
      const p = probe(
        [
          ok({ pid: victim.pid as number, startMs: Date.now() }),
          ok({ pid: bystander.pid as number, startMs: Date.now() }),
        ],
        { [victim.pid as number]: real, [bystander.pid as number]: '/var' },
      );
      const ended = await endMarkedProcesses([newWorkerMarker()], {
        graceMs: 300,
        orphans: [{ since: Date.now() - 5000, dir }],
        probe: p,
      });
      expect(ended).toEqual({
        found: [victim.pid],
        left: [],
        orphans: [{ pid: victim.pid, command: '/bin/sleep 600' }],
      });
      await expect.poll(() => alive(victim.pid as number)).toBe(false);
      expect(alive(bystander.pid as number)).toBe(true);
    },
  );
});
