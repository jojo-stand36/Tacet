import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newUlid, tasksProjection } from '@tacet/core';
import { type EventStore, openEventStore, workerGitEnv, workerWorktree } from '@tacet/core/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitIntegrator, resultBranch, taskBranch } from '../git/integrate.js';
import { CommandVerifier } from '../verify/command-verifier.js';
import { MiniConductor } from './daemon.js';
import { SingleStepPlanner } from './planner.js';
import {
  type Integrator,
  type Planner,
  type ProposedSubtask,
  type Verifier,
  type Workspace,
  type Workspaces,
  WorktreeRefusedError,
} from './ports.js';
import { type Script, ScriptedAdapter } from './testing.js';

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
    async create(workerId: string, base?: string): Promise<Workspace> {
      const id = `ws-${workerId.replace(/[^\w.-]/g, '_')}`;
      const path = join(root, 'worktrees', id);
      git(repo, ['worktree', 'add', '-q', '--detach', path, base ?? 'main']);
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

  function start(
    script: (cwd: string, input: string) => unknown,
    planner: Planner = new SingleStepPlanner(),
    verify?: string[],
    opts: { adapterId?: string; integrator?: Integrator; verifier?: Verifier } = {},
  ) {
    const adapterId = opts.adapterId ?? 'fake';
    const fake = new ScriptedAdapter(adapterId, (input, s) => {
      return (script(s.opts.cwd, input) as Script | undefined) ?? { do: 'reply', text: 'done' };
    });
    daemon = new MiniConductor({
      store,
      config: {
        tiers: { worker: { adapter: adapterId, model: 'cheap' } },
        ...(verify ? { verify, workers: { verify_fix_attempts: 2 } } : {}),
      },
      ...(opts.verifier ? { verifier: opts.verifier } : {}),
      ...(verify && !opts.verifier
        ? {
            verifier: new CommandVerifier({
              repoRoot: repo,
              commands: verify,
              env: { PATH: env.PATH ?? '', HOME: env.HOME ?? '' },
              gitEnv: env,
            }),
          }
        : {}),
      adapters: { [adapterId]: { adapter: fake, authRoute: 'api_key' } },
      workspaces: new GitWorkspaces(),
      integrator: opts.integrator ?? new GitIntegrator(repo, env),
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
    return daemon;
  }

  const commitFiles = (cwd: string, files: Record<string, string>) => {
    const wt = workerWorktree(cwd, repo);
    if (!wt) throw new Error('not a worktree');
    for (const [f, text] of Object.entries(files)) writeFileSync(join(cwd, f), text);
    git(cwd, ['add', ...Object.keys(files)], workerGitEnv(wt));
    git(cwd, ['commit', '-qm', Object.keys(files).join(' ')], workerGitEnv(wt));
  };
  const commitAsWorker = (cwd: string) => commitFiles(cwd, { 'work.txt': 'work\n' });

  it('verifies the integrated commit in the Worker checkout, and has the Worker fix a failure (#19)', async () => {
    let turns = 0;
    const d = start(
      (cwd, input) => {
        turns += 1;
        // First turn: commits the wrong file. Told what failed, it commits the right one.
        if (input.startsWith('Verification failed')) commitFiles(cwd, { 'work.txt': 'work\n' });
        else commitFiles(cwd, { 'other.txt': 'x\n' });
        return undefined;
      },
      new SingleStepPlanner(),
      ['test -f work.txt'],
    );
    await d.start();
    const id = d.submit({ goal: 'write work.txt', acceptanceCriteria: ['exists'], priority: 'p1' });
    await d.settled();
    const sub = `${id}/1`;
    expect(store.replay(tasksProjection).tasks[sub]?.state).toBe('completed');
    expect(turns).toBe(2);
    const checks = store
      .query({ taskId: sub, typePrefix: 'worker.verification' })
      .map((e) => e.envelope.data as { round: number; status: string; commit?: string });
    expect(checks.map((c) => [c.round, c.status])).toEqual([
      [0, 'failed'],
      [1, 'passed'],
    ]);
    // Each check names the commit it verified: what integration brought in.
    const integrated = store
      .query({ taskId: sub, typePrefix: 'worker.integrated' })
      .map((e) => (e.envelope.data as { commit: string }).commit);
    expect(checks.map((c) => c.commit)).toEqual(integrated);
  });

  /** Two independent sub-tasks and a third that depends on both (#134). */
  const diamond: Planner = {
    async plan() {
      const subtasks: ProposedSubtask[] = [
        { key: 'a', goal: 'write [a]', acceptanceCriteria: ['ok'] },
        { key: 'b', goal: 'write [b]', acceptanceCriteria: ['ok'] },
        { key: 'c', goal: 'write [c]', acceptanceCriteria: ['ok'], dependsOn: ['a', 'b'] },
      ];
      return { subtasks, rationale: 'diamond', planner: { adapter: 'test' } };
    },
  };
  /** Implement, a review that commits nothing, then a fix that depends on the review. */
  const chain: Planner = {
    async plan() {
      const subtasks: ProposedSubtask[] = [
        { key: 'a', goal: 'write [a]', acceptanceCriteria: ['ok'] },
        { key: 'b', goal: 'review [b]', acceptanceCriteria: ['ok'], dependsOn: ['a'] },
        { key: 'c', goal: 'fix [c]', acceptanceCriteria: ['ok'], dependsOn: ['b'] },
      ];
      return { subtasks, rationale: 'chain', planner: { adapter: 'test' } };
    },
  };
  const tasks = () => store.replay(tasksProjection).tasks;
  const data = <T>(taskId: string, type: string) =>
    store.query({ taskId, typePrefix: type }).map((e) => e.envelope.data as T);

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

  it('starts a dependent sub-task from the combined work of its dependencies', async () => {
    const seen: string[] = [];
    const d = start((cwd, input) => {
      if (input.includes('[a]')) commitFiles(cwd, { 'a.txt': 'a\n' });
      else if (input.includes('[b]')) commitFiles(cwd, { 'b.txt': 'b\n' });
      else if (input.includes('[c]')) {
        seen.push(...['a.txt', 'b.txt'].filter((f) => existsSync(join(cwd, f))));
        commitFiles(cwd, { 'c.txt': 'c\n' });
      }
    }, diamond);
    await d.start();
    const id = d.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
    await d.settled();
    expect(tasks()[id]?.state).toBe('completed');
    expect(seen).toEqual(['a.txt', 'b.txt']);
    const base = data<{ baseCommit?: string }>(`${id}/3`, 'worker.started')[0]?.baseCommit;
    expect(base).toMatch(/^[0-9a-f]{40}$/);
    // The merge the checkout started from is not reported as the Worker's own commit.
    const cCommits = data<{ commits: string[] }>(`${id}/3`, 'task.result').at(-1)?.commits;
    expect(cCommits).toHaveLength(1);
    expect(cCommits?.[0]).not.toBe(base);
    // The parent's branch holds every sub-task's work.
    const result = resultBranch(id);
    for (const f of ['a.txt', 'b.txt', 'c.txt']) git(repo, ['cat-file', '-e', `${result}:${f}`]);
    expect(data<{ commits: string[] }>(id, 'task.result').at(-1)?.commits).toContain(
      git(repo, ['rev-parse', result]),
    );
    expect(data<{ summary: string }>(id, 'task.result').at(-1)?.summary).toContain(
      `tacet/${id}/result`,
    );
    git(repo, ['gc', '-q']);
  });

  it('asks the user when the dependencies conflict, and runs nothing until answered', async () => {
    const inputs: string[] = [];
    const d = start((cwd, input) => {
      if (input.includes('[a]')) commitFiles(cwd, { 'x.txt': 'from a\n' });
      else if (input.includes('[b]')) commitFiles(cwd, { 'x.txt': 'from b\n' });
      else if (input.includes('[c]')) {
        inputs.push(input);
        // The first attempt fails before merging anything; the retry still gets the guidance.
        if (inputs.length === 1) return { do: 'error', message: 'crashed' };
        commitFiles(cwd, { 'c.txt': 'c\n' });
      }
    }, diamond);
    await d.start();
    const id = d.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
    const c = `${id}/3`;
    await expect.poll(() => tasks()[c]?.state, { timeout: 5000 }).toBe('input_required');
    const raised = data<{ id: string; question: string; contextRef: string; category: string }>(
      c,
      'escalation.raised',
    );
    expect(raised).toHaveLength(1);
    expect(raised[0]?.question).toContain('x.txt');
    expect(raised[0]?.question).not.toContain(root);
    expect(raised[0]?.category).toBe('blocked');
    expect(data(c, 'worker.started')).toHaveLength(0);
    expect(tasks()[id]?.state).toBe('input_required');
    store.append({
      v: 1,
      id: newUlid(),
      ts: new Date().toISOString(),
      source: { kind: 'conductor', id: 'test' },
      taskId: c,
      type: 'escalation.resolved',
      data: { escalationId: raised[0]?.id, answer: 'keep the a version' },
    });
    await d.settled();
    expect(tasks()[c]?.state).toBe('completed');
    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
      expect(input).toMatch(/merge these commits/);
      expect(input).toContain('keep the a version');
    }
    const workspaces = data<{ workspaceId: string }>(c, 'worker.started').map((x) => x.workspaceId);
    expect(new Set(workspaces).size).toBe(1);
    const a = data<{ commits: string[] }>(`${id}/1`, 'task.result').at(-1)?.commits?.[0];
    expect(data<{ baseCommit?: string }>(c, 'worker.started')[0]?.baseCommit).toBe(a);
    // c did not merge b, so the whole task cannot be combined: said, not hidden.
    const parent = data<{ openQuestions: string[] }>(id, 'task.result').at(-1);
    expect(parent?.openQuestions.join('\n')).toMatch(/conflicts \(x\.txt\)/);
    expect(() => git(repo, ['rev-parse', '--verify', '-q', resultBranch(id)])).toThrow();
  });

  it('fails, without retrying, a sub-task whose changes were never committed (#261)', async () => {
    const d = start(
      (cwd) => {
        writeFileSync(join(cwd, 'work.txt'), 'work\n');
        // An empty placeholder of Claude's Linux sandbox (#263) is not a change.
        writeFileSync(join(cwd, 'package.json'), '');
      },
      undefined,
      undefined,
      { adapterId: 'claude-sdk' },
    );
    await d.start();
    const id = d.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
    await d.settled();
    const sub = `${id}/1`;
    expect(tasks()[sub]?.state).toBe('failed');
    const message = data<{ message?: string }>(sub, 'task.status').at(-1)?.message ?? '';
    expect(message).toMatch(/^nothing was integrated: the Worker changed 1 file \("work\.txt"\)/);
    expect(message).toContain('claude-sdk Workers cannot commit yet, #260');
    expect(message).not.toContain('package.json');
    expect(data<{ outcome: string }>(sub, 'task.result').at(-1)?.outcome).toBe('failed');
    // One attempt: retrying a Worker that cannot commit would only fail again.
    expect(data(sub, 'worker.started')).toHaveLength(1);
    expect(tasks()[id]?.state).toBe('failed');
  });

  /** The real integrator, but with `uncommitted` replaced. */
  const integratorWith = (uncommitted: () => Promise<undefined>) =>
    new (class extends GitIntegrator {
      override uncommitted = uncommitted;
    })(repo, env);

  it('quotes, redacts and shortens the paths it names, and counts placeholders outside the sandbox (#261)', async () => {
    const token = `sk-ant-api03-${'a'.repeat(40)}`;
    const d = start((cwd) => {
      writeFileSync(join(cwd, 'line\nbreak.txt'), 'x\n');
      writeFileSync(join(cwd, `${token}.txt`), 'x\n');
      writeFileSync(join(cwd, `${'l'.repeat(200)}.txt`), 'x\n');
      // Not a Claude sandbox: an empty package.json is the Worker's own.
      writeFileSync(join(cwd, 'package.json'), '');
    });
    await d.start();
    const id = d.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
    await d.settled();
    const message = data<{ message?: string }>(`${id}/1`, 'task.status').at(-1)?.message ?? '';
    expect(message).toMatch(/^nothing was integrated: the Worker changed 4 files/);
    expect(message).toContain('"line\\nbreak.txt"');
    expect(message).not.toContain('\n');
    expect(message).not.toContain(token);
    expect(message).not.toContain('l'.repeat(130));
    expect(message).toContain('package.json');
    expect(message).toContain('(the Worker must commit its work)');
  });

  it('does not claim no change when the checkout could not be checked (#261)', async () => {
    const failing = integratorWith(async () => {
      throw new Error('git is too old');
    });
    const d = start(() => undefined, undefined, undefined, { integrator: failing });
    await d.start();
    const id = d.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
    await d.settled();
    expect(tasks()[`${id}/1`]?.state).toBe('completed');
    const message = data<{ message?: string }>(`${id}/1`, 'task.status').at(-1)?.message ?? '';
    expect(message).toBe(
      'the Worker made no commit, and its checkout could not be checked (git is too old)',
    );
    // Nothing to compare with is said the same way, never as "no change".
    const unknown = integratorWith(async () => undefined);
    await d.stop();
    const e = start(() => undefined, undefined, undefined, { integrator: unknown });
    await e.start();
    const id2 = e.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
    await e.settled();
    expect(data<{ message?: string }>(`${id2}/1`, 'task.status').at(-1)?.message).toMatch(
      /could not be checked \(no commit to compare with, or not a worktree of the repo\)$/,
    );
  });

  it('asks the user, as integration does, when the checkout fails the integrity checks during the check (#261)', async () => {
    const forged = integratorWith(async () => {
      throw new WorktreeRefusedError('the worktree was forged');
    });
    const d = start(() => undefined, undefined, undefined, { integrator: forged });
    await d.start();
    const id = d.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
    await d.settled();
    expect(tasks()[`${id}/1`]?.state).not.toBe('completed');
    expect(
      data<{ workspaceRefused?: boolean }>(`${id}/1`, 'worker.ended').at(-1)?.workspaceRefused,
    ).toBe(true);
  });

  it('says, for the sub-task and in the parent summary, when work was checked only in part or not at all (#261)', async () => {
    const statuses = ['partial', 'not_run', 'passed'] as const;
    let call = 0;
    const verifier: Verifier = {
      verify: async () => {
        const status = statuses[call++] ?? 'passed';
        return {
          status,
          commands: ['pnpm test'],
          ...(status === 'partial' ? { notes: 'review did not finish' } : {}),
        };
      },
    };
    const d = start(
      (cwd, input) => {
        if (input.includes('[a]')) commitFiles(cwd, { 'a.txt': 'a\n' });
        if (input.includes('[c]')) commitFiles(cwd, { 'c.txt': 'c\n' });
      },
      chain,
      undefined,
      { verifier },
    );
    await d.start();
    const id = d.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
    await d.settled();
    const note = (sub: string) => data<{ message?: string }>(sub, 'task.status').at(-1)?.message;
    expect(note(`${id}/1`)).toBe('verification ran only in part (review did not finish)');
    expect(note(`${id}/2`)).toBe('verification did not run; no change: the Worker made no commit');
    expect(note(`${id}/3`)).toBeUndefined();
    const summary = data<{ summary: string }>(id, 'task.result').at(-1)?.summary ?? '';
    expect(summary).toContain(`${id}/1: verification ran only in part (review did not finish)`);
    expect(summary).toContain(`${id}/2: verification did not run`);
    expect(summary).not.toContain(`${id}/3: verification`);
  });

  it('counts no change for a checkout moved to a commit the repo already has (#261)', async () => {
    // The same work done before: a commit already in the repo, with a file the base lacks.
    git(repo, ['checkout', '-q', '-b', 'earlier']);
    writeFileSync(join(repo, 'done.txt'), 'done\n');
    git(repo, ['add', 'done.txt']);
    git(repo, ['commit', '-qm', 'earlier work']);
    const earlier = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['checkout', '-q', 'main']);
    const d = start((cwd) => {
      const wt = workerWorktree(cwd, repo);
      if (!wt) throw new Error('not a worktree');
      git(cwd, ['checkout', '-q', '--detach', earlier], workerGitEnv(wt));
    });
    await d.start();
    const id = d.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
    await d.settled();
    // Compared with its own HEAD, not its base: done.txt is committed, not left over.
    expect(tasks()[`${id}/1`]?.state).toBe('completed');
  });

  it('says so when a completed sub-task changed nothing or left changes out (#261)', async () => {
    const d = start((cwd, input) => {
      if (input.includes('[a]')) {
        commitFiles(cwd, { 'a.txt': 'a\n' });
        writeFileSync(join(cwd, 'stray.txt'), 'left\n');
      }
    }, chain);
    await d.start();
    const id = d.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
    await d.settled();
    const note = (sub: string) => data<{ message?: string }>(sub, 'task.status').at(-1)?.message;
    expect(tasks()[`${id}/1`]?.state).toBe('completed');
    expect(note(`${id}/1`)).toBe('1 file ("stray.txt") left uncommitted, not in the result');
    // A sub-task that only reviews is fine, and says it changed nothing.
    expect(tasks()[`${id}/2`]?.state).toBe('completed');
    expect(note(`${id}/2`)).toBe('no change: the Worker made no commit');
  });

  it('carries work through a sub-task that commits nothing', async () => {
    const seen: Record<string, boolean> = {};
    const d = start((cwd, input) => {
      if (input.includes('[a]')) commitFiles(cwd, { 'a.txt': 'a\n' });
      else if (input.includes('[b]')) seen.b = existsSync(join(cwd, 'a.txt'));
      else if (input.includes('[c]')) {
        seen.c = existsSync(join(cwd, 'a.txt'));
        commitFiles(cwd, { 'c.txt': 'c\n' });
      }
    }, chain);
    await d.start();
    const id = d.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
    await d.settled();
    expect(tasks()[id]?.state).toBe('completed');
    // One dependency: its own commit. Through the review, which committed nothing: still a's.
    expect(seen).toEqual({ b: true, c: true });
    expect(data<{ commits: string[] }>(`${id}/2`, 'task.result').at(-1)?.commits).toEqual([]);
    const result = resultBranch(id);
    for (const f of ['a.txt', 'c.txt']) git(repo, ['cat-file', '-e', `${result}:${f}`]);
    // a is in c, so the result is c's commit itself: no needless merge.
    expect(git(repo, ['rev-parse', result])).toBe(git(repo, ['rev-parse', taskBranch(`${id}/3`)]));
  });
});
