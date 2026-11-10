import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type EventEnvelope,
  newUlid,
  ProfileRefusedError,
  type SessionOptions,
  type TacetConfig,
  tasksProjection,
} from '@tacet/core';
import {
  type EventStore,
  markedProcesses,
  newWorkerMarker,
  openEventStore,
  WORKER_MARKER_VAR,
} from '@tacet/core/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventLogBackend } from '../mcp/backend.js';
import {
  cancelStopped,
  MiniConductor,
  type MiniConductorOptions,
  miniLockHolder,
  VERIFY_CODEX_WORKERS,
} from './daemon.js';
import { AdapterPlanner, parseProposal, SingleStepPlanner } from './planner.js';
import type {
  Integrator,
  Planner,
  ProposedSubtask,
  ReviewContext,
  Reviewer,
  ReviewResult,
  Verifier,
  VerifyContext,
  WorkerMcp,
} from './ports.js';
import { type Script, ScriptedAdapter, TempWorkspaces } from './testing.js';

const CONFIG: TacetConfig = {
  tiers: { worker: { adapter: 'fake', model: 'cheap' }, review: { adapter: 'other', model: 'x' } },
  workers: { max: 4, max_attempts: 2 },
  verify: [],
};

/** Behaviour keyed by markers in the sub-task goal (the prompt contains it). */
const script = (input: string): Script => {
  if (input.includes('[fail]')) return { do: 'error', message: 'boom' };
  if (input.includes('[hold]')) return { do: 'hold' };
  if (input.includes('[approval]')) return { do: 'approval' };
  if (input.includes('[mcp-claude]')) return { do: 'approval', toolName: 'mcp__tacet__escalate' };
  if (input.includes('[mcp-other]')) return { do: 'approval', toolName: 'mcp__evil__run' };
  if (input.includes('[mcp-codex]')) {
    return { do: 'approval', toolName: 'mcp_elicitation', grant: { serverName: 'tacet' } };
  }
  if (input.includes('[mcp-spoof1]')) return { do: 'approval', toolName: 'mcp__tacet___run' };
  if (input.includes('[mcp-spoof2]')) return { do: 'approval', toolName: 'mcp__tacet__x__run' };
  return { do: 'reply', text: `Did: ${input.split('\n')[0]}` };
};

class FixedPlanner implements Planner {
  constructor(readonly subtasks: ProposedSubtask[]) {}
  async plan() {
    return { subtasks: this.subtasks, rationale: 'fixed', planner: { adapter: 'test' } };
  }
}

let dir: string;
let store: EventStore;
let ws: TempWorkspaces;
let fake: ScriptedAdapter;
let other: ScriptedAdapter;
let revoked: string[];
let minted: string[];
const daemons: MiniConductor[] = [];

const mcp: WorkerMcp = {
  workerConfig: (b) => {
    minted.push(b.workerSessionId);
    return {
      config: {
        name: 'tacet',
        url: 'http://127.0.0.1:1/mcp',
        // One token per Worker session, so a test can tell which minting a session got.
        headers: { authorization: `Bearer token-for-${b.workerSessionId}` },
      },
      revoke: () => revoked.push(b.workerSessionId),
    };
  },
};

function make(over: Partial<MiniConductorOptions> = {}): MiniConductor {
  const d = new MiniConductor({
    store,
    config: CONFIG,
    adapters: {
      fake: { adapter: fake, authRoute: 'api_key' },
      other: { adapter: other, authRoute: 'api_key' },
    },
    workspaces: ws,
    planner: new SingleStepPlanner(),
    mcp,
    lockPath: join(dir, 'mini.lock'),
    pollMs: 20,
    ...over,
  });
  daemons.push(d);
  return d;
}

const types = (taskId?: string) =>
  store.query(taskId ? { taskId } : {}).map((e) => e.envelope.type);
const tasks = () => store.replay(tasksProjection).tasks;
const ofType = (type: string, taskId?: string) =>
  store
    .query({ typePrefix: type, ...(taskId ? { taskId } : {}) })
    .map((e) => e.envelope)
    .filter((e) => e.type === type);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tacet-mini-daemon-'));
  store = openEventStore(':memory:');
  ws = new TempWorkspaces();
  fake = new ScriptedAdapter('fake', script);
  other = new ScriptedAdapter('other', script);
  revoked = [];
  minted = [];
});

afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop().catch(() => {});
  store.close();
  ws.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe('MiniConductor', () => {
  describe('review (#19)', () => {
    const COMMIT = 'c'.repeat(40);
    /** Every turn's end integrates a commit, so there is something to review. */
    const integrator: Integrator = {
      integrate: async (subtaskId) => ({ commit: COMMIT, ref: `refs/heads/tacet/${subtaskId}` }),
      combine: async () => undefined,
      publish: async (taskId) => `refs/heads/tacet/result/${taskId}`,
    };
    const REVIEW: TacetConfig = {
      ...CONFIG,
      tiers: {
        worker: { adapter: 'fake', model: 'cheap' },
        review: { adapter: 'other', model: 'x', cross_vendor: false },
      },
      review: { enabled: true },
      workers: { ...CONFIG.workers, max_attempts: 1, verify_fix_attempts: 1 },
    };
    /** A reviewer that answers from `results`, in turn, recording what it was given. */
    function scriptedReviewer(results: ReviewResult['status'][]) {
      const calls: ReviewContext[] = [];
      const reviewer: Reviewer = {
        async review(_task, ctx) {
          calls.push(ctx);
          const status = results[Math.min(calls.length - 1, results.length - 1)] ?? 'passed';
          return {
            status,
            adapter: 'other',
            model: 'x',
            sessionId: `rev-${calls.length}`,
            findings:
              status === 'failed'
                ? [{ severity: 'blocker', file: 'a.ts', line: 2, message: 'wrong answer' }]
                : [{ severity: 'minor', message: 'style' }],
            ...(status === 'error' ? { notes: 'the reviewer timed out' } : {}),
            usage: { inputTokens: 10, outputTokens: 2, model: 'x' },
          };
        },
      };
      return { reviewer, calls };
    }
    const reviews = () =>
      ofType('worker.review').map(
        (e) => e.data as { round: number; status: string; sessionId: string; blockers: number },
      );
    const result = (id: string) =>
      ofType('task.result', `${id}/1`).map(
        (e) =>
          e.data as {
            outcome: string;
            verification: {
              status: string;
              notes?: string;
              review?: { status: string; blocking: number };
            };
          },
      );

    it("completes approved work, recording the verdict and the reviewer's usage", async () => {
      const { reviewer, calls } = scriptedReviewer(['passed']);
      const d = make({ config: REVIEW, reviewer, integrator });
      await d.start();
      const id = d.submit({ goal: 'Do it', acceptanceCriteria: ['ok'], priority: 'p1' });
      await d.settled();
      expect(tasks()[id]?.state).toBe('completed');
      expect(calls).toHaveLength(1);
      expect(calls[0]?.commit).toBe(COMMIT);
      // No checkout is made for it (it gets the change in its prompt), and it has a marker of its
      // own.
      expect(ws.created).toHaveLength(1);
      expect(calls[0]?.marker).toMatch(/\S/);
      expect(reviews()).toEqual([
        expect.objectContaining({ round: 0, status: 'passed', blockers: 0, minors: 1 }),
      ]);
      expect(JSON.stringify(ofType('worker.review'))).not.toContain('style');
      expect(result(id)[0]?.verification).toMatchObject({
        status: 'passed',
        review: { status: 'passed', adapter: 'other', blocking: 0 },
      });
      expect(ofType('agent.usage', `${id}/1`).length).toBeGreaterThan(0);
    });

    it('sends blocking findings back to the same session, then completes', async () => {
      const { reviewer } = scriptedReviewer(['failed', 'passed']);
      const d = make({ config: REVIEW, reviewer, integrator });
      await d.start();
      const id = d.submit({ goal: 'Do it', acceptanceCriteria: ['ok'], priority: 'p1' });
      await d.settled();
      expect(tasks()[id]?.state).toBe('completed');
      expect(fake.sessions).toHaveLength(1);
      const fix = fake.sessions[0]?.inputs.at(-1) ?? '';
      expect(fix).toMatch(/^Review failed:/);
      expect(fix).toContain('[blocker] a.ts:2: wrong answer');
      expect(reviews().map((r) => [r.round, r.status])).toEqual([
        [0, 'failed'],
        [1, 'passed'],
      ]);
    });

    it('caps review rounds without verify commands, and fails the attempt with the findings', async () => {
      const { reviewer, calls } = scriptedReviewer(['failed']);
      const d = make({ config: REVIEW, reviewer, integrator });
      await d.start();
      const id = d.submit({ goal: 'Do it', acceptanceCriteria: ['ok'], priority: 'p1' });
      await d.settled();
      expect(tasks()[`${id}/1`]?.state).toBe('failed');
      // One check, one fix round (verify_fix_attempts: 1), then the attempt fails.
      expect(calls).toHaveLength(2);
      const r = result(id)[0];
      expect(r?.outcome).toBe('failed');
      expect(r?.verification.status).toBe('failed');
      expect(r?.verification.review).toMatchObject({ status: 'failed', blocking: 1 });
      expect(r?.verification.notes).toBe(
        'Review requested changes: 1 blocking finding(s), 0 minor.',
      );
      expect(Object.keys(r?.verification ?? {})).not.toContain('feedback');
    });

    it('keeps the findings out of every event: only the Worker sees them (coordinator requirement)', async () => {
      const SECRET = 'sk-ant-reviewfinding0123456789';
      const TEXT = 'FINDING-TEXT-7f3a';
      const reviewer: Reviewer = {
        async review() {
          return {
            status: 'failed',
            adapter: 'other',
            findings: [
              {
                severity: 'blocker',
                file: 'secret/path.ts',
                line: 9,
                message: `${TEXT} leaks ${SECRET}`,
              },
              { severity: 'minor', message: `${TEXT} minor` },
            ],
          };
        },
      };
      const d = make({ config: REVIEW, reviewer, integrator });
      await d.start();
      const id = d.submit({ goal: 'Do it', acceptanceCriteria: ['ok'], priority: 'p1' });
      await d.settled();
      expect(tasks()[`${id}/1`]?.state).toBe('failed');
      // The Worker got them, redacted.
      const fix = fake.sessions[0]?.inputs.find((x) => x.startsWith('Review failed')) ?? '';
      expect(fix).toContain(TEXT);
      expect(fix).toContain('secret/path.ts:9');
      expect(fix).not.toContain(SECRET);
      // Nothing in the log carries their text, the file they name, or the secret: counts only.
      const log = JSON.stringify(store.query({}).map((e) => e.envelope));
      expect(log).not.toContain(TEXT);
      expect(log).not.toContain('secret/path.ts');
      expect(log).not.toContain(SECRET);
      expect(reviews()[0]).toMatchObject({ blockers: 1, majors: 0, minors: 1 });
      expect(JSON.stringify(d.errors)).not.toContain(TEXT);
    });

    it('does not review work whose commands failed', async () => {
      const { reviewer, calls } = scriptedReviewer(['passed']);
      const verifier: Verifier = {
        async verify(_t, _w, ctx) {
          ctx.onCommand?.({ command: 'pnpm test', status: 'failed', exitCode: 1, durationMs: 1 });
          return {
            status: 'failed',
            commands: ['pnpm test'],
            notes: 'red',
            feedback: 'tests failed',
          };
        },
      };
      const d = make({
        config: { ...REVIEW, verify: ['pnpm test'] },
        reviewer,
        verifier,
        integrator,
      });
      await d.start();
      const id = d.submit({ goal: 'Do it', acceptanceCriteria: ['ok'], priority: 'p1' });
      await d.settled();
      expect(tasks()[`${id}/1`]?.state).toBe('failed');
      expect(calls).toHaveLength(0);
    });

    it('leaves the work partial when the reviewer gives no verdict', async () => {
      const { reviewer } = scriptedReviewer(['error']);
      const d = make({ config: REVIEW, reviewer, integrator });
      await d.start();
      const id = d.submit({ goal: 'Do it', acceptanceCriteria: ['ok'], priority: 'p1' });
      await d.settled();
      expect(tasks()[id]?.state).toBe('completed');
      expect(result(id)[0]?.verification).toMatchObject({
        status: 'partial',
        notes: 'Review did not finish: the reviewer timed out.',
        review: { status: 'error' },
      });
    });

    it('reviews a commit whatever the sub-task kind (review, explore)', async () => {
      const { reviewer, calls } = scriptedReviewer(['passed']);
      const d = make({
        config: REVIEW,
        reviewer,
        integrator,
        planner: new FixedPlanner([
          { key: 'r', goal: 'Review it', acceptanceCriteria: ['ok'], kind: 'review' },
          { key: 'e', goal: 'Explore it', acceptanceCriteria: ['ok'], kind: 'explore' },
        ]),
      });
      await d.start();
      const id = d.submit({ goal: 'Do it', acceptanceCriteria: ['ok'], priority: 'p1' });
      await d.settled();
      expect(tasks()[id]?.state).toBe('completed');
      // The planner chooses the kind: a code-writing "explore" sub-task gets no pass on it.
      expect(calls).toHaveLength(2);
    });

    it('has nothing to review when no commit was integrated', async () => {
      const { reviewer, calls } = scriptedReviewer(['failed']);
      const d = make({ config: REVIEW, reviewer });
      await d.start();
      const id = d.submit({ goal: 'Do it', acceptanceCriteria: ['ok'], priority: 'p1' });
      await d.settled();
      expect(tasks()[id]?.state).toBe('completed');
      expect(calls).toHaveLength(0);
    });

    it('aborts a review in progress when the Mini-conductor stops, its marker recorded meanwhile', async () => {
      let fileHadIt = false;
      let aborted = false;
      let marker = '';
      const reviewer: Reviewer = {
        review: (_t, ctx) =>
          new Promise((resolve) => {
            marker = ctx.marker;
            fileHadIt = readFileSync(`${join(dir, 'mini.lock')}.workers`, 'utf8').includes(
              ctx.marker,
            );
            ctx.signal.addEventListener('abort', () => {
              aborted = true;
              resolve({
                status: 'error',
                adapter: 'other',
                findings: [],
                notes: 'the review was stopped',
              });
            });
          }),
      };
      const d = make({ config: REVIEW, reviewer, integrator });
      await d.start();
      d.submit({ goal: 'Do it', acceptanceCriteria: ['ok'], priority: 'p1' });
      await expect.poll(() => fileHadIt).toBe(true);
      await d.stop();
      expect(aborted).toBe(true);
      expect(readFileSync(`${join(dir, 'mini.lock')}.workers`, 'utf8')).not.toContain(marker);
      // A stopped review judged nothing: no verdict recorded, so the restart keeps its fix round.
      expect(reviews()).toEqual([]);
    });

    it('refuses to start with review on and no reviewer, or a reviewer of the same vendor', () => {
      expect(() => make({ config: REVIEW })).toThrow(/no reviewer was given/);
      const { reviewer } = scriptedReviewer(['passed']);
      expect(() =>
        make({
          config: {
            ...REVIEW,
            tiers: {
              worker: { adapter: 'fake', model: 'cheap', vendor: 'anthropic' },
              review: { adapter: 'other', model: 'x', vendor: 'anthropic' },
            },
          },
          reviewer,
        }),
      ).toThrow(/runs anthropic models like the Worker/);
    });
  });

  describe('verification (#19)', () => {
    const VERIFY: TacetConfig = {
      ...CONFIG,
      verify: ['pnpm test'],
      workers: { ...CONFIG.workers, verify_fix_attempts: 1 },
    };
    /** A verifier that answers from `results`, in turn, recording what it was given. */
    function scripted(results: ('passed' | 'failed')[]) {
      const calls: VerifyContext[] = [];
      const verifier: Verifier = {
        async verify(_task, _ws, ctx) {
          calls.push(ctx);
          const status = results[Math.min(calls.length - 1, results.length - 1)] ?? 'passed';
          ctx.onCommand?.({
            command: 'pnpm test',
            status,
            exitCode: status === 'passed' ? 0 : 1,
            durationMs: 5,
          });
          return status === 'failed'
            ? {
                status,
                commands: ['pnpm test'],
                notes: 'tests failed',
                feedback: `Verification failed (call ${calls.length}).`,
              }
            : { status, commands: ['pnpm test'] };
        },
      };
      return { verifier, calls };
    }
    const verifications = () =>
      ofType('worker.verification').map(
        (e) => e.data as { round: number; status: string; sessionId: string },
      );

    it('sends a failure back to the same session to fix, then completes', async () => {
      const { verifier, calls } = scripted(['failed', 'passed']);
      const d = make({ config: VERIFY, verifier });
      await d.start();
      const id = d.submit({ goal: 'Do it', acceptanceCriteria: ['tests pass'], priority: 'p1' });
      await d.settled();
      expect(tasks()[id]?.state).toBe('completed');
      expect(fake.sessions).toHaveLength(1);
      expect(fake.sessions[0]?.inputs.at(-1)).toBe('Verification failed (call 1).');
      expect(calls).toHaveLength(2);
      expect(verifications().map((v) => [v.round, v.status])).toEqual([
        [0, 'failed'],
        [1, 'passed'],
      ]);
      // Rounds go to the log; a failed round is not a failed attempt.
      expect(
        ofType('task.result', `${id}/1`).map((e) => (e.data as { outcome: string }).outcome),
      ).toEqual(['completed']);
    });

    it('fails the attempt once its fix rounds are used, and retries afresh', async () => {
      const { verifier } = scripted(['failed']);
      const d = make({
        config: { ...VERIFY, workers: { ...VERIFY.workers, max_attempts: 2 } },
        verifier,
      });
      await d.start();
      const id = d.submit({ goal: 'Do it', acceptanceCriteria: ['tests pass'], priority: 'p1' });
      await d.settled();
      expect(tasks()[`${id}/1`]?.state).toBe('failed');
      // Two attempts (sessions), each with one fix round: two checks each.
      expect(fake.sessions).toHaveLength(2);
      for (const s of fake.sessions) {
        expect(s.inputs.filter((x) => x.startsWith('Verification failed'))).toHaveLength(1);
      }
      const bySession = Map.groupBy(verifications(), (v) => v.sessionId);
      expect([...bySession.values()].map((vs) => vs.map((v) => v.round))).toEqual([
        [0, 1],
        [0, 1],
      ]);
      const results = ofType('task.result', `${id}/1`).map(
        (e) => e.data as { outcome: string; verification: { notes?: string } },
      );
      expect(results.map((r) => r.outcome)).toEqual(['failed', 'failed']);
      expect(results[0]?.verification.notes).toBe('tests failed');
      // The feedback meant for the Worker never goes up (review B2).
      for (const e of ofType('task.result', `${id}/1`)) {
        expect(Object.keys((e.data as { verification: object }).verification)).not.toContain(
          'feedback',
        );
      }
      // The fresh attempt is told why the last one failed (review S3).
      expect(fake.sessions[1]?.inputs[0]).toContain('Verification of that attempt: tests failed');
    });

    it('keeps the fix-round budget across a restart in the middle of a fix (review S2)', async () => {
      const { verifier } = scripted(['failed']);
      // The fix turn holds, so the Mini-conductor restarts while the Worker is fixing.
      fake = new ScriptedAdapter('fake', (input) =>
        input.startsWith('Verification failed') ? { do: 'hold' } : script(input),
      );
      const RETRY = { ...VERIFY, workers: { ...VERIFY.workers, max_attempts: 2 } };
      const d1 = make({ config: RETRY, verifier });
      await d1.start();
      const id = d1.submit({ goal: 'Do it', acceptanceCriteria: ['tests pass'], priority: 'p1' });
      await expect
        .poll(() => fake.sessions[0]?.inputs.some((x) => x.startsWith('Verification failed')))
        .toBe(true);
      await d1.stop();
      fake = new ScriptedAdapter('fake', (input) =>
        input.startsWith('The Mini-conductor restarted')
          ? { do: 'reply', text: 'fixed' }
          : script(input),
      );
      const d2 = make({ config: RETRY, verifier });
      await d2.start();
      await d2.settled();
      // One fix round in all (verify_fix_attempts: 1): the resumed session's failure fails the
      // attempt instead of buying another round.
      const resumed = fake.sessions.find((s) => s.opts.resume);
      expect(resumed).toBeDefined();
      expect(resumed?.inputs.filter((x) => x.startsWith('Verification failed'))).toEqual([]);
      expect(
        ofType('task.result', `${id}/1`).map((e) => (e.data as { outcome: string }).outcome)[0],
      ).toBe('failed');
      // The next attempt reuses the checkout but not the spent budget (re-review S2).
      const retry = fake.sessions.find((s) => s !== resumed && !s.opts.resume);
      expect(retry?.inputs.filter((x) => x.startsWith('Verification failed'))).toHaveLength(1);
    });

    it('records the process marker while it runs, and stops a run when the Mini-conductor stops', async () => {
      let markerSeen: string | undefined;
      let fileHadIt = false;
      let aborted = false;
      const verifier: Verifier = {
        verify: (_task, _ws, ctx) =>
          new Promise((resolve) => {
            markerSeen = ctx.marker;
            fileHadIt = readFileSync(`${join(dir, 'mini.lock')}.workers`, 'utf8').includes(
              ctx.marker,
            );
            ctx.signal.addEventListener('abort', () => {
              aborted = true;
              resolve({ status: 'not_run', commands: ['pnpm test'] });
            });
          }),
      };
      const d = make({ config: VERIFY, verifier });
      await d.start();
      d.submit({ goal: 'Do it', acceptanceCriteria: ['tests pass'], priority: 'p1' });
      await expect.poll(() => markerSeen).toBeDefined();
      expect(fileHadIt).toBe(true);
      await d.stop();
      expect(aborted).toBe(true);
      // Stopped, not failed: nothing counts against the sub-task, and the marker is dropped.
      expect(ofType('task.result')).toEqual([]);
      expect(readFileSync(`${join(dir, 'mini.lock')}.workers`, 'utf8')).not.toContain(markerSeen);
    });

    it('does not verify Codex Workers until the sandbox decision, and says so', async () => {
      expect(VERIFY_CODEX_WORKERS).toBe(false);
      const { verifier, calls } = scripted(['passed']);
      const codex = new ScriptedAdapter('codex-app-server', script);
      const d = make({
        config: {
          ...VERIFY,
          tiers: { ...CONFIG.tiers, worker: { adapter: 'codex-app-server', model: 'm' } },
        },
        adapters: {
          'codex-app-server': { adapter: codex, authRoute: 'api_key' },
          other: { adapter: other, authRoute: 'api_key' },
        },
        verifier,
      });
      await d.start();
      const id = d.submit({ goal: 'Do it', acceptanceCriteria: ['tests pass'], priority: 'p1' });
      await d.settled();
      expect(calls).toHaveLength(0);
      const result = ofType('task.result', `${id}/1`)[0]?.data as {
        verification: { status: string; notes?: string };
      };
      expect(result.verification).toMatchObject({
        status: 'not_run',
        notes: 'codex verify pending sandbox decision',
      });
    });
  });

  it('plans, runs sub-tasks in dependency order, and rolls the result up', async () => {
    const d = make({
      planner: new FixedPlanner([
        { key: 'api', goal: 'Write the API', acceptanceCriteria: ['compiles'] },
        { key: 'ui', goal: 'Write the UI', acceptanceCriteria: ['renders'], dependsOn: ['api'] },
        { key: 'docs', goal: 'Write the docs', acceptanceCriteria: ['exists'] },
        {
          key: 'review',
          goal: 'Review it',
          acceptanceCriteria: ['checked'],
          kind: 'review',
          dependsOn: ['ui', 'docs'],
        },
      ]),
    });
    await d.start();
    const id = d.submit({
      goal: 'Ship the feature',
      acceptanceCriteria: ['works'],
      priority: 'p1',
    });
    await d.settled();

    const all = tasks();
    expect(all[id]?.state).toBe('completed');
    expect(all[id]?.result?.outcome).toBe('completed');
    for (const n of [1, 2, 3, 4]) expect(all[`${id}/${n}`]?.state).toBe('completed');
    // The planned task carries the dependency graph; sub-tasks point at their parent.
    expect(all[id]?.plan?.map((p) => p.dependsOn)).toEqual([
      [],
      [`${id}/1`],
      [],
      [`${id}/2`, `${id}/3`],
    ]);
    expect(all[`${id}/2`]?.task.parentId).toBe(id);
    // ui started only after api completed; review only after ui and docs.
    const log = store.query({}).map((e) => e.envelope);
    const at = (pred: (e: EventEnvelope) => boolean) => log.findIndex(pred);
    const completedAt = (t: string) =>
      at(
        (e) =>
          e.taskId === t &&
          e.type === 'task.status' &&
          (e.data as { state: string }).state === 'completed',
      );
    const startedAt = (t: string) => at((e) => e.taskId === t && e.type === 'worker.started');
    expect(startedAt(`${id}/2`)).toBeGreaterThan(completedAt(`${id}/1`));
    expect(startedAt(`${id}/4`)).toBeGreaterThan(completedAt(`${id}/2`));
    expect(startedAt(`${id}/4`)).toBeGreaterThan(completedAt(`${id}/3`));
    // The review ran on the review tier's adapter (another vendor), the rest on the worker tier.
    expect(other.sessions).toHaveLength(1);
    expect(fake.sessions).toHaveLength(3);
    // Every Worker got its own MCP token, revoked when it ended; Workers were told their task.
    expect(revoked.sort()).toEqual(minted.sort());
    expect(fake.sessions[0]?.opts.mcpServers?.[0]?.url).toBe('http://127.0.0.1:1/mcp');
    expect(fake.sessions[0]?.inputs[0]).toContain('Sub-task: Write the API');
    // Streamed text is stored as one coalesced event per message, not one per delta.
    const texts = ofType('agent.message.delta', `${id}/1`).map(
      (e) => (e.data as { text: string }).text,
    );
    expect(texts).toEqual(['Did: Sub-task: Write the API']);
    // Worker lifecycle: started → vendor session → ended (finished), with a result.
    expect(types(`${id}/1`)).toEqual(
      expect.arrayContaining([
        'worker.started',
        'worker.vendor_session',
        'worker.ended',
        'task.result',
      ]),
    );
    expect(ofType('worker.ended', `${id}/1`)[0]?.data).toMatchObject({ reason: 'finished' });
    expect(d.errors).toEqual([]);
  });

  it('keeps to the capacity limits', async () => {
    const d = make({
      config: { ...CONFIG, workers: { max: 2, max_attempts: 2 } },
      planner: new FixedPlanner(
        ['a', 'b', 'c', 'd', 'e'].map((k) => ({
          key: k,
          goal: `do ${k}`,
          acceptanceCriteria: ['ok'],
        })),
      ),
    });
    await d.start();
    const id = d.submit({ goal: 'many', acceptanceCriteria: ['ok'] });
    await d.settled();
    expect(tasks()[id]?.state).toBe('completed');
    expect(fake.maxConcurrent).toBe(2);
  });

  it('applies a per-adapter cap', async () => {
    const d = make({
      config: { ...CONFIG, workers: { max: 4, per_adapter: { fake: 1 }, max_attempts: 2 } },
      planner: new FixedPlanner(
        ['a', 'b', 'c'].map((k) => ({ key: k, goal: `do ${k}`, acceptanceCriteria: ['ok'] })),
      ),
    });
    await d.start();
    d.submit({ goal: 'many', acceptanceCriteria: ['ok'] });
    await d.settled();
    expect(fake.maxConcurrent).toBe(1);
  });

  it('retries a failed Worker, then fails the sub-task and everything behind it', async () => {
    let first = true;
    fake = new ScriptedAdapter('fake', (input) => {
      if (input.includes('flaky') && first) {
        first = false;
        return { do: 'error', message: 'transient' };
      }
      return script(input);
    });
    const d = make({
      planner: new FixedPlanner([
        { key: 'flaky', goal: 'flaky step', acceptanceCriteria: ['ok'] },
        { key: 'bad', goal: 'bad step [fail]', acceptanceCriteria: ['ok'] },
        { key: 'after', goal: 'after bad', acceptanceCriteria: ['ok'], dependsOn: ['bad'] },
      ]),
    });
    await d.start();
    const id = d.submit({ goal: 'mixed', acceptanceCriteria: ['ok'] });
    await d.settled();
    const all = tasks();
    expect(all[`${id}/1`]?.state).toBe('completed');
    expect(
      ofType('worker.started', `${id}/1`).map((e) => (e.data as { attempt: number }).attempt),
    ).toEqual([1, 2]);
    // The retry continued in the same checkout.
    expect(
      new Set(
        ofType('worker.started', `${id}/1`).map(
          (e) => (e.data as { workspaceId: string }).workspaceId,
        ),
      ).size,
    ).toBe(1);
    expect(all[`${id}/2`]?.state).toBe('failed');
    expect(ofType('worker.started', `${id}/2`)).toHaveLength(2);
    expect(all[`${id}/3`]?.state).toBe('failed');
    expect(ofType('worker.started', `${id}/3`)).toHaveLength(0);
    expect(all[id]?.state).toBe('failed');
    expect(all[id]?.result?.outcome).toBe('failed');
  });

  it('chooses each session profile within the tier bounds and logs it as worker.profile (#110)', async () => {
    let first = true;
    fake = new ScriptedAdapter('fake', (input) => {
      if (input.includes('flaky') && first) {
        first = false;
        return { do: 'error', message: 'transient' };
      }
      return script(input);
    });
    const d = make({
      config: {
        ...CONFIG,
        tiers: {
          worker: {
            adapter: 'fake',
            model: 'cheap',
            effort: 'medium',
            max_effort: 'high',
            escalate_effort_on_retry: true,
            max_context_window: 1_000_000,
          },
        },
      },
      planner: new FixedPlanner([
        { key: 'flaky', goal: 'flaky step', acceptanceCriteria: ['ok'] },
        { key: 'read', goal: 'one long read', acceptanceCriteria: ['ok'], indivisible: true },
      ]),
    });
    await d.start();
    const id = d.submit({ goal: 'profiles', acceptanceCriteria: ['ok'] });
    await d.settled();
    expect(tasks()[id]?.state).toBe('completed');
    const opts = (goal: string) =>
      fake.sessions
        .filter((x) => x.inputs.some((i) => i.includes(goal)))
        .map(({ opts: o }) => ({
          model: o.model,
          effort: o.effort,
          contextWindow: o.contextWindow,
        }));
    // The retry runs one effort level higher; only the indivisible sub-task gets the large window.
    expect(opts('flaky step')).toEqual([
      { model: 'cheap', effort: 'medium', contextWindow: undefined },
      { model: 'cheap', effort: 'high', contextWindow: undefined },
    ]);
    expect(opts('one long read')).toEqual([
      { model: 'cheap', effort: 'medium', contextWindow: 1_000_000 },
    ]);
    // Every session has its profile, with the reasons, in the log, after its worker.started.
    const profiles = ofType('worker.profile', `${id}/2`);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.data).toMatchObject({
      contextWindow: 1_000_000,
      reasons: { contextWindow: expect.stringMatching(/cannot be handed off cleanly/) },
    });
    expect(
      ofType('worker.profile', `${id}/1`).map((e) => (e.data as { effort: string }).effort),
    ).toEqual(['medium', 'high']);
  });

  it('runs at the default effort, and logs why, when the adapter refuses the effort (#110)', async () => {
    class NoHigh extends ScriptedAdapter {
      override async start(opts: SessionOptions) {
        if (opts.effort === 'high') throw new ProfileRefusedError('effort', 'no high here');
        return super.start(opts);
      }
    }
    fake = new NoHigh('fake', script);
    const d = make({
      config: { ...CONFIG, tiers: { worker: { adapter: 'fake', model: 'cheap', effort: 'high' } } },
    });
    await d.start();
    const id = d.submit({ goal: 'refused effort', acceptanceCriteria: ['ok'] });
    await d.settled();
    expect(tasks()[id]?.state).toBe('completed');
    expect(fake.sessions.map((x) => x.opts.effort)).toEqual([undefined]);
    const profiles = ofType('worker.profile').map((e) => e.data as Record<string, unknown>);
    // Chosen, then the same profile marked refused, then the one the session ran on.
    expect(profiles).toHaveLength(3);
    expect(profiles[0]).toMatchObject({ effort: 'high' });
    expect(profiles[0]).not.toHaveProperty('refused');
    expect(profiles[1]).toMatchObject({
      effort: 'high',
      refused: { field: 'effort', message: 'no high here' },
    });
    expect(profiles[2]).not.toHaveProperty('effort');
    expect(profiles[2]).toMatchObject({
      reasons: { effort: expect.stringMatching(/^the model's default; the adapter refused high/) },
    });
    // Not a failed attempt.
    expect(ofType('worker.ended').map((e) => (e.data as { reason: string }).reason)).not.toContain(
      'failed',
    );
  });

  it('drops a refused context window and fails at once on a refused model (#110)', async () => {
    class Picky extends ScriptedAdapter {
      starts = 0;
      override async start(opts: SessionOptions) {
        this.starts++;
        if (opts.model === 'nope') throw new ProfileRefusedError('model', 'no such model');
        if (opts.contextWindow !== undefined) {
          throw new ProfileRefusedError('contextWindow', 'not for this model');
        }
        return super.start(opts);
      }
    }
    const picky = new Picky('fake', script);
    fake = picky;
    const window = make({
      config: {
        ...CONFIG,
        tiers: { worker: { adapter: 'fake', model: 'cheap', max_context_window: 1_000_000 } },
      },
      planner: new FixedPlanner([
        { key: 'read', goal: 'one long read', acceptanceCriteria: ['ok'], indivisible: true },
      ]),
    });
    await window.start();
    const id = window.submit({ goal: 'window', acceptanceCriteria: ['ok'] });
    await window.settled();
    expect(tasks()[id]?.state).toBe('completed');
    expect(picky.sessions.map((x) => x.opts.contextWindow)).toEqual([undefined]);
    const last = ofType('worker.profile').at(-1)?.data as { reasons: { contextWindow: string } };
    expect(last.reasons.contextWindow).toMatch(/refused 1000000; hand off at the threshold/);
    await window.stop();

    // A refused model: one start, then the sub-task fails without using up its retries.
    picky.starts = 0;
    const model = make({
      config: { ...CONFIG, tiers: { worker: { adapter: 'fake', model: 'nope' } } },
    });
    await model.start();
    const id2 = model.submit({ goal: 'bad model', acceptanceCriteria: ['ok'] });
    await model.settled();
    expect(picky.starts).toBe(1);
    expect(tasks()[`${id2}/1`]?.state).toBe('failed');
    expect(ofType('task.status', `${id2}/1`).at(-1)?.data).toMatchObject({
      message: expect.stringMatching(/session profile refused: the adapter refused the model/),
    });
    expect(
      ofType('worker.profile', `${id2}/1`).map((e) => (e.data as { refused?: unknown }).refused),
    ).toEqual([undefined, { field: 'model', message: 'no such model' }]);
  });

  it('fails a sub-task whose profile is outside the bounds, before any session (#110)', async () => {
    const d = make({
      config: {
        ...CONFIG,
        tiers: { worker: { adapter: 'fake', effort: 'max', max_effort: 'high' } },
      },
    });
    await d.start();
    const id = d.submit({ goal: 'out of bounds', acceptanceCriteria: ['ok'] });
    await d.settled();
    expect(tasks()[`${id}/1`]?.state).toBe('failed');
    expect(ofType('task.status', `${id}/1`).at(-1)?.data).toMatchObject({
      message: expect.stringMatching(/session profile refused: effort max is above/),
    });
    expect(fake.sessions).toHaveLength(0);
  });

  it('marks a Worker that ends its turn on an open escalation input_required, then delivers the answer', async () => {
    const escId = newUlid();
    fake = new ScriptedAdapter('fake', (input, s) => {
      if (input.includes('[ask]') && !s.inputs.some((x) => x.startsWith('Answer'))) {
        // What the MCP escalate tool would write for this Worker.
        const sessionId = store
          .query({ typePrefix: 'worker.started' })
          .map((e) => e.envelope)
          .at(-1)?.data as { sessionId: string };
        store.append({
          v: 1,
          id: newUlid(),
          ts: new Date().toISOString(),
          source: { kind: 'worker', id: sessionId.sessionId },
          taskId: store.query({ typePrefix: 'worker.started' }).at(-1)?.envelope.taskId,
          sessionId: sessionId.sessionId,
          type: 'escalation.raised',
          data: {
            id: escId,
            taskId: store.query({ typePrefix: 'worker.started' }).at(-1)?.envelope.taskId,
            question: 'Which database?',
            urgency: 'normal',
            createdAt: new Date().toISOString(),
            status: 'pending',
          },
        });
        return { do: 'reply', text: 'Escalated; waiting.' };
      }
      return script(input);
    });
    const d = make({
      planner: new FixedPlanner([
        { key: 'q', goal: 'needs a decision [ask]', acceptanceCriteria: ['ok'] },
      ]),
    });
    await d.start();
    const id = d.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
    const sub = `${id}/1`;
    await expect.poll(() => tasks()[sub]?.state, { timeout: 5000 }).toBe('input_required');
    // Waiting on a person is not completion, and the session stays open for the answer.
    expect(ofType('task.result', sub)).toHaveLength(0);
    expect(fake.open).toBe(1);
    store.append({
      v: 1,
      id: newUlid(),
      ts: new Date().toISOString(),
      source: { kind: 'mini', id: 'gate' },
      taskId: sub,
      type: 'escalation.resolved',
      data: { escalationId: escId, answer: 'Postgres' },
    });
    await d.settled();
    expect(tasks()[sub]?.state).toBe('completed');
    expect(fake.sessions[0]?.inputs.at(-1)).toBe(`Answer to your escalation ${escId}: Postgres`);
    expect(ofType('escalation.delivered', sub)).toHaveLength(1);
  });

  it("answer() records the user's answer and delivers it (#21)", async () => {
    const escId = newUlid();
    fake = new ScriptedAdapter('fake', (input, s) => {
      if (input.includes('[ask]') && !s.inputs.some((x) => x.startsWith('Answer'))) {
        // What the MCP escalate tool would write for this Worker.
        const sessionId = store
          .query({ typePrefix: 'worker.started' })
          .map((e) => e.envelope)
          .at(-1)?.data as { sessionId: string };
        store.append({
          v: 1,
          id: newUlid(),
          ts: new Date().toISOString(),
          source: { kind: 'worker', id: sessionId.sessionId },
          taskId: store.query({ typePrefix: 'worker.started' }).at(-1)?.envelope.taskId,
          sessionId: sessionId.sessionId,
          type: 'escalation.raised',
          data: {
            id: escId,
            taskId: store.query({ typePrefix: 'worker.started' }).at(-1)?.envelope.taskId,
            question: 'Which database?',
            urgency: 'normal',
            createdAt: new Date().toISOString(),
            status: 'pending',
          },
        });
        return { do: 'reply', text: 'Escalated; waiting.' };
      }
      return script(input);
    });
    const d = make({
      planner: new FixedPlanner([
        { key: 'q', goal: 'needs a decision [ask]', acceptanceCriteria: ['ok'] },
      ]),
    });
    await d.start();
    const id = d.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
    const sub = `${id}/1`;
    await expect.poll(() => tasks()[sub]?.state, { timeout: 5000 }).toBe('input_required');
    // Waiting on a person is not completion, and the session stays open for the answer.
    expect(ofType('task.result', sub)).toHaveLength(0);
    expect(fake.open).toBe(1);
    expect(() => d.answer(newUlid(), 'x')).toThrow(/unknown escalation/);
    expect(() => d.answer(escId, '  ')).toThrow(/empty/);
    d.answer(escId, 'Postgres');
    expect(() => d.answer(escId, 'MySQL')).toThrow(/already resolved/);
    expect(ofType('escalation.resolved', sub).map((e) => e.data)).toEqual([
      { escalationId: escId, answer: 'Postgres', source: 'user' },
    ]);
    await d.settled();
    expect(tasks()[sub]?.state).toBe('completed');
    expect(fake.sessions[0]?.inputs.at(-1)).toBe(`Answer to your escalation ${escId}: Postgres`);
    expect(ofType('escalation.delivered', sub)).toHaveLength(1);
  });

  describe('cancel (#202)', () => {
    const plan3 = () =>
      new FixedPlanner([
        { key: 'a', goal: 'a [hold]', acceptanceCriteria: ['ok'] },
        { key: 'b', goal: 'b [hold]', acceptanceCriteria: ['ok'] },
        { key: 'c', goal: 'c', acceptanceCriteria: ['ok'], dependsOn: ['a'] },
      ]);
    const endReasons = (id: string) =>
      store
        .query({ typePrefix: 'worker.ended' })
        .filter((e) => e.envelope.taskId?.startsWith(`${id}/`))
        .map((e) => (e.envelope.data as { reason: string }).reason);

    it('ends the running Workers, cancels every unfinished sub-task, and starts nothing more', async () => {
      const d = make({ planner: plan3() });
      await d.start();
      const id = d.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
      await expect.poll(() => fake.open, { timeout: 5000 }).toBe(2);
      const vendors = fake.sessions.map((x) => x.handle.vendorSessionId);

      expect(await d.cancel(id)).toEqual([`${id}/1`, `${id}/2`, `${id}/3`, id]);
      await d.settled();
      for (const t of [id, `${id}/1`, `${id}/2`, `${id}/3`])
        expect(tasks()[t]?.state).toBe('canceled');
      expect(fake.open).toBe(0);
      expect(fake.sessions).toHaveLength(2);
      expect(endReasons(id)).toEqual(['canceled', 'canceled']);
      // A canceled session is never resumed, so its vendor state is let go.
      expect(fake.discarded.map((x) => x.vendorSessionId).sort()).toEqual(vendors.sort());
      expect(revoked).toHaveLength(2);

      // A restart does not pick it up again.
      await d.stop();
      const again = make({ planner: plan3() });
      await again.start();
      await again.settled();
      expect(fake.sessions).toHaveLength(2);
      expect(tasks()[id]?.state).toBe('canceled');
    });

    it('stops a task being planned and drops its plan', async () => {
      let aborted = false;
      const planner: Planner = {
        plan: (_task, opts) =>
          new Promise((_resolve, reject) => {
            opts?.signal?.addEventListener('abort', () => {
              aborted = true;
              reject(new Error('planner aborted'));
            });
          }),
      };
      const d = make({ planner });
      await d.start();
      const id = d.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
      expect(await d.cancel(id)).toEqual([id]);
      await d.settled();
      expect(aborted).toBe(true);
      expect(tasks()[id]?.state).toBe('canceled');
      expect(types(id)).not.toContain('task.planned');
      expect(ofType('task.status', id).map((e) => (e.data as { state: string }).state)).toEqual([
        'canceled',
      ]);
    });

    it('starts nothing for a Worker whose start was under way when it was canceled', async () => {
      let open = () => {};
      fake.startGate = new Promise<void>((r) => {
        open = r;
      });
      const d = make({
        planner: new FixedPlanner([{ key: 'a', goal: 'a [hold]', acceptanceCriteria: ['ok'] }]),
      });
      await d.start();
      const id = d.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
      // Recorded and launching, not yet registered.
      await expect
        .poll(() => ofType('worker.started', `${id}/1`).length, { timeout: 5000 })
        .toBe(1);
      expect(fake.open).toBe(0);
      await d.cancel(id);
      open();
      await expect.poll(() => fake.sessions.length, { timeout: 5000 }).toBe(1);
      await d.settled();
      // Its vendor state goes too: a canceled session is never resumed.
      await expect
        .poll(() => fake.discarded.map((x) => x.vendorSessionId), { timeout: 5000 })
        .toEqual([fake.sessions[0]?.handle.vendorSessionId]);
      expect(fake.open).toBe(0);
      expect(fake.sessions[0]?.inputs).toEqual([]);
      expect(endReasons(id)).toEqual(['canceled']);
      for (const t of [id, `${id}/1`]) expect(tasks()[t]?.state).toBe('canceled');
      // Nothing about it is recorded after the cancellation.
      const statuses = ofType('task.status', `${id}/1`).map(
        (e) => (e.data as { state: string }).state,
      );
      expect(statuses.at(-1)).toBe('canceled');
      expect(statuses.filter((x) => x === 'canceled')).toHaveLength(1);
    });

    it('records nothing more for a run whose integration was under way when it was canceled', async () => {
      let release = () => {};
      let integrating = false;
      const verified: string[] = [];
      const integrator: Integrator = {
        integrate: async (subtaskId) => {
          integrating = true;
          await new Promise<void>((r) => {
            release = r;
          });
          return { commit: 'c'.repeat(40), ref: `refs/heads/tacet/${subtaskId}` };
        },
        combine: async () => undefined,
        publish: async (taskId) => `refs/heads/tacet/result/${taskId}`,
      };
      const verifier: Verifier = {
        verify: async (task) => {
          verified.push(task.id);
          return { status: 'passed', commands: [] };
        },
      };
      const d = make({
        planner: new FixedPlanner([{ key: 'a', goal: 'a', acceptanceCriteria: ['ok'] }]),
        integrator,
        verifier,
      });
      await d.start();
      const id = d.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
      await expect.poll(() => integrating, { timeout: 5000 }).toBe(true);
      await d.cancel(id);
      release();
      await d.settled();
      expect(verified).toEqual([]);
      expect(types(`${id}/1`)).not.toContain('worker.integrated');
      expect(types(`${id}/1`)).not.toContain('task.result');
      for (const t of [id, `${id}/1`]) expect(tasks()[t]?.state).toBe('canceled');
      expect(endReasons(id)).toEqual(['canceled']);
    });

    it.skipIf(process.platform === 'win32')(
      'ends the Worker processes a crashed run left behind before recording the cancel',
      async () => {
        const d1 = make({
          planner: new FixedPlanner([{ key: 'a', goal: 'a [hold]', acceptanceCriteria: ['ok'] }]),
        });
        await d1.start();
        const id = d1.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
        await expect.poll(() => fake.open, { timeout: 5000 }).toBe(1);
        d1.crashForTest();
        // What the crashed run's Worker left: a process carrying its marker, listed in the file.
        const marker = newWorkerMarker();
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin', [WORKER_MARKER_VAR]: marker },
          stdio: 'ignore',
        });
        try {
          await expect.poll(() => markedProcesses([marker]).size, { timeout: 5000 }).toBe(1);
          writeFileSync(join(dir, 'mini.lock.workers'), `${JSON.stringify([marker])}\n`);
          const r = await cancelStopped(id, { store, lockPath: join(dir, 'mini.lock') });
          expect(r.errors).toEqual([]);
          expect(markedProcesses([marker]).size).toBe(0);
          expect(readFileSync(join(dir, 'mini.lock.workers'), 'utf8')).toBe('[]\n');
          expect(tasks()[id]?.state).toBe('canceled');
        } finally {
          child.kill('SIGKILL');
        }
      },
    );

    it('refuses an unknown task, a sub-task and a task that has ended', async () => {
      const d = make();
      await d.start();
      await expect(d.cancel('nope')).rejects.toThrow('unknown task nope');
      const id = d.submit({ goal: 'quick', acceptanceCriteria: ['ok'] });
      await d.settled();
      await expect(d.cancel(`${id}/1`)).rejects.toThrow(`cancel its task ${id}`);
      await expect(d.cancel(id)).rejects.toThrow('has already ended (completed)');
    });

    it('cancels with no Mini-conductor running, ending what a crash left open (cancelStopped)', async () => {
      const d1 = make({ planner: plan3() });
      await d1.start();
      const id = d1.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
      await expect.poll(() => fake.open, { timeout: 5000 }).toBe(2);
      // While one runs, the lock refuses.
      await expect(cancelStopped(id, { store, lockPath: join(dir, 'mini.lock') })).rejects.toThrow(
        'already running',
      );
      d1.crashForTest();

      const r = await cancelStopped(id, { store, lockPath: join(dir, 'mini.lock') });
      expect(r.canceled).toEqual([`${id}/1`, `${id}/2`, `${id}/3`, id]);
      expect(r.errors).toEqual([]);
      expect(endReasons(id)).toEqual(['canceled', 'canceled']);
      expect(tasks()[id]?.state).toBe('canceled');
      expect(miniLockHolder(join(dir, 'mini.lock'))).toBeUndefined();
      await expect(cancelStopped(id, { store, lockPath: join(dir, 'mini.lock') })).rejects.toThrow(
        'has already ended (canceled)',
      );

      // Refused, it leaves the marker file and the lock as they were.
      writeFileSync(join(dir, 'mini.lock.workers'), '["keep"]\n');
      await expect(
        cancelStopped('nope', { store, lockPath: join(dir, 'mini.lock') }),
      ).rejects.toThrow('unknown task nope');
      expect(readFileSync(join(dir, 'mini.lock.workers'), 'utf8')).toBe('["keep"]\n');
      expect(miniLockHolder(join(dir, 'mini.lock'))).toBeUndefined();

      // The next start records no restart for those sessions and runs nothing of the task.
      const before = fake.sessions.length;
      const d2 = make({ planner: plan3() });
      await d2.start();
      await d2.settled();
      expect(fake.sessions).toHaveLength(before);
      expect(endReasons(id)).toEqual(['canceled', 'canceled']);
    });
  });

  it('miniLockHolder names the running holder only (#21)', async () => {
    const lock = join(dir, 'mini.lock');
    expect(miniLockHolder(lock)).toBeUndefined();
    const d = make();
    await d.start();
    expect(miniLockHolder(lock)).toBe(process.pid);
    await d.stop();
    expect(miniLockHolder(lock)).toBeUndefined();
    // A stale lock from a process that is gone.
    writeFileSync(lock, '2147483646\n');
    expect(miniLockHolder(lock)).toBeUndefined();
  });

  it('refuses every approval an unattended Worker asks for', async () => {
    const d = make({
      planner: new FixedPlanner([
        { key: 'a', goal: 'risky [approval]', acceptanceCriteria: ['ok'] },
      ]),
    });
    await d.start();
    d.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
    await d.settled();
    expect(fake.approvalsAnswered.map((x) => x.kind)).toEqual(['reject']);
  });

  it('allows a Claude Worker file tools inside its own checkout only, and records each answer (#200)', async () => {
    let wtPath = '';
    const claude = new ScriptedAdapter('claude-sdk', (input, s) => {
      wtPath = s.opts.cwd;
      const m = /\[tool (\w+) (\S+)\]/.exec(input);
      if (!m) return { do: 'reply', text: 'done' };
      const step: Script = { do: 'approval', grant: { input: { file_path: m[2] } } };
      if (m[1]) step.toolName = m[1];
      return step;
    });
    const d = make({
      config: { ...CONFIG, tiers: { worker: { adapter: 'claude-sdk', model: 'cheap' } } },
      adapters: { 'claude-sdk': { adapter: claude, authRoute: 'api_key' } },
      planner: new FixedPlanner(
        [
          'Edit src/a.ts',
          'Write ../escape.txt',
          'Write .git/config',
          'Bash ls',
          'Read /etc/passwd',
          'Write [redacted]',
        ].map((call, i) => ({
          key: `k${i}`,
          goal: `do [tool ${call}]`,
          acceptanceCriteria: ['ok'],
          dependsOn: i > 0 ? [`k${i - 1}`] : [],
        })),
      ),
    });
    await d.start();
    d.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
    await d.settled();
    expect(wtPath).not.toBe('');
    expect(claude.approvalsAnswered.map((x) => x.kind)).toEqual([
      'allow_once',
      'reject',
      'reject',
      'reject',
      'reject',
      'reject',
    ]);
    expect(claude.approvalsAnswered[1]?.message).toMatch(/leaves the worktree.*escalate/);
    // Owner decision: allows are transcript-grade, refusals summary-grade.
    const allowed = ofType('agent.approval.decision').map((e) => e.data as Record<string, unknown>);
    expect(allowed.map((x) => [x.toolName, x.decision])).toEqual([['Edit', 'allowed']]);
    const recorded = ofType('worker.approval').map((e) => e.data as Record<string, unknown>);
    expect(recorded.map((x) => [x.toolName, x.decision])).toEqual([
      ['Write', 'refused'],
      ['Write', 'refused'],
      ['Bash', 'refused'],
      ['Read', 'refused'],
      ['Write', 'refused'],
    ]);
    // No path outside the checkout in the summary-grade record.
    expect(JSON.stringify(recorded)).not.toContain('/etc/passwd');
  });

  it('allows only the exact names of its own MCP tools', async () => {
    const d = make({
      planner: new FixedPlanner(
        ['[mcp-claude]', '[mcp-other]', '[mcp-codex]', '[mcp-spoof1]', '[mcp-spoof2]'].map(
          (m, i) => ({
            key: `k${i}`,
            goal: `call ${m}`,
            acceptanceCriteria: ['ok'],
            dependsOn: i > 0 ? [`k${i - 1}`] : [],
          }),
        ),
      ),
    });
    await d.start();
    d.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
    await d.settled();
    // Only the exact name of one of its own tools passes. Codex calls MCP tools without asking
    // (verified live), so an elicitation is refused like anything else.
    expect(fake.approvalsAnswered.map((x) => x.kind)).toEqual([
      'allow_once',
      'reject',
      'reject',
      'reject',
      'reject',
    ]);
  });

  it('discards a session stopped for a restart that is then not resumed (#153)', async () => {
    const d1 = make({
      planner: new FixedPlanner([{ key: 'long', goal: 'long [hold]', acceptanceCriteria: ['ok'] }]),
    });
    await d1.start();
    const id = d1.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
    await expect
      .poll(() => ofType('worker.vendor_session', `${id}/1`).length, { timeout: 5000 })
      .toBe(1);
    const vendor = (
      ofType('worker.vendor_session', `${id}/1`)[0]?.data as { vendorSessionId: string } | undefined
    )?.vendorSessionId;
    d1.crashForTest();
    expect(fake.discarded).toEqual([]);
    // Restarted with Workers on another adapter: the old session is never resumed.
    const oldFake = fake;
    other = new ScriptedAdapter('other', () => ({ do: 'reply', text: 'done elsewhere' }));
    const d2 = make({
      config: { ...CONFIG, tiers: { worker: { adapter: 'other', model: 'x' } } },
      adapters: {
        fake: { adapter: oldFake, authRoute: 'api_key' },
        other: { adapter: other, authRoute: 'api_key' },
      },
    });
    await d2.start();
    await d2.settled();
    expect(tasks()[id]?.state).toBe('completed');
    expect(oldFake.discarded.map((x) => x.vendorSessionId)).toEqual([vendor]);
    expect(other.sessions.some((s) => s.opts.resume)).toBe(false);
  });

  it('discards a session whose resume failed (#153)', async () => {
    const d1 = make({
      planner: new FixedPlanner([{ key: 'long', goal: 'long [hold]', acceptanceCriteria: ['ok'] }]),
    });
    await d1.start();
    const id = d1.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
    await expect
      .poll(() => ofType('worker.vendor_session', `${id}/1`).length, { timeout: 5000 })
      .toBe(1);
    const vendor = (
      ofType('worker.vendor_session', `${id}/1`)[0]?.data as { vendorSessionId: string } | undefined
    )?.vendorSessionId;
    d1.crashForTest();
    fake = new ScriptedAdapter('fake', () => ({ do: 'reply', text: 'done afresh' }));
    fake.failResumes = true;
    const d2 = make();
    await d2.start();
    await d2.settled();
    expect(tasks()[id]?.state).toBe('completed');
    // The failed resume's session, then the fresh one once it finished. (This scripted adapter
    // numbers its sessions afresh, so the fresh one reuses the id: count both.)
    expect(fake.discarded.map((x) => x.vendorSessionId)).toEqual([vendor, vendor]);
  });

  it('resumes after a crash mid-task without redoing finished work', async () => {
    const d1 = make({
      planner: new FixedPlanner([
        { key: 'quick', goal: 'quick one', acceptanceCriteria: ['ok'] },
        { key: 'long', goal: 'long one [hold]', acceptanceCriteria: ['ok'] },
        { key: 'last', goal: 'last one', acceptanceCriteria: ['ok'], dependsOn: ['long'] },
      ]),
    });
    await d1.start();
    const id = d1.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
    await expect.poll(() => tasks()[`${id}/1`]?.state, { timeout: 5000 }).toBe('completed');
    await expect
      .poll(() => ofType('worker.vendor_session', `${id}/2`).length, { timeout: 5000 })
      .toBe(1);
    const dataOf = <T>(type: string, taskId: string) =>
      ofType(type, taskId)[0]?.data as T | undefined;
    const vendor = dataOf<{ vendorSessionId: string }>(
      'worker.vendor_session',
      `${id}/2`,
    )?.vendorSessionId;
    const crashed = dataOf<{ sessionId: string }>('worker.started', `${id}/2`)?.sessionId;

    // The process dies: nothing is closed or recorded.
    d1.crashForTest();
    fake = new ScriptedAdapter('fake', (input) =>
      input.startsWith('The Mini-conductor restarted')
        ? { do: 'reply', text: 'resumed and done' }
        : script(input),
    );
    const d2 = make();
    await d2.start();
    await d2.settled();

    const all = tasks();
    for (const n of [1, 2, 3]) expect(all[`${id}/${n}`]?.state).toBe('completed');
    expect(all[id]?.state).toBe('completed');
    // The crashed session is recorded as a restart, which does not count as a failed attempt.
    expect(ofType('worker.ended', `${id}/2`)[0]?.data).toMatchObject({
      sessionId: crashed,
      reason: 'restart',
    });
    // It resumed the same vendor session in the same checkout, told that it restarted.
    const resumed = fake.sessions.find((s) => s.opts.resume);
    expect(resumed?.opts.resume?.vendorSessionId).toBe(vendor);
    // Once it finished, it will never be resumed again: discarded (#153), the crash's restart not.
    // (This scripted adapter numbers its sessions afresh, so match the checkout too.)
    expect(
      fake.discarded.filter((x) => x.vendorSessionId === vendor && x.cwd === resumed?.opts.cwd),
    ).toHaveLength(1);
    // With the restarted Mini-conductor's MCP config: a token minted for the new session (#128).
    const resumedSession = (
      ofType('worker.started', `${id}/2`).at(-1)?.data as { sessionId: string } | undefined
    )?.sessionId;
    expect(resumedSession).not.toBe(crashed);
    expect(resumed?.opts.mcpServers?.[0]?.headers).toEqual({
      authorization: `Bearer token-for-${resumedSession}`,
    });
    const firstWs = ofType('worker.started', `${id}/2`)[0]?.data as
      | { workspaceId: string }
      | undefined;
    expect(resumed?.opts.cwd).toBe(join(ws.root, firstWs?.workspaceId ?? '?'));
    expect(ofType('worker.started', `${id}/2`).map((e) => e.data)).toEqual([
      expect.objectContaining({ attempt: 1 }),
      expect.objectContaining({ attempt: 1, previousSessionId: crashed }),
    ]);
    // Finished work was not redone, and the plan was not made again.
    expect(ofType('worker.started', `${id}/1`)).toHaveLength(1);
    expect(ofType('task.planned', id)).toHaveLength(1);
    // One checkout for that sub-task, reused by the resumed session.
    expect(
      new Set(
        ofType('worker.started', `${id}/2`).map(
          (e) => (e.data as { workspaceId: string }).workspaceId,
        ),
      ).size,
    ).toBe(1);
  });

  it('re-plans a task whose plan was never written', async () => {
    store.append({
      v: 1,
      id: newUlid(),
      ts: new Date().toISOString(),
      source: { kind: 'mini', id: 'mini' },
      taskId: 'orphan',
      type: 'task.created',
      data: {
        id: 'orphan',
        goal: 'planned before a crash',
        acceptanceCriteria: ['ok'],
        createdAt: new Date().toISOString(),
      },
    });
    const d = make();
    await d.start();
    await d.settled();
    expect(tasks().orphan?.state).toBe('completed');
  });

  it('fails a task whose planning fails', async () => {
    const d = make({
      planner: {
        plan: async () => {
          throw new Error('no plan');
        },
      },
    });
    await d.start();
    const id = d.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
    await d.settled();
    expect(tasks()[id]?.state).toBe('failed');
  });

  it('runs one Mini-conductor per repo', async () => {
    const d1 = make();
    await d1.start();
    await expect(make().start()).rejects.toThrow(/already running|another Mini-conductor/);
    await d1.stop();
    // A clean stop releases the lock.
    await make().start();
  });

  it('refuses an adapter that may not run Workers, here or in the planner (#183)', () => {
    const refusing = Object.assign(new ScriptedAdapter('fake', script), {
      workerRefused: 'not for Workers (#183)',
    });
    expect(() => make({ adapters: { fake: { adapter: refusing, authRoute: 'api_key' } } })).toThrow(
      /adapter fake: refused for Workers: not for Workers \(#183\)/,
    );
    expect(
      () =>
        new AdapterPlanner({
          worker: { adapter: refusing, authRoute: 'api_key' },
          adapterId: 'acp:codex-acp',
          cwd: dir,
        }),
    ).toThrow(/refused for the planner: not for Workers/);
  });

  it('refuses a Worker adapter that is not on the api_key route', () => {
    expect(() =>
      make({
        adapters: {
          fake: { adapter: fake, authRoute: 'subscription' as unknown as 'api_key' },
        },
      }),
    ).toThrow(/api_key/);
  });
});

