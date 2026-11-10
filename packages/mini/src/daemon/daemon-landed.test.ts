import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newUlid, type SummaryPacket, type TacetConfig, type TaskLanded } from '@tacet/core';
import { type EventStore, openEventStore, workerGitEnv, workerWorktree } from '@tacet/core/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitIntegrator } from '../git/integrate.js';
import { CheckoutPlanner } from '../standalone.js';
import { CommandVerifier } from '../verify/command-verifier.js';
import { WorktreeManager } from '../worktree.js';
import { MiniConductor } from './daemon.js';
import { SingleStepPlanner } from './planner.js';
import type { Planner, Workspaces } from './ports.js';
import { type Script, ScriptedAdapter } from './testing.js';

/**
 * Freeing the Worker checkouts of a task whose result the user merged (#210), end to end: the
 * daemon with the real worktree manager and git integration.
 */
describe('MiniConductor: removing worktrees once their task landed (#210)', () => {
  let root: string;
  let repo: string;
  let store: EventStore;
  let env: Record<string, string>;
  let manager: WorktreeManager;
  let daemon: MiniConductor | undefined;

  const git = (cwd: string, args: string[], extra: Record<string, string> = {}) =>
    execFileSync('git', ['-C', cwd, ...args], {
      env: { ...env, ...extra },
      encoding: 'utf8',
    }).trim();
  const workerGit = (cwd: string, args: string[]) => {
    const wt = workerWorktree(cwd, repo);
    if (!wt) throw new Error('not a worktree');
    return git(cwd, args, workerGitEnv(wt));
  };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tacet-mini-landed-')));
    repo = join(root, 'repo');
    mkdirSync(join(root, 'home'));
    env = {
      PATH: process.env.PATH ?? '',
      HOME: join(root, 'home'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
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
    store = openEventStore(':memory:');
    manager = new WorktreeManager(repo, join(root, 'worktrees'), {
      env,
      log: { store, miniId: 'mini' },
    });
  });

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function runTask(
    script: (cwd: string, input: string) => void,
    worktrees?: TacetConfig['worktrees'],
    verify?: string[],
    more: { workspaces?: Workspaces; planner?: Planner; workersMax?: number } = {},
  ): Promise<{ id: string; published: { ref: string; commit: string } }> {
    const fake = new ScriptedAdapter('fake', (input, s): Script => {
      script(s.opts.cwd, input);
      return { do: 'reply', text: 'done' };
    });
    daemon = new MiniConductor({
      store,
      config: {
        tiers: { worker: { adapter: 'fake', model: 'cheap' } },
        ...(worktrees ? { worktrees } : {}),
        ...(verify || more.workersMax
          ? {
              ...(verify ? { verify } : {}),
              workers: {
                ...(verify ? { verify_fix_attempts: 2 } : {}),
                ...(more.workersMax ? { max: more.workersMax } : {}),
              },
            }
          : {}),
      },
      ...(verify
        ? {
            verifier: new CommandVerifier({
              repoRoot: repo,
              commands: verify,
              env: { PATH: env.PATH ?? '', HOME: env.HOME ?? '' },
              gitEnv: env,
            }),
          }
        : {}),
      adapters: { fake: { adapter: fake, authRoute: 'api_key' } },
      workspaces: more.workspaces ?? manager,
      integrator: new GitIntegrator(repo, env),
      planner: more.planner ?? new SingleStepPlanner(),
      mcp: {
        workerConfig: () => ({
          config: { name: 'tacet', url: 'http://127.0.0.1:1/mcp' },
          revoke: () => {},
        }),
      },
      lockPath: join(root, 'mini.lock'),
      pollMs: 20,
      landedSweepMs: 50,
    });
    await daemon.start();
    const id = daemon.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
    await daemon.settled();
    const result = store.query({ taskId: id, typePrefix: 'task.result' }).at(-1)?.envelope.data as
      | SummaryPacket
      | undefined;
    if (!result?.published) throw new Error('the task published no result');
    return { id, published: result.published };
  }

  const commitWork = (cwd: string) => {
    writeFileSync(join(cwd, 'work.txt'), 'work\n');
    workerGit(cwd, ['add', 'work.txt']);
    workerGit(cwd, ['commit', '-qm', 'work']);
  };
  const squashIntoMain = (commit: string) => {
    git(repo, ['merge', '-q', '--squash', commit]);
    git(repo, ['commit', '-qm', 'squash-merged']);
  };
  const landedEvents = (id: string) =>
    store.query({ taskId: id, typePrefix: 'task.landed' }).map((e) => e.envelope);
  /** Long enough for several sweeps at 50 ms. */
  const severalSweeps = () => new Promise((resolve) => setTimeout(resolve, 400));

  it('records the squash merge and removes the checkout when the setting is on', async () => {
    const { id, published } = await runTask(commitWork);
    expect(published.ref).toBe(`refs/heads/tacet/${id}/result`);
    // The task's target was pinned when it started (#219).
    expect(store.query({ taskId: id, typePrefix: 'task.target' })[0]?.envelope.data).toMatchObject({
      branch: 'main',
    });
    // Started from the pinned commit, not a branch: the sweep's target can only come from it.
    const started = store.query({ typePrefix: 'worker.started' })[0]?.envelope.data as {
      baseBranch?: string;
      baseCommit?: string;
    };
    expect(started.baseBranch).toBeUndefined();
    expect(started.baseCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(await manager.list()).toHaveLength(1);
    squashIntoMain(published.commit);
    const squashed = git(repo, ['rev-parse', 'HEAD']);

    await vi.waitFor(async () => expect(await manager.list()).toEqual([]), { timeout: 3_000 });
    const [landed] = landedEvents(id);
    expect(landed?.data as TaskLanded).toEqual({
      commit: published.commit,
      target: 'refs/heads/main',
      how: 'squash',
      landedAs: squashed,
    });
    const result = store.query({ taskId: id, typePrefix: 'task.result' }).at(-1)?.envelope;
    expect(landed?.causationId).toBe(result?.id);
    await severalSweeps();
    expect(landedEvents(id)).toHaveLength(1);
  });

  it('keeps the checkout, and records nothing, when the setting is off', async () => {
    const { id, published } = await runTask(commitWork, { remove_merged: false });
    squashIntoMain(published.commit);
    await severalSweeps();
    expect(await manager.list()).toHaveLength(1);
    expect(landedEvents(id)).toEqual([]);
  });

  it('keeps the checkout while the result has not landed', async () => {
    const { id } = await runTask(commitWork);
    writeFileSync(join(repo, 'other.txt'), 'other\n');
    git(repo, ['add', 'other.txt']);
    git(repo, ['commit', '-qm', 'unrelated']);
    await severalSweeps();
    expect(await manager.list()).toHaveLength(1);
    expect(landedEvents(id)).toEqual([]);
  });

  it('keeps an abandoned commit after the task landed', async () => {
    const { id, published } = await runTask((cwd) => {
      commitWork(cwd);
      // Amended before integration: the first commit stays only in the Worker's own store.
      workerGit(cwd, ['commit', '--amend', '-qm', 'work, amended']);
    });
    squashIntoMain(published.commit);
    await vi.waitFor(() => expect(landedEvents(id)).toHaveLength(1), { timeout: 3_000 });
    await severalSweeps();
    expect(await manager.list()).toHaveLength(1);
  });

  describe('commits superseded within the task (owner decision on #210)', () => {
    /** First turn commits without `fixed.txt`; told verification failed, the Worker amends. */
    const amendInFixRound = (cwd: string, input: string) => {
      if (input.startsWith('Verification failed')) {
        writeFileSync(join(cwd, 'fixed.txt'), 'fixed\n');
        workerGit(cwd, ['add', 'fixed.txt']);
        workerGit(cwd, ['commit', '--amend', '-qm', 'work, fixed']);
      } else commitWork(cwd);
    };

    it('removes the checkout when an integrated commit was replaced by a later integration', async () => {
      const { id, published } = await runTask(amendInFixRound, undefined, ['test -f fixed.txt']);
      const integrated = store
        .query({ taskId: `${id}/1`, typePrefix: 'worker.integrated' })
        .map((e) => (e.envelope.data as { commit: string }).commit);
      expect(integrated).toHaveLength(2);
      squashIntoMain(published.commit);

      await vi.waitFor(async () => expect(await manager.list()).toEqual([]), { timeout: 3_000 });
      expect(landedEvents(id)).toHaveLength(1);
    });

    it('keeps the checkout when a fix round replaced the work with unrelated work after a reset', async () => {
      const { id, published } = await runTask(
        (cwd, input) => {
          if (!input.startsWith('Verification failed')) return commitWork(cwd);
          // Not an amend: approach X is thrown away and two unrelated commits take its place.
          workerGit(cwd, ['reset', '-q', '--hard', 'HEAD~1']);
          for (const file of ['other.txt', 'fixed.txt']) {
            writeFileSync(join(cwd, file), `${file}\n`);
            workerGit(cwd, ['add', file]);
            workerGit(cwd, ['commit', '-qm', file]);
          }
        },
        undefined,
        ['test -f fixed.txt'],
      );
      squashIntoMain(published.commit);
      await vi.waitFor(() => expect(landedEvents(id)).toHaveLength(1), { timeout: 3_000 });
      await severalSweeps();
      expect(await manager.list()).toHaveLength(1);
    });

    it('keeps the checkout when a fix round reset to the base and made one unrelated commit', async () => {
      const { id, published } = await runTask(
        (cwd, input) => {
          if (!input.startsWith('Verification failed')) return commitWork(cwd);
          // Same first parent as the work it replaces, but a new commit, not an amend.
          workerGit(cwd, ['reset', '-q', '--hard', 'HEAD~1']);
          writeFileSync(join(cwd, 'fixed.txt'), 'fixed\n');
          workerGit(cwd, ['add', 'fixed.txt']);
          workerGit(cwd, ['commit', '-qm', 'unrelated fix']);
        },
        undefined,
        ['test -f fixed.txt'],
      );
      squashIntoMain(published.commit);
      await vi.waitFor(() => expect(landedEvents(id)).toHaveLength(1), { timeout: 3_000 });
      await severalSweeps();
      expect(await manager.list()).toHaveLength(1);
    });

    it('keeps the checkout for a commit only the reflog reached, never integrated', async () => {
      const { id, published } = await runTask((cwd) => {
        commitWork(cwd);
        // Thrown away before any integration: only the Worker's reflog and store hold it.
        workerGit(cwd, ['reset', '-q', '--hard', 'HEAD~1']);
        writeFileSync(join(cwd, 'kept.txt'), 'kept\n');
        workerGit(cwd, ['add', 'kept.txt']);
        workerGit(cwd, ['commit', '-qm', 'kept']);
      });
      squashIntoMain(published.commit);
      await vi.waitFor(() => expect(landedEvents(id)).toHaveLength(1), { timeout: 3_000 });
      await severalSweeps();
      expect(await manager.list()).toHaveLength(1);
    });
  });

  it('finds every live checkout from the event log after a restart, with no state files (#126)', async () => {
    const { id } = await runTask(commitWork, { remove_merged: false });
    const started = store
      .query({ taskId: `${id}/1`, typePrefix: 'worker.started' })
      .map((e) => (e.envelope.data as { workspaceId: string }).workspaceId);
    await daemon?.stop();
    daemon = undefined;
    expect(
      readdirSync(join(root, 'worktrees')).filter(
        (n) => n !== '.tacet-locks' && !started.includes(n),
      ),
    ).toEqual([]);

    const restarted = new WorktreeManager(repo, join(root, 'worktrees'), {
      env,
      log: { store, miniId: 'mini' },
    });
    await restarted.reconcile();
    for (const workspaceId of started) {
      expect(await restarted.get(workspaceId)).toMatchObject({ id: workspaceId });
    }
  });

  it('reconciles the worktree registry when it starts (#126)', async () => {
    // A checkout whose creation a crashed Mini-conductor never finished.
    store.append({
      v: 1,
      id: newUlid(),
      ts: new Date().toISOString(),
      source: { kind: 'mini', id: 'mini' },
      type: 'workspace.created',
      data: {
        workspaceId: 'crashed-1',
        workerId: 'w',
        baseCommit: git(repo, ['rev-parse', 'HEAD']),
      },
    });
    await runTask(commitWork, { remove_merged: false });
    expect(
      store.query({ typePrefix: 'workspace.removed' }).map((e) => e.envelope.data),
    ).toContainEqual({ workspaceId: 'crashed-1', reason: 'gone' });
  });

  it('starts every sub-task from the target pinned when the task started (#219)', async () => {
    const mainTip = git(repo, ['rev-parse', 'HEAD']);
    const startedAt: Record<string, string> = {};
    const planner: Planner = {
      async plan() {
        return {
          subtasks: [
            { key: 'a', goal: 'a', acceptanceCriteria: ['ok'] },
            { key: 'b', goal: 'b', acceptanceCriteria: ['ok'] },
          ],
          rationale: 'two independent sub-tasks',
          planner: { adapter: 'test' },
        };
      },
    };
    const fake = new ScriptedAdapter('fake', (_input, s): Script => {
      const cwd = s.opts.cwd;
      startedAt[cwd] = workerGit(cwd, ['rev-parse', 'HEAD']);
      if (Object.keys(startedAt).length === 1) {
        // The user switches the main checkout to another branch while the task runs.
        git(repo, ['checkout', '-q', '-b', 'elsewhere']);
        writeFileSync(join(repo, 'elsewhere.txt'), 'x\n');
        git(repo, ['add', 'elsewhere.txt']);
        git(repo, ['commit', '-qm', 'elsewhere']);
      }
      return { do: 'reply', text: 'done' };
    });
    daemon = new MiniConductor({
      store,
      config: { tiers: { worker: { adapter: 'fake', model: 'cheap' } }, workers: { max: 1 } },
      adapters: { fake: { adapter: fake, authRoute: 'api_key' } },
      workspaces: manager,
      integrator: new GitIntegrator(repo, env),
      planner,
      mcp: {
        workerConfig: () => ({
          config: { name: 'tacet', url: 'http://127.0.0.1:1/mcp' },
          revoke: () => {},
        }),
      },
      lockPath: join(root, 'mini.lock'),
      pollMs: 20,
    });
    await daemon.start();
    const id = daemon.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
    await daemon.settled();

    expect(git(repo, ['symbolic-ref', '--short', 'HEAD'])).toBe('elsewhere');
    const heads = Object.values(startedAt);
    expect(heads).toHaveLength(2);
    expect(new Set(heads)).toEqual(new Set([mainTip]));
    expect(store.query({ taskId: id, typePrefix: 'task.target' })[0]?.envelope.data).toEqual({
      branch: 'main',
      commit: mainTip,
    });
  });

  describe('the pinned target (#219)', () => {
    const twoSubtasks: Planner = {
      async plan() {
        return {
          subtasks: [
            { key: 'a', goal: 'a', acceptanceCriteria: ['ok'] },
            { key: 'b', goal: 'b', acceptanceCriteria: ['ok'] },
          ],
          rationale: 'two independent sub-tasks',
          planner: { adapter: 'test' },
        };
      },
    };
    /** The worktree manager as a Workspaces without `head`: as before #219. */
    const withoutHead = (): Workspaces => ({
      create: (workerId, base) => manager.create(workerId, base),
      get: (id) => manager.get(id),
      remove: (id, o) => manager.remove(id, o),
    });
    /** The user switches the main checkout to another branch, after the first Worker turn. */
    let switched = false;
    const switchOnce = () => {
      if (switched) return;
      switched = true;
      git(repo, ['checkout', '-q', '-b', 'elsewhere']);
      writeFileSync(join(repo, 'elsewhere.txt'), 'x\n');
      git(repo, ['add', 'elsewhere.txt']);
      git(repo, ['commit', '-qm', 'elsewhere']);
    };
    const commitFile = (name: string) => (cwd: string) => {
      writeFileSync(join(cwd, name), `${name}\n`);
      workerGit(cwd, ['add', name]);
      workerGit(cwd, ['commit', '-qm', name]);
    };
    /** Squash `commit` onto main without checking main out: the user is on another branch. */
    const squashOntoMain = (commit: string) => {
      const squashed = git(repo, [
        'commit-tree',
        `${commit}^{tree}`,
        '-p',
        'refs/heads/main',
        '-m',
        'squash-merged',
      ]);
      git(repo, ['update-ref', 'refs/heads/main', squashed]);
    };
    beforeEach(() => {
      switched = false;
    });

    it('lands a task in its pinned branch after the user switched branch mid-task', async () => {
      let n = 0;
      const { id, published } = await runTask(
        (cwd) => {
          n += 1;
          commitFile(`work-${n}.txt`)(cwd);
          switchOnce();
        },
        undefined,
        undefined,
        { planner: twoSubtasks, workersMax: 1 },
      );
      expect(git(repo, ['symbolic-ref', '--short', 'HEAD'])).toBe('elsewhere');
      squashOntoMain(published.commit);
      await vi.waitFor(async () => expect(await manager.list()).toEqual([]), { timeout: 3_000 });
      expect((landedEvents(id)[0]?.data as TaskLanded | undefined)?.target).toBe('refs/heads/main');
    });

    it('falls back to the branch older tasks agree on, and skips them when they disagree', async () => {
      const agreed = await runTask(commitWork, undefined, undefined, {
        workspaces: withoutHead(),
      });
      expect(store.query({ taskId: agreed.id, typePrefix: 'task.target' })).toEqual([]);
      squashIntoMain(agreed.published.commit);
      await vi.waitFor(() => expect(landedEvents(agreed.id)).toHaveLength(1), { timeout: 3_000 });
      await daemon?.stop();
      daemon = undefined;

      let n = 0;
      const split = await runTask(
        (cwd) => {
          n += 1;
          commitFile(`split-${n}.txt`)(cwd);
          switchOnce();
        },
        undefined,
        undefined,
        { workspaces: withoutHead(), planner: twoSubtasks, workersMax: 1 },
      );
      squashOntoMain(split.published.commit);
      await severalSweeps();
      expect(landedEvents(split.id)).toEqual([]);
    });

    it('pins no branch on a detached HEAD, and the sweep then checks none', async () => {
      git(repo, ['checkout', '-q', '--detach']);
      const { id, published } = await runTask(commitWork);
      const target = store.query({ taskId: id, typePrefix: 'task.target' })[0]?.envelope.data;
      expect(target).toEqual({ commit: git(repo, ['rev-parse', 'HEAD']) });
      squashOntoMain(published.commit);
      await severalSweeps();
      expect(landedEvents(id)).toEqual([]);
      expect(await manager.list()).toHaveLength(1);
    });

    it('fails planning when it cannot tell the target, and plans at the pinned commit', async () => {
      const failing: Workspaces = {
        ...withoutHead(),
        head: () => Promise.reject(new Error('no branch here')),
      };
      await expect(
        runTask(commitWork, undefined, undefined, { workspaces: failing }),
      ).rejects.toThrow('the task published no result');
      const status = store
        .query({ typePrefix: 'task.status' })
        .map((e) => e.envelope.data as { state: string; message?: string });
      expect(status.at(-1)).toMatchObject({
        state: 'failed',
        message: expect.stringContaining('cannot tell which branch the task targets'),
      });
    });

    it('keeps a target pinned before a crash, and plans there', async () => {
      const pinned = git(repo, ['rev-parse', 'HEAD']);
      writeFileSync(join(repo, 'later.txt'), 'later\n');
      git(repo, ['add', 'later.txt']);
      git(repo, ['commit', '-qm', 'after the pin']);
      // A Mini-conductor that crashed after pinning, before the plan.
      const id = 'crashed-task';
      const envelope = (type: string, data: unknown) => ({
        v: 1 as const,
        id: newUlid(),
        ts: new Date().toISOString(),
        source: { kind: 'mini' as const, id: 'mini' },
        taskId: id,
        type,
        data,
      });
      store.append([
        envelope('task.created', {
          id,
          goal: 'g',
          acceptanceCriteria: ['ok'],
          priority: 'p2',
          createdAt: new Date().toISOString(),
        }),
        envelope('task.status', { state: 'submitted' }),
        envelope('task.target', { branch: 'main', commit: pinned }),
      ]);
      const bases: Array<string | undefined> = [];
      const planner: Planner = {
        async plan(task, opts) {
          bases.push(opts?.base);
          return new SingleStepPlanner().plan(task);
        },
      };
      let startedAt: string | undefined;
      const fake = new ScriptedAdapter('fake', (_input, s): Script => {
        startedAt = workerGit(s.opts.cwd, ['rev-parse', 'HEAD']);
        return { do: 'reply', text: 'done' };
      });
      daemon = new MiniConductor({
        store,
        config: { tiers: { worker: { adapter: 'fake', model: 'cheap' } } },
        adapters: { fake: { adapter: fake, authRoute: 'api_key' } },
        workspaces: manager,
        integrator: new GitIntegrator(repo, env),
        planner,
        mcp: {
          workerConfig: () => ({
            config: { name: 'tacet', url: 'http://127.0.0.1:1/mcp' },
            revoke: () => {},
          }),
        },
        lockPath: join(root, 'mini.lock'),
        pollMs: 20,
      });
      await daemon.start();
      await daemon.settled();
      expect(store.query({ taskId: id, typePrefix: 'task.target' })).toHaveLength(1);
      expect(bases).toEqual([pinned]);
      expect(startedAt).toBe(pinned);
    });
  });
  describe('idle checkouts and leftover planner checkouts (#238)', () => {
    type GcOptions = Parameters<NonNullable<Workspaces['gc']>>[0];
    const recording = (calls: GcOptions[]): Workspaces => ({
      create: (workerId, base, o) => manager.create(workerId, base, o),
      get: (id) => manager.get(id),
      remove: (id, o) => manager.remove(id, o),
      head: () => manager.head(),
      reconcile: () => manager.reconcile(),
      gc: (o) => {
        calls.push(o);
        return manager.gc(o);
      },
    });

    it("passes each checkout its sessions' newest worker event as its last activity", async () => {
      const calls: GcOptions[] = [];
      await runTask(commitWork, { remove_merged: false }, undefined, {
        workspaces: recording(calls),
      });
      // A sweep after the task settled, so after its last worker event.
      const before = calls.length;
      await vi.waitFor(() => expect(calls.length).toBeGreaterThan(before), { timeout: 3_000 });
      const started = store.query({ typePrefix: 'worker.started' })[0]?.envelope.data as {
        sessionId: string;
        workspaceId: string;
      };
      const newest = Math.max(
        ...store
          .query({ typePrefix: 'worker' })
          .filter(
            (e) =>
              (e.envelope.data as { sessionId?: string }).sessionId === started.sessionId ||
              e.envelope.sessionId === started.sessionId,
          )
          .map((e) => Date.parse(e.envelope.ts)),
      );
      const last = calls.at(-1);
      expect(last?.olderThanMs).toBe(7 * 86_400_000);
      expect(last?.lastActivity?.get(started.workspaceId)).toBe(newest);
      // Its task is done and no session runs in it: not held as active.
      expect(last?.activeWorktreeIds).not.toContain(started.workspaceId);
      // Used recently: kept.
      expect(await manager.get(started.workspaceId)).toBeDefined();
    });

    it('runs no gc with idle_days 0', async () => {
      const calls: GcOptions[] = [];
      await runTask(commitWork, { remove_merged: false, idle_days: 0 }, undefined, {
        workspaces: recording(calls),
      });
      await severalSweeps();
      expect(calls).toEqual([]);
    });

    it('removes at start the planner checkout a crash left, and marks new ones scratch', async () => {
      // What a crash mid-plan leaves: a registered planner checkout the planner never removed.
      const left = await manager.create('plan-crashed-1234abcd', undefined, { scratch: true });
      writeFileSync(join(left.path, 'notes.txt'), 'planner scribbles\n');
      const planner = new CheckoutPlanner(manager, () => new SingleStepPlanner());
      await runTask(commitWork, { remove_merged: false }, undefined, { planner });
      expect(await manager.get(left.id)).toBeUndefined();
      expect(
        store
          .query({ typePrefix: 'workspace.removed' })
          .map((e) => e.envelope.data as { workspaceId: string; reason: string }),
      ).toContainEqual({ workspaceId: left.id, reason: 'forced' });
      const plannerCheckouts = store
        .query({ typePrefix: 'workspace.created' })
        .map((e) => e.envelope.data as { workerId: string; scratch?: boolean })
        .filter((d) => d.workerId.startsWith('plan-'));
      expect(plannerCheckouts).toHaveLength(2);
      expect(plannerCheckouts.every((d) => d.scratch === true)).toBe(true);
      // The Worker's checkout is untouched.
      expect(await manager.list()).toHaveLength(1);
    });
  });
});
