import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type EventEnvelope, newUlid, type TacetConfig, tasksProjection } from '@tacet/core';
import { type EventStore, openEventStore } from '@tacet/core/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MiniConductor, type MiniConductorOptions } from './daemon.js';
import { AdapterPlanner, parseProposal, SingleStepPlanner } from './planner.js';
import type { Planner, ProposedSubtask, WorkerMcp } from './ports.js';
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
        headers: { authorization: 'Bearer x' },
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
        // The first session is hung: it takes the nudge and does nothing.
        if (input.startsWith('Status check')) return { do: 'ignore' };
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
      expect(fake.sessions[0]?.inputs.at(-1)).toMatch(/^Status check/);
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

    it('does not nudge a Worker that reports progress', async () => {
      fake = new ScriptedAdapter('fake', (input) =>
        input.startsWith('Sub-task') ? { do: 'hold' } : script(input),
      );
      const d = make({ config: health, now });
      await d.start();
      const id = d.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
      const sub = `${id}/1`;
      await expect
        .poll(() => ofType('worker.vendor_session', sub).length, { timeout: 5000 })
        .toBe(1);
      const sessionId = (
        ofType('worker.started', sub)[0]?.data as { sessionId: string } | undefined
      )?.sessionId;
      for (let i = 0; i < 4; i++) {
        advance(200);
        store.append({
          v: 1,
          id: newUlid(t),
          ts: now().toISOString(),
          source: { kind: 'worker', id: sessionId ?? '' },
          taskId: sub,
          ...(sessionId ? { sessionId } : {}),
          type: 'worker.progress',
          data: { summary: `step ${i}` },
        });
        await new Promise((r) => setTimeout(r, 60));
      }
      expect(ofType('worker.nudged', sub)).toHaveLength(0);
      fake.release();
      await d.settled();
      expect(tasks()[sub]?.state).toBe('completed');
    });

    it('leaves a Worker running a long tool call alone', async () => {
      fake = new ScriptedAdapter('fake', (input) =>
        input.startsWith('Sub-task') ? { do: 'tool-hold' } : script(input),
      );
      const d = make({ config: health, now });
      await d.start();
      const id = d.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
      const sub = `${id}/1`;
      await expect.poll(() => ofType('agent.tool.call', sub).length, { timeout: 5000 }).toBe(1);
      advance(3600);
      await new Promise((r) => setTimeout(r, 150));
      expect(ofType('worker.nudged', sub)).toHaveLength(0);
      expect(ofType('worker.ended', sub)).toHaveLength(0);
    });

    it('leaves a Worker waiting on an answer alone', async () => {
      const escId = newUlid();
      fake = new ScriptedAdapter('fake', (input, sess) => {
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
        return script(input);
      });
      const d = make({ config: health, now });
      await d.start();
      const id = d.submit({ goal: 'g', acceptanceCriteria: ['ok'] });
      const sub = `${id}/1`;
      await expect.poll(() => tasks()[sub]?.state, { timeout: 5000 }).toBe('input_required');
      advance(3600);
      await new Promise((r) => setTimeout(r, 150));
      expect(ofType('worker.nudged', sub)).toHaveLength(0);
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
