import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newUlid, tasksProjection } from '@tacet/core';
import { type EventStore, openEventStore, workerGitEnv, workerWorktree } from '@tacet/core/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitIntegrator, taskBranch } from '../git/integrate.js';
import { MiniConductor } from './daemon.js';
import { SingleStepPlanner } from './planner.js';
import type { Workspace, Workspaces } from './ports.js';
import { ScriptedAdapter } from './testing.js';

/**
 * The daemon with real git checkouts (#119): a Worker commits the way a sandboxed Codex Worker
 * does (detached HEAD, its own object store), and the daemon brings the commit into the repo
 * after the turn, before verification.
 */
describe('MiniConductor with git worktrees', () => {
  let root: string;
  let repo: string;
  let store: EventStore;
  let env: Record<string, string>;
  let daemon: MiniConductor | undefined;

  const git = (cwd: string, args: string[], extra: Record<string, string> = {}) =>
    execFileSync('git', ['-C', cwd, ...args], {
      env: { ...env, ...extra },
      encoding: 'utf8',
    }).trim();

  /** Detached worktrees with their own object store, as the Codex adapter prepares them. */
  class GitWorkspaces implements Workspaces {
    readonly #all = new Map<string, Workspace>();
    async create(workerId: string): Promise<Workspace> {
      const id = `ws-${workerId.replace(/[^\w.-]/g, '_')}`;
      const path = join(root, 'worktrees', id);
      git(repo, ['worktree', 'add', '-q', '--detach', path, 'main']);
      const wt = workerWorktree(path, repo);
      if (wt) mkdirSync(join(wt.gitDir, 'objects'), { recursive: true });
      const ws = { id, path };
      this.#all.set(id, ws);
      return ws;
    }
    async get(id: string) {
      return this.#all.get(id);
    }
    async remove() {}
  }

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tacet-mini-git-')));
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
    store = openEventStore(':memory:');
  });

  afterEach(async () => {
    await daemon?.stop();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  function start(script: (cwd: string) => void) {
    const fake = new ScriptedAdapter('fake', (_input, s) => {
      script(s.opts.cwd);
      return { do: 'reply', text: 'done' };
    });
    daemon = new MiniConductor({
      store,
      config: { tiers: { worker: { adapter: 'fake', model: 'cheap' } } },
      adapters: { fake: { adapter: fake, authRoute: 'api_key' } },
      workspaces: new GitWorkspaces(),
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
    });
    return daemon;
  }

  const commitAsWorker = (cwd: string) => {
    const wt = workerWorktree(cwd, repo);
    if (!wt) throw new Error('not a worktree');
    writeFileSync(join(cwd, 'work.txt'), 'work\n');
    git(cwd, ['add', 'work.txt'], workerGitEnv(wt));
    git(cwd, ['commit', '-qm', 'work'], workerGitEnv(wt));
  };

  it('integrates the Worker commit after its turn and reports it in the result', async () => {
    const d = start(commitAsWorker);
    await d.start();
    const id = d.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
    await d.settled();
    const sub = `${id}/1`;
    expect(store.replay(tasksProjection).tasks[sub]?.state).toBe('completed');
    const integrated = store.query({ taskId: sub, typePrefix: 'worker.integrated' })[0]?.envelope;
    const commit = (integrated?.data as { commit: string } | undefined)?.commit;
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    expect(git(repo, ['rev-parse', taskBranch(sub)])).toBe(commit);
    expect(git(repo, ['show', `${commit}:work.txt`])).toBe('work');
    const result = store.query({ taskId: sub, typePrefix: 'task.result' }).at(-1)?.envelope;
    expect((result?.data as { commits: string[] } | undefined)?.commits).toEqual([commit]);
    git(repo, ['gc', '-q']);
  });

  it('asks the user, and runs nothing, when the checkout fails its integrity checks', async () => {
    const d = start((cwd) => {
      commitAsWorker(cwd);
      const wt = workerWorktree(cwd, repo);
      // The Worker forges where its git dir points.
      if (wt) writeFileSync(join(wt.gitDir, 'commondir'), join(cwd, 'evil'));
    });
    await d.start();
    const id = d.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
    const sub = `${id}/1`;
    await expect
      .poll(() => store.replay(tasksProjection).tasks[sub]?.state, { timeout: 5000 })
      .toBe('input_required');
    const raised = store.query({ taskId: sub, typePrefix: 'escalation.raised' })[0]?.envelope;
    expect(raised?.source.kind).toBe('mini');
    expect((raised?.data as { question: string } | undefined)?.question).toMatch(
      /integrity checks/,
    );
    expect(store.query({ taskId: sub, typePrefix: 'worker.integrated' })).toHaveLength(0);
    expect(() => git(repo, ['rev-parse', '--verify', '-q', taskBranch(sub)])).toThrow();
  });

  it('spends no attempt on a refused checkout and runs again in a fresh one after the answer', async () => {
    let first = true;
    const d = start((cwd) => {
      commitAsWorker(cwd);
      if (first) {
        first = false;
        const wt = workerWorktree(cwd, repo);
        if (wt) writeFileSync(join(wt.gitDir, 'commondir'), join(cwd, 'evil'));
      }
    });
    await d.start();
    const id = d.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
    const sub = `${id}/1`;
    const state = () => store.replay(tasksProjection).tasks[sub]?.state;
    await expect.poll(state, { timeout: 5000 }).toBe('input_required');
    const ended = store.query({ taskId: sub, typePrefix: 'worker.ended' })[0]?.envelope.data;
    expect(ended).toMatchObject({ reason: 'canceled', workspaceRefused: true });
    const escalationId = (
      store.query({ taskId: sub, typePrefix: 'escalation.raised' })[0]?.envelope.data as
        | { id: string }
        | undefined
    )?.id;
    // The question names the checkout by id, never by path.
    const question = (
      store.query({ taskId: sub, typePrefix: 'escalation.raised' })[0]?.envelope.data as
        | { question: string }
        | undefined
    )?.question;
    expect(question).not.toContain(root);
    store.append({
      v: 1,
      id: newUlid(),
      ts: new Date().toISOString(),
      source: { kind: 'conductor', id: 'test' },
      taskId: sub,
      type: 'escalation.resolved',
      data: { escalationId, answer: 'checked; go ahead' },
    });
    await d.settled();
    expect(state()).toBe('completed');
    const started = store
      .query({ taskId: sub, typePrefix: 'worker.started' })
      .map((e) => e.envelope.data as { workspaceId: string; attempt: number });
    expect(started).toHaveLength(2);
    expect(started[1]?.workspaceId).not.toBe(started[0]?.workspaceId);
    expect(started[1]?.attempt).toBe(1);
  });

  it('integrates while the sub-task waits on the user, so the repo stays healthy', async () => {
    const d = start((cwd) => {
      commitAsWorker(cwd);
      const sub = store.query({ typePrefix: 'worker.started' }).at(-1)?.envelope;
      if (!sub?.taskId) return;
      store.append({
        v: 1,
        id: newUlid(),
        ts: new Date().toISOString(),
        source: { kind: 'worker', id: 'w' },
        taskId: sub.taskId,
        sessionId: (sub.data as { sessionId: string }).sessionId,
        type: 'escalation.raised',
        data: {
          id: newUlid(),
          taskId: sub.taskId,
          question: 'Which database?',
          urgency: 'normal',
          createdAt: new Date().toISOString(),
          status: 'pending',
        },
      });
    });
    await d.start();
    const id = d.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
    const sub = `${id}/1`;
    await expect
      .poll(() => store.replay(tasksProjection).tasks[sub]?.state, { timeout: 5000 })
      .toBe('input_required');
    expect(store.query({ taskId: sub, typePrefix: 'worker.integrated' })).toHaveLength(1);
    git(repo, ['gc', '-q']);
  });
});