describe('planning', () => {
  it('parses a planner reply and rejects invalid ones', () => {
    expect(
      parseProposal(
        '```json\n{"subtasks":[{"key":"a","goal":"g","acceptanceCriteria":["c"]},{"key":"b","goal":"h","acceptanceCriteria":["d"],"dependsOn":["a"]}]}\n```',
      ).subtasks.map((s) => s.key),
    ).toEqual(['a', 'b']);
    expect(() => parseProposal('Here is my plan')).toThrow(/not JSON/);
    // A hostile reply (a long whitespace run) is refused in linear time; an over-long one at once (#203).
    const t0 = performance.now();
    expect(() => parseProposal(`x${' '.repeat(200_000)}y`)).toThrow(/not JSON/);
    expect(() => parseProposal(' '.repeat(300 * 1024))).toThrow(/longer than/);
    expect(performance.now() - t0).toBeLessThan(5000);
    // `indivisible` is kept only when true (#110).
    expect(
      parseProposal(
        '{"subtasks":[{"key":"a","goal":"g","acceptanceCriteria":["c"],"indivisible":true},{"key":"b","goal":"h","acceptanceCriteria":["d"],"indivisible":false}]}',
      ).subtasks.map((s) => s.indivisible),
    ).toEqual([true, undefined]);
    expect(() =>
      parseProposal(
        '{"subtasks":[{"key":"a","goal":"g","acceptanceCriteria":["c"],"dependsOn":["a"]}]}',
      ),
    ).toThrow(/itself/);
    expect(() => parseProposal('{"subtasks":[]}')).toThrow();
  });

  it('plans with a session on the mini tier, retrying once on an invalid reply', async () => {
    const replies = [
      'Sure! Let me think.',
      '{"rationale":"r","subtasks":[{"key":"x","goal":"X","acceptanceCriteria":["done"]}]}',
    ];
    const planner = new ScriptedAdapter('planner', () => ({
      do: 'reply',
      text: replies.shift() ?? '',
    }));
    const p = new AdapterPlanner({
      worker: { adapter: planner, authRoute: 'api_key' },
      adapterId: 'planner',
      model: 'mid',
      cwd: '/repo',
    });
    const plan = await p.plan({
      id: 't',
      goal: 'Do X',
      acceptanceCriteria: ['X done'],
      priority: 'p2',
      createdAt: new Date().toISOString(),
    });
    expect(plan.subtasks).toEqual([{ key: 'x', goal: 'X', acceptanceCriteria: ['done'] }]);
    expect(plan.planner).toMatchObject({ adapter: 'planner', model: 'mid' });
    expect(planner.sessions[0]?.inputs).toHaveLength(2);
    expect(planner.sessions[0]?.opts.systemPrompt).toContain('never write or change code');
    expect(planner.open).toBe(0);
    // Never resumed: its session is discarded once closed (#237).
    expect(planner.discarded).toEqual([
      { vendorSessionId: planner.sessions[0]?.handle.vendorSessionId, cwd: '/repo' },
    ]);
  });
});

