import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SummaryPacket, TacetConfig, TaskLanded } from '@tacet/core';
import { type EventStore, openEventStore, workerGitEnv, workerWorktree } from '@tacet/core/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitIntegrator } from '../git/integrate.js';
import { CommandVerifier } from '../verify/command-verifier.js';
import { WorktreeManager } from '../worktree.js';
import { MiniConductor } from './daemon.js';
import { SingleStepPlanner } from './planner.js';
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
    manager = new WorktreeManager(repo, join(root, 'worktrees'), { env });
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
        ...(verify ? { verify, workers: { verify_fix_attempts: 2 } } : {}),
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
      workspaces: manager,
      integrator: new GitIntegrator(repo, env),
      planner: new SingleStepPlanner(),
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
    const started = store.query({ typePrefix: 'worker.started' })[0]?.envelope.data as {
      baseBranch?: string;
    };
    expect(started.baseBranch).toBe('main');
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
});