describe('AdapterPlanner reads (#206)', () => {
  it('allows reads and searches inside its checkout, and nothing else', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tacet-planner-reads-'));
    try {
      writeFileSync(join(cwd, 'a.ts'), 'x');
      // The planner asks twice per plan (one retry), so two plans of two requests each.
      const answered: string[] = [];
      for (const steps of [
        [
          { do: 'approval', toolName: 'Read', grant: { input: { file_path: join(cwd, 'a.ts') } } },
          { do: 'approval', toolName: 'Read', grant: { input: { file_path: '/etc/passwd' } } },
        ],
        [
          { do: 'approval', toolName: 'Grep', grant: { input: { pattern: 'x' } } },
          {
            do: 'approval',
            toolName: 'Write',
            grant: { input: { file_path: 'b.ts', content: '' } },
          },
        ],
      ] as Script[][]) {
        const planner = new ScriptedAdapter(
          'claude-sdk',
          () => steps.shift() ?? { do: 'reply', text: '' },
        );
        const p = new AdapterPlanner({
          worker: { adapter: planner, authRoute: 'api_key' },
          adapterId: 'claude-sdk',
          model: 'mid',
          cwd,
        });
        await p
          .plan({
            id: 't',
            goal: 'Do X',
            acceptanceCriteria: ['X'],
            priority: 'p2',
            createdAt: new Date().toISOString(),
          })
          .catch(() => undefined);
        answered.push(...planner.approvalsAnswered.map((d) => d.kind));
      }
      expect(answered).toEqual(['allow_once', 'reject', 'allow_once', 'reject']);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('MiniConductor review fixes', () => {
  const env = (taskId: string, type: string, data: unknown, sessionId?: string): EventEnvelope =>
    ({
      v: 1,
      id: newUlid(),
      ts: new Date().toISOString(),
      source: { kind: 'mini', id: 'test' },
      taskId,
      ...(sessionId ? { sessionId } : {}),
      type,
      data,
    }) as EventEnvelope;
  const lastSession = (taskId: string) =>
    (ofType('worker.started', taskId).at(-1)?.data as { sessionId: string } | undefined)?.sessionId;
  const raise = (taskId: string, escId: string) =>
    store.append(
      env(
        taskId,
        'escalation.raised',
        {
          id: escId,
          taskId,
          question: 'Which database?',
          urgency: 'normal',
          createdAt: new Date().toISOString(),
          status: 'pending',
        },
        lastSession(taskId),
      ),
    );

  it('settles only once the parent is rolled up, even when sessions close slowly', async () => {
    fake.closeDelayMs = 300;
    const d = make({ pollMs: 60_000 });
    await d.start();
    const id = d.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
    await d.settled();
    expect(tasks()[id]?.state).toBe('completed');
  });

  it('ends a run whose session vanishes without an error, revokes its token and retries', async () => {
    let first = true;
    fake = new ScriptedAdapter('fake', (input) => {
      if (first) {
        first = false;
        return { do: 'vanish' };
      }
      return script(input);
    });
    const d = make();
    await d.start();
    const id = d.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
    await d.settled();
    expect(tasks()[`${id}/1`]?.state).toBe('completed');
    expect(
      ofType('worker.ended', `${id}/1`).map((e) => (e.data as { reason: string }).reason),
    ).toEqual(['failed', 'finished']);
    expect(revoked.sort()).toEqual(minted.sort());
  });

  it('retries when the first message cannot be sent', async () => {
    fake.failSends = 1;
    const d = make();
    await d.start();
    const id = d.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
    await d.settled();
    expect(tasks()[`${id}/1`]?.state).toBe('completed');
    expect(ofType('worker.started', `${id}/1`)).toHaveLength(2);
    expect(revoked.sort()).toEqual(minted.sort());
  });

  it('delivers an answer that arrives before the turn ends, once, instead of completing', async () => {
    const escId = newUlid();
    fake = new ScriptedAdapter('fake', (input, s) => {
      if (input.includes('[late]') && s.inputs.length === 1) {
        const sub = ofType('worker.started').at(-1)?.taskId as string;
        raise(sub, escId);
        // The gate answers after the tool returned `pending`, before the turn ends.
        store.append(env(sub, 'escalation.resolved', { escalationId: escId, answer: 'Postgres' }));
        return { do: 'reply', text: 'waiting for the answer' };
      }
      return script(input);
    });
    const d = make({
      planner: new FixedPlanner([
        { key: 'a', goal: 'pick a db [late]', acceptanceCriteria: ['ok'] },
      ]),
    });
    await d.start();
    const id = d.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
    await d.settled();
    expect(tasks()[`${id}/1`]?.state).toBe('completed');
    expect(fake.sessions[0]?.inputs).toEqual([
      expect.stringContaining('Sub-task: pick a db'),
      `Answer to your escalation ${escId}: Postgres`,
    ]);
    expect(ofType('escalation.delivered', `${id}/1`)).toHaveLength(1);
  });

  it('does not resend an answer the Worker got in the tool result', async () => {
    const escId = newUlid();
    fake = new ScriptedAdapter('fake', (input, s) => {
      if (input.includes('[inline]') && s.inputs.length === 1) {
        const sub = ofType('worker.started').at(-1)?.taskId as string;
        raise(sub, escId);
        store.append([
          env(sub, 'escalation.resolved', { escalationId: escId, answer: 'Postgres' }),
          env(sub, 'escalation.delivered', { escalationId: escId, inline: true }),
        ]);
        return { do: 'reply', text: 'used Postgres' };
      }
      return script(input);
    });
    const d = make({
      planner: new FixedPlanner([{ key: 'a', goal: 'db [inline]', acceptanceCriteria: ['ok'] }]),
    });
    await d.start();
    const id = d.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
    await d.settled();
    expect(tasks()[`${id}/1`]?.state).toBe('completed');
    expect(fake.sessions[0]?.inputs).toHaveLength(1);
  });

  it('answers with the decision text when an escalation is resolved by a decision', async () => {
    const escId = newUlid();
    fake = new ScriptedAdapter('fake', (input, s) => {
      if (input.includes('[decide]') && s.inputs.length === 1) {
        raise(ofType('worker.started').at(-1)?.taskId as string, escId);
        return { do: 'reply', text: 'waiting' };
      }
      return script(input);
    });
    const d = make({
      planner: new FixedPlanner([{ key: 'a', goal: 'db [decide]', acceptanceCriteria: ['ok'] }]),
    });
    await d.start();
    const id = d.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
    const sub = `${id}/1`;
    await expect.poll(() => tasks()[sub]?.state, { timeout: 5000 }).toBe('input_required');
    // The parent shows that it waits on the user (ADR-003 §4).
    await expect.poll(() => tasks()[id]?.state, { timeout: 5000 }).toBe('input_required');
    const decisionId = newUlid();
    store.append([
      env(sub, 'decision.recorded', {
        id: decisionId,
        escalationId: escId,
        taskId: sub,
        topic: 'database',
        decision: 'SQLite',
        scope: 'task',
        source: 'user',
        decidedAt: new Date().toISOString(),
      }),
      env(sub, 'escalation.resolved', { escalationId: escId, decisionId }),
    ]);
    await d.settled();
    expect(tasks()[sub]?.state).toBe('completed');
    expect(tasks()[id]?.state).toBe('completed');
    expect(fake.sessions[0]?.inputs.at(-1)).toBe(`Answer to your escalation ${escId}: SQLite`);
  });

  it('retries after failed verification, with the feedback in the first message', async () => {
    let calls = 0;
    const d = make({
      verifier: {
        verify: async () => {
          calls += 1;
          return calls === 1
            ? { status: 'failed', commands: ['pnpm test'], notes: 'tests red' }
            : { status: 'passed', commands: ['pnpm test'] };
        },
      },
    });
    await d.start();
    const id = d.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
    await d.settled();
    expect(tasks()[`${id}/1`]?.state).toBe('completed');
    expect(fake.sessions[1]?.inputs[0]).toContain('The previous attempt did not succeed');
    expect(revoked.sort()).toEqual(minted.sort());
  });

  it('treats a login problem as auth_required, without spending attempts', async () => {
    fake = new ScriptedAdapter('fake', () => ({ do: 'auth' }));
    const d = make();
    await d.start();
    const id = d.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
    await d.settled();
    expect(tasks()[`${id}/1`]?.state).toBe('auth_required');
    expect(tasks()[id]?.state).toBe('auth_required');
    expect(ofType('worker.started', `${id}/1`)).toHaveLength(1);
  });

  it('fails a sub-task whose checkout cannot be made, and runs the others', async () => {
    const create = ws.create.bind(ws);
    let calls = 0;
    // The first checkout (sub-task 1, scheduled first) cannot be made.
    ws.create = async (workerId: string) => {
      calls += 1;
      if (calls === 1) throw new Error('disk full');
      return create(workerId);
    };
    const d = make({
      planner: new FixedPlanner([
        { key: 'a', goal: 'one', acceptanceCriteria: ['ok'] },
        { key: 'b', goal: 'two', acceptanceCriteria: ['ok'] },
      ]),
    });
    await d.start();
    const id = d.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
    await d.settled();
    expect(tasks()[`${id}/1`]?.state).toBe('failed');
    expect(tasks()[`${id}/2`]?.state).toBe('completed');
    expect(tasks()[id]?.state).toBe('failed');
  });

  it('resumes after a clean stop as well as after a crash', async () => {
    const d1 = make({
      planner: new FixedPlanner([{ key: 'a', goal: 'long [hold]', acceptanceCriteria: ['ok'] }]),
    });
    await d1.start();
    const id = d1.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
    await expect
      .poll(() => ofType('worker.vendor_session', `${id}/1`).length, { timeout: 5000 })
      .toBe(1);
    await d1.stop();
    expect(ofType('worker.ended', `${id}/1`)[0]?.data).toMatchObject({ reason: 'restart' });
    expect(revoked.sort()).toEqual(minted.sort());
    fake = new ScriptedAdapter('fake', (input) =>
      input.startsWith('The Mini-conductor restarted')
        ? { do: 'reply', text: 'done' }
        : script(input),
    );
    const d2 = make();
    await d2.start();
    await d2.settled();
    expect(tasks()[id]?.state).toBe('completed');
    expect(fake.sessions[0]?.opts.resume).toBeDefined();
  });

  it('takes over a lock left by a process that is gone', async () => {
    writeFileSync(join(dir, 'mini.lock'), '2147483646\n');
    await make().start();
  });

  it('charges the planner session to the planned task', async () => {
    const d = make({
      planner: {
        plan: async () => ({
          subtasks: [{ key: 'a', goal: 'g', acceptanceCriteria: ['ok'] }],
          usage: { inputTokens: 1200, outputTokens: 300 },
        }),
      },
    });
    await d.start();
    const id = d.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
    await d.settled();
    expect(tasks()[id]?.usage).toMatchObject({ inputTokens: 1200, outputTokens: 300 });
  });

  it('refuses sub-task ids, duplicate ids and parentId from outside', async () => {
    const d = make();
    await d.start();
    expect(() => d.submit({ goal: 'g', acceptanceCriteria: ['ok'], id: 'a/1' })).toThrow(/"\/"/);
    d.submit({ goal: 'g', acceptanceCriteria: ['ok'], id: 'same' });
    expect(() => d.submit({ goal: 'g', acceptanceCriteria: ['ok'], id: 'same' })).toThrow(/exists/);
    expect(() =>
      d.submit({ goal: 'g', acceptanceCriteria: ['ok'], parentId: 'x' } as never),
    ).toThrow(/sub-tasks/);
  });

  for (const how of ['stop', 'crash'] as const) {
    it(`runs a waiting sub-task again after a ${how} once its escalation is answered`, async () => {
      const escId = newUlid();
      fake = new ScriptedAdapter('fake', (input, sess) => {
        if (input.includes('[wait]') && sess.inputs.length === 1) {
          raise(ofType('worker.started').at(-1)?.taskId as string, escId);
          return { do: 'reply', text: 'waiting' };
        }
        return script(input);
      });
      const d1 = make({
        planner: new FixedPlanner([{ key: 'a', goal: 'db [wait]', acceptanceCriteria: ['ok'] }]),
      });
      await d1.start();
      const id = d1.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
      const sub = `${id}/1`;
      await expect.poll(() => tasks()[sub]?.state, { timeout: 5000 }).toBe('input_required');
      if (how === 'stop') await d1.stop();
      else d1.crashForTest();
      // The answer arrives while no Mini-conductor is running.
      store.append(env(sub, 'escalation.resolved', { escalationId: escId, answer: 'Postgres' }));
      fake = new ScriptedAdapter('fake', script);
      const d2 = make();
      await d2.start();
      await d2.settled();
      expect(tasks()[sub]?.state).toBe('completed');
      expect(tasks()[id]?.state).toBe('completed');
      // The answer went into the first message of the new session, once.
      const first = fake.sessions[0]?.inputs[0] ?? '';
      expect(first).toContain(`Answer to your escalation ${escId}: Postgres`);
      expect(ofType('escalation.delivered', sub)).toHaveLength(1);
    });
  }

  it('retries an auth_required sub-task after a restart', async () => {
    fake = new ScriptedAdapter('fake', () => ({ do: 'auth' }));
    const d1 = make();
    await d1.start();
    const id = d1.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
    await d1.settled();
    expect(tasks()[id]?.state).toBe('auth_required');
    await d1.stop();
    // The user fixed the key.
    fake = new ScriptedAdapter('fake', script);
    const d2 = make();
    await d2.start();
    await d2.settled();
    expect(tasks()[`${id}/1`]?.state).toBe('completed');
    expect(tasks()[id]?.state).toBe('completed');
  });

  it('writes nothing more after a crash while a session is starting', async () => {
    fake.startDelayMs = 200;
    const d = make();
    await d.start();
    const id = d.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
    await expect.poll(() => ofType('worker.started', `${id}/1`).length, { timeout: 5000 }).toBe(1);
    d.crashForTest();
    const before = store.count();
    await new Promise((r) => setTimeout(r, 400));
    expect(store.count()).toBe(before);
    // The session that finished starting was given back, and its token revoked.
    expect(fake.open).toBe(0);
    expect(revoked.sort()).toEqual(minted.sort());
  });

  describe('Worker health', () => {
    let t = Date.parse('2026-11-09T12:00:00.000Z');
    const now = () => new Date(t);
    const advance = (seconds: number) => {
      t += seconds * 1000;
    };
    const health = {
      ...CONFIG,
      workers: { max: 4, max_attempts: 3, stuck_after_s: 300, nudge_grace_s: 900 },
    };

    it('nudges a silent Worker, then replaces it, and the retry carries on', async () => {
      let sessions = 0;
      fake = new ScriptedAdapter('fake', (input) => {
        if (input.startsWith('Sub-task')) {
          sessions += 1;
          if (sessions === 1) return { do: 'hold' };
        }
        return script(input);
      });
      const d = make({ config: health, now });
      await d.start();
      const id = d.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
      const sub = `${id}/1`;
      await expect
        .poll(() => ofType('worker.vendor_session', sub).length, { timeout: 5000 })
        .toBe(1);
      advance(299);
      await new Promise((r) => setTimeout(r, 100));
      expect(ofType('worker.nudged', sub)).toHaveLength(0);
      advance(2);
      await expect.poll(() => ofType('worker.nudged', sub).length, { timeout: 5000 }).toBe(1);
      // Recorded, not sent: real adapters would queue it as the next turn.
      expect(fake.sessions[0]?.inputs).toHaveLength(1);
      advance(899);
      await new Promise((r) => setTimeout(r, 100));
      expect(ofType('worker.ended', sub)).toHaveLength(0);
      advance(2);
      await d.settled();
      expect(ofType('worker.ended', sub).map((e) => (e.data as { reason: string }).reason)).toEqual(
        ['stuck', 'finished'],
      );
      expect(tasks()[sub]?.state).toBe('completed');
      expect(
        ofType('worker.started', sub).map((e) => (e.data as { attempt: number }).attempt),
      ).toEqual([1, 2]);
    });

    it('takes progress reports as signs of life, whatever the backend clock says', async () => {
      fake = new ScriptedAdapter('fake', (input) =>
        input.startsWith('Sub-task') ? { do: 'hold' } : script(input),
      );
      // The MCP backend's clock runs an hour ahead of the daemon's.
      const backend = new EventLogBackend({ store, now: () => new Date(t + 3_600_000) });
      const d = make({ config: health, now });
      await d.start();
      const id = d.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
      const sub = `${id}/1`;
      await expect
        .poll(() => ofType('worker.vendor_session', sub).length, { timeout: 5000 })
        .toBe(1);
      const binding = { workerSessionId: minted[0] ?? '', taskId: sub };
      for (let i = 0; i < 4; i++) {
        advance(200);
        await backend.reportProgress(binding, { summary: `step ${i}` });
        await new Promise((r) => setTimeout(r, 60));
      }
      expect(ofType('worker.progress', sub)).toHaveLength(4);
      expect(ofType('worker.nudged', sub)).toHaveLength(0);
      // Then silence: the skewed timestamps must not push the heartbeat into the future.
      advance(301);
      await expect.poll(() => ofType('worker.nudged', sub).length, { timeout: 5000 }).toBe(1);
    });

    it('leaves a Worker in a long tool call alone, but not forever', async () => {
      fake = new ScriptedAdapter('fake', (input) =>
        input.startsWith('Sub-task') ? { do: 'tool-hold' } : script(input),
      );
      const d = make({ config: health, now });
      await d.start();
      const id = d.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
      const sub = `${id}/1`;
      await expect.poll(() => ofType('agent.tool.call', sub).length, { timeout: 5000 }).toBe(1);
      advance(1199);
      await new Promise((r) => setTimeout(r, 150));
      expect(ofType('worker.nudged', sub)).toHaveLength(0);
      // Open for stuck_after_s + nudge_grace_s: a hung watcher or prompt, not a long test run.
      advance(2);
      await expect.poll(() => ofType('worker.nudged', sub).length, { timeout: 5000 }).toBe(1);
      advance(901);
      await expect
        .poll(() => ofType('worker.ended', sub).map((e) => (e.data as { reason: string }).reason), {
          timeout: 5000,
        })
        .toEqual(['stuck']);
      await expect.poll(() => ofType('worker.started', sub).length, { timeout: 5000 }).toBe(2);
    });

    it('leaves a Worker waiting on an answer alone', async () => {
      const escId = newUlid();
      fake = new ScriptedAdapter('fake', (_input, sess) => {
        if (sess.inputs.length === 1) {
          const started = ofType('worker.started').at(-1);
          store.append({
            v: 1,
            id: newUlid(t),
            ts: now().toISOString(),
            source: { kind: 'worker', id: 'w' },
            taskId: started?.taskId as string,
            sessionId: (started?.data as { sessionId: string } | undefined)?.sessionId ?? '',
            type: 'escalation.raised',
            data: {
              id: escId,
              taskId: started?.taskId,
              question: 'q?',
              urgency: 'normal',
              createdAt: now().toISOString(),
              status: 'pending',
            },
          } as EventEnvelope);
          return { do: 'reply', text: 'waiting' };
        }
        // The answer starts a long, quiet turn.
        return { do: 'hold' };
      });
      const d = make({ config: health, now });
      await d.start();
      const id = d.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
      const sub = `${id}/1`;
      await expect.poll(() => tasks()[sub]?.state, { timeout: 5000 }).toBe('input_required');
      advance(3600);
      await new Promise((r) => setTimeout(r, 150));
      expect(ofType('worker.nudged', sub)).toHaveLength(0);
      // The answer after an hour starts a new turn: the wait is not silence.
      store.append(env(sub, 'escalation.resolved', { escalationId: escId, answer: 'yes' }));
      await expect
        .poll(() => ofType('escalation.delivered', sub).length, { timeout: 5000 })
        .toBe(1);
      await new Promise((r) => setTimeout(r, 150));
      expect(ofType('worker.nudged', sub)).toHaveLength(0);
      advance(301);
      await expect.poll(() => ofType('worker.nudged', sub).length, { timeout: 5000 }).toBe(1);
    });

    it('starts the heartbeat afresh after a restart', async () => {
      fake = new ScriptedAdapter('fake', (input) =>
        input.startsWith('Sub-task') ? { do: 'hold' } : script(input),
      );
      const d1 = make({ config: health, now });
      await d1.start();
      const id = d1.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
      const sub = `${id}/1`;
      await expect
        .poll(() => ofType('worker.vendor_session', sub).length, { timeout: 5000 })
        .toBe(1);
      d1.crashForTest();
      // Hours pass before the Mini-conductor comes back.
      advance(5 * 3600);
      fake = new ScriptedAdapter('fake', () => ({ do: 'hold' }));
      const d2 = make({ config: health, now });
      await d2.start();
      await expect.poll(() => ofType('worker.started', sub).length, { timeout: 5000 }).toBe(2);
      await new Promise((r) => setTimeout(r, 150));
      expect(ofType('worker.nudged', sub)).toHaveLength(0);
    });
  });
});

describe('handoff reseed (#129)', () => {
  const packet = (next: string) => ({
    goal: 'g',
    acceptanceCriteria: ['ok'],
    stateSummary: 'half done',
    decisions: [],
    filesTouched: ['a.ts'],
    commandsRun: [],
    openQuestions: [],
    nextAction: next,
    verification: { status: 'partial', commands: [] },
  });
  /** The backend as standalone wires it: the Mini-conductor decides and reseeds. */
  const backendFor = (d: MiniConductor) =>
    new EventLogBackend({
      store,
      canHandoff: (b) => d.handoffRefusal(b.workerSessionId),
      onHandoff: (b) => d.handoff(b.workerSessionId),
    });
  const reasons = (sub: string) =>
    ofType('worker.ended', sub).map((e) => (e.data as { reason: string }).reason);

  it('ends the session and seeds a successor from the packet, in the same checkout, with the same restrictions', async () => {
    // The first session holds its turn and hands off; the successor finishes.
    fake = new ScriptedAdapter('fake', (input) =>
      input.includes('handed off') ? { do: 'reply', text: 'done' } : { do: 'hold' },
    );
    const d = make();
    const backend = backendFor(d);
    await d.start();
    const id = d.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
    const sub = `${id}/1`;
    await expect.poll(() => ofType('worker.vendor_session', sub).length, { timeout: 5000 }).toBe(1);
    const first = { workerSessionId: minted[0] ?? '', taskId: sub };
    await expect(
      backend.requestHandoff(first, { reason: 'context', packet: packet('write the burst test') }),
    ).resolves.toMatchObject({ accepted: true });
    await d.settled();
    expect(reasons(sub)).toEqual(['handoff', 'finished']);
    expect(tasks()[sub]?.state).toBe('completed');
    const [a, b] = fake.sessions;
    // Not resumed: a new vendor session, seeded by its first message and read_task.
    expect(b?.opts.resume).toBeUndefined();
    expect(b?.inputs[0]).toContain('handed off');
    expect(b?.inputs[0]).toContain('read_task');
    const successor = { workerSessionId: minted[1] ?? '', taskId: sub };
    expect((await backend.readTask(successor)).handoff?.nextAction).toBe('write the burst test');
    // The same checkout, the same Worker restrictions, a fresh MCP token; the old one revoked.
    expect(b?.opts.cwd).toBe(a?.opts.cwd);
    const { mcpServers: ma, env: ea, ...restA } = a?.opts ?? {};
    const { mcpServers: mb, env: eb, ...restB } = b?.opts ?? {};
    expect(restB).toEqual(restA);
    expect(Object.keys(eb ?? {})).toEqual(Object.keys(ea ?? {}));
    expect(mb?.[0]?.headers).not.toEqual(ma?.[0]?.headers);
    expect(revoked).toContain(minted[0]);
    // Not an attempt: the successor is attempt 1 again, and it records taking the handoff up.
    const started = ofType('worker.started', sub).map(
      (e) => e.data as { attempt: number; previousSessionId?: string },
    );
    expect(started.map((x) => x.attempt)).toEqual([1, 1]);
    expect(started[1]?.previousSessionId).toBe(minted[0]);
    expect(ofType('handoff.accepted', sub).map((e) => e.data)).toEqual([
      expect.objectContaining({ sessionId: minted[1] }),
    ]);
  });

  it('starts the successor from the packet after a crash, never resuming the old session', async () => {
    fake = new ScriptedAdapter('fake', (input) =>
      input.includes('handed off') ? { do: 'reply', text: 'done' } : { do: 'hold' },
    );
    // A Mini-conductor that records the packet but crashes before acting on it.
    const first = make();
    const backend = new EventLogBackend({ store });
    await first.start();
    const id = first.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
    const sub = `${id}/1`;
    await expect.poll(() => ofType('worker.vendor_session', sub).length, { timeout: 5000 }).toBe(1);
    await backend.requestHandoff(
      { workerSessionId: minted[0] ?? '', taskId: sub },
      { reason: 'context', packet: packet('carry on') },
    );
    // The process dies: nothing is closed or recorded.
    first.crashForTest();
    fake = new ScriptedAdapter('fake', (input) =>
      input.includes('handed off') ? { do: 'reply', text: 'done' } : { do: 'hold' },
    );
    const second = make();
    await second.start();
    await second.settled();
    expect(reasons(sub)).toEqual(['handoff', 'finished']);
    const successor = fake.sessions.at(-1);
    expect(fake.sessions).toHaveLength(1);
    expect(successor?.opts.resume).toBeUndefined();
    expect(successor?.inputs[0]).toContain('read_task');
    expect(ofType('handoff.accepted', sub)).toHaveLength(1);
  });

  it('keeps the seed for a retry when the successor fails to start', async () => {
    let starts = 0;
    fake = new ScriptedAdapter('fake', (input) =>
      input.includes('handed off') ? { do: 'reply', text: 'done' } : { do: 'hold' },
    );
    const start = fake.start.bind(fake);
    fake.start = async (o) => {
      starts += 1;
      // The second start, the first successor, fails before its first message.
      if (starts === 2) throw new Error('vendor down');
      return start(o);
    };
    const d = make();
    const backend = backendFor(d);
    await d.start();
    const id = d.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
    const sub = `${id}/1`;
    await expect.poll(() => ofType('worker.vendor_session', sub).length, { timeout: 5000 }).toBe(1);
    await backend.requestHandoff(
      { workerSessionId: minted[0] ?? '', taskId: sub },
      { reason: 'context', packet: packet('carry on') },
    );
    await d.settled();
    expect(tasks()[sub]?.state).toBe('completed');
    expect(fake.sessions.at(-1)?.inputs[0]).toContain('read_task');
    expect(ofType('handoff.accepted', sub)).toHaveLength(1);
  });

  it('refuses a handoff while the turn is being checked, after the task ended, or past max_handoffs', async () => {
    fake = new ScriptedAdapter('fake', () => ({ do: 'hold' }));
    const d = make({ config: { ...CONFIG, workers: { ...CONFIG.workers, max_handoffs: 1 } } });
    const backend = backendFor(d);
    await d.start();
    const id = d.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
    const sub = `${id}/1`;
    await expect.poll(() => ofType('worker.vendor_session', sub).length, { timeout: 5000 }).toBe(1);
    expect(d.handoffRefusal('not-a-session')).toMatch(/not running/);
    await backend.requestHandoff(
      { workerSessionId: minted[0] ?? '', taskId: sub },
      { reason: 'context', packet: packet('one') },
    );
    await expect.poll(() => fake.sessions.length, { timeout: 5000 }).toBe(2);
    await expect.poll(() => ofType('handoff.accepted', sub).length, { timeout: 5000 }).toBe(1);
    // The limit: refused before anything is recorded.
    const second = { workerSessionId: minted[1] ?? '', taskId: sub };
    await expect(
      backend.requestHandoff(second, { reason: 'context', packet: packet('two') }),
    ).rejects.toThrow(/handoff limit reached \(1 for this sub-task\)/);
    expect(ofType('handoff.requested', sub)).toHaveLength(1);
    await d.cancel(id);
    expect(d.handoffRefusal(minted[1] ?? '')).toMatch(/not running|ended/);
  });
});
