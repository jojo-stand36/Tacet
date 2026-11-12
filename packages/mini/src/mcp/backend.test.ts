import { escalationStats, newUlid } from '@tacet/core';
import { type EventStore, openEventStore, type WorkerBinding } from '@tacet/core/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventLogBackend, ToolError } from './backend.js';

const NOW = '2026-11-09T12:00:00.000Z';
const W1: WorkerBinding = { workerSessionId: 'w-1', taskId: 'task-1' };

describe('EventLogBackend', () => {
  let store: EventStore;
  let clock: number;
  beforeEach(() => {
    store = openEventStore(':memory:');
    clock = Date.parse(NOW);
    store.append({
      v: 1,
      id: newUlid(),
      ts: NOW,
      source: { kind: 'mini', id: 'mini' },
      taskId: 'task-1',
      type: 'task.created',
      data: { id: 'task-1', goal: 'G', acceptanceCriteria: ['A'], createdAt: NOW },
    });
  });
  afterEach(() => store.close());
  const make = (extra: object = {}) =>
    new EventLogBackend({ store, now: () => new Date(clock), ...extra });
  const types = () => store.query().map((e) => e.envelope.type);

  it('resolves an escalation through the gate, or leaves it pending after the timeout', async () => {
    const resolved = await make({
      gate: async () => ({ answer: 'use sqlite', source: 'precedent' }),
    }).escalate(W1, { question: 'db?', urgency: 'normal' });
    expect(resolved).toMatchObject({
      status: 'resolved',
      answer: 'use sqlite',
      source: 'precedent',
    });
    const later = await make().getDecision(W1, { escalationId: resolved.escalationId });
    expect(later).toEqual({ status: 'resolved', answer: 'use sqlite', source: 'precedent' });

    const slow = make({ gate: () => new Promise(() => {}), gateTimeoutMs: 20 });
    await expect(slow.escalate(W1, { question: 'q', urgency: 'low' })).resolves.toMatchObject({
      status: 'pending',
    });
    const failing = make({ gate: async () => Promise.reject(new Error('boom')) });
    await expect(failing.escalate(W1, { question: 'q', urgency: 'low' })).resolves.toMatchObject({
      status: 'pending',
    });
  });

  it('returns field errors for an invalid handoff packet and takes identity from the token', async () => {
    const b = make();
    const bad = b.requestHandoff(W1, { reason: 'r', packet: { v: 1, goal: 'G' } });
    await expect(bad).rejects.toBeInstanceOf(ToolError);
    await expect(bad).rejects.toMatchObject({
      detail: {
        accepted: false,
        errors: expect.arrayContaining([expect.stringMatching(/^nextAction/)]),
      },
    });
    const ok = await b.requestHandoff(W1, {
      reason: 'r',
      packet: {
        v: 1,
        taskId: 'someone-else',
        parentSession: 'spoofed',
        createdAt: NOW,
        goal: 'G',
        acceptanceCriteria: [],
        stateSummary: 's',
        nextAction: 'n',
        verification: { status: 'not_run' },
      },
    });
    expect(ok.accepted).toBe(true);
    const task = await b.readTask(W1);
    expect(task.handoff).toMatchObject({
      id: ok.handoffId,
      taskId: 'task-1',
      parentSession: 'w-1',
    });
  });

  it('records task decisions directly and turns repo decisions into escalations', async () => {
    const b = make();
    expect(
      await b.recordDecision(W1, { topic: 'style', decision: 'tabs', scope: 'task' }),
    ).toMatchObject({ status: 'recorded' });
    const repo = await b.recordDecision(W1, { topic: 'db', decision: 'postgres', scope: 'repo' });
    expect(repo).toMatchObject({ status: 'needs_approval', escalationId: expect.any(String) });
    expect(types()).toEqual(['task.created', 'decision.recorded', 'escalation.raised']);
    const allowed = make({ allowRepoDecision: () => true });
    expect(
      await allowed.recordDecision(W1, { topic: 'db', decision: 'postgres', scope: 'repo' }),
    ).toMatchObject({ status: 'recorded' });
    // Repo decisions are precedent for other tasks; task decisions are not.
    const other = await make().searchDecisions(
      { workerSessionId: 'w-9', taskId: 'task-9' },
      { query: 'db style' },
    );
    expect(other.decisions.map((d) => d.topic)).toEqual(['db']);
  });

  it('stores at most one progress report per interval per worker', async () => {
    const b = make({ progressIntervalMs: 1000 });
    await b.reportProgress(W1, { summary: 'a' });
    await b.reportProgress(W1, { summary: 'b' });
    clock += 1000;
    await b.reportProgress(W1, { summary: 'c' });
    await b.reportProgress({ workerSessionId: 'w-2', taskId: 'task-1' }, { summary: 'd' });
    expect(
      store
        .query({ typePrefix: 'worker.progress' })
        .map((e) => (e.envelope.data as { summary: string }).summary),
    ).toEqual(['a', 'c', 'd']);
  });

  it('keeps no state for a Worker it was told to forget (#122)', async () => {
    const b = make({ progressIntervalMs: 1000 });
    await b.reportProgress(W1, { summary: 'a' });
    await b.reportProgress({ workerSessionId: 'w-2', taskId: 'task-1' }, { summary: 'b' });
    expect(b.workersWithState).toBe(2);
    b.forget(W1.workerSessionId);
    expect(b.workersWithState).toBe(1);
    // Starts clean: within the same interval, its next report is stored at once (it would be
    // held back if anything of the forgotten state were left).
    await b.reportProgress(W1, { summary: 'c' });
    // w-2 was not forgotten: still held back.
    await b.reportProgress({ workerSessionId: 'w-2', taskId: 'task-1' }, { summary: 'd' });
    expect(
      store
        .query({ typePrefix: 'worker.progress' })
        .map((e) => (e.envelope.data as { summary: string }).summary),
    ).toEqual(['a', 'b', 'c']);
  });

  it('does not keep progress state past the interval, whatever was not forgotten', async () => {
    const b = make({ progressIntervalMs: 1000 });
    for (let i = 0; i < 50; i++) {
      await b.reportProgress({ workerSessionId: `w-${i}`, taskId: 'task-1' }, { summary: 'x' });
    }
    expect(b.workersWithState).toBe(50);
    // Just inside the interval: nothing is dropped, and the limit still holds.
    clock += 999;
    await b.reportProgress({ workerSessionId: 'w-0', taskId: 'task-1' }, { summary: 'held' });
    expect(b.workersWithState).toBe(50);
    clock += 1;
    await b.reportProgress(W1, { summary: 'later' });
    expect(b.workersWithState).toBe(1);
    expect(
      store
        .query({ typePrefix: 'worker.progress' })
        .map((e) => (e.envelope.data as { summary: string }).summary),
    ).not.toContain('held');
  });

  it('rate-limits escalate per Worker, with a readable error and one event (#121)', async () => {
    const b = make();
    const W2: WorkerBinding = { workerSessionId: 'w-2', taskId: 'task-1' };
    const ask = (w: WorkerBinding, n: number) =>
      b.escalate(w, { question: `Question ${n}?`, urgency: 'normal' });
    for (let n = 0; n < 6; n++) await ask(W1, n);
    const err = await ask(W1, 6).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).message).toMatch(/rate-limited.*at most 6 per 10 minutes/);
    expect((err as ToolError).detail).toMatchObject({ tool: 'escalate', limit: 6 });
    await expect(ask(W1, 7)).rejects.toBeInstanceOf(ToolError);
    const raised = () => store.query({ typePrefix: 'escalation.raised' });
    expect(raised()).toHaveLength(6);
    // One event for the window, however many calls were refused.
    const throttled = store.query({ typePrefix: 'worker.throttled' }).map((e) => e.envelope);
    expect(throttled).toHaveLength(1);
    expect(throttled[0]).toMatchObject({
      sessionId: 'w-1',
      source: { kind: 'mini' },
      data: { sessionId: 'w-1', tool: 'escalate', limit: 6, windowMs: 600_000 },
    });
    // Another Worker has its own limit.
    await ask(W2, 0);
    expect(raised()).toHaveLength(7);
    // Once the window has passed, the Worker may ask again.
    clock += 600_000;
    await ask(W1, 8);
    expect(raised()).toHaveLength(8);
  });

  it('rate-limits record_decision, configurably, and forgets the counts on revoke', async () => {
    const b = make({ limits: { record_decision: { max: 2, windowMs: 60_000 } } });
    const decide = (n: number) =>
      b.recordDecision(W1, { topic: `t${n}`, decision: 'd', scope: 'task' });
    await decide(1);
    await decide(2);
    await expect(decide(3)).rejects.toThrow(/record_decision is rate-limited/);
    expect(store.query({ typePrefix: 'decision.recorded' })).toHaveLength(2);
    expect(b.workersWithState).toBe(1);
    b.forget(W1.workerSessionId);
    expect(b.workersWithState).toBe(0);
    // Escalate keeps its default limit.
    await b.escalate(W1, { question: 'q?', urgency: 'normal' });
  });

  it('slides the window, and never counts a refused call', async () => {
    const b = make({ limits: { escalate: { max: 2, windowMs: 60_000 } } });
    const ask = () => b.escalate(W1, { question: 'q?', urgency: 'normal' });
    await ask(); // t=0
    clock += 30_000;
    await ask(); // t=30s
    // At t=59.999s the first call is still in the window: refused, 1 ms to wait.
    clock += 29_999;
    const err = (await ask().catch((e: unknown) => e)) as ToolError;
    expect(err.detail).toMatchObject({ retryAfterMs: 1 });
    expect(err.message).toMatch(/before 1 second from now/);
    // Refused calls do not count: at t=60s the first call has left the window, one slot is free.
    for (let n = 0; n < 3; n++) await expect(ask()).rejects.toBeInstanceOf(ToolError);
    clock += 1;
    await ask();
    await expect(ask()).rejects.toBeInstanceOf(ToolError);
    expect(store.query({ typePrefix: 'escalation.raised' })).toHaveLength(3);
  });

  it('counts a repo decision that needs approval as an escalation too', async () => {
    const b = make();
    const propose = (n: number) =>
      b.recordDecision(W1, { topic: `t${n}`, decision: 'd', scope: 'repo' });
    for (let n = 0; n < 6; n++)
      expect(await propose(n)).toMatchObject({ status: 'needs_approval' });
    await expect(propose(6)).rejects.toThrow(/escalate is rate-limited/);
    await expect(b.escalate(W1, { question: 'q?', urgency: 'normal' })).rejects.toBeInstanceOf(
      ToolError,
    );
    expect(store.query({ typePrefix: 'escalation.raised' })).toHaveLength(6);
    // A task decision, which asks nobody, is still allowed: it only counts as a decision.
    expect(await b.recordDecision(W1, { topic: 'x', decision: 'd', scope: 'task' })).toMatchObject({
      status: 'recorded',
    });
  });

  it('refuses limits that are not positive integers', () => {
    for (const bad of [
      { max: 0, windowMs: 1000 },
      { max: 2, windowMs: 0 },
      { max: 1.5, windowMs: 1000 },
      { max: Number.NaN, windowMs: 1000 },
    ]) {
      expect(() => make({ limits: { escalate: bad } })).toThrow(/positive integers/);
    }
  });

  it('drops call counts once their window has passed, for every Worker', async () => {
    const b = make();
    for (let i = 0; i < 20; i++) {
      await b.escalate(
        { workerSessionId: `w-${i}`, taskId: 'task-1' },
        {
          question: 'q?',
          urgency: 'normal',
        },
      );
    }
    expect(b.workersWithState).toBe(20);
    clock += 600_000;
    await b.escalate(W1, { question: 'q?', urgency: 'normal' });
    expect(b.workersWithState).toBe(1);
  });

  it('refuses unknown tasks and other tasks’ escalations', async () => {
    const b = make();
    await expect(b.readTask({ workerSessionId: 'w', taskId: 'nope' })).rejects.toBeInstanceOf(
      ToolError,
    );
    const esc = await b.escalate(W1, { question: 'q', urgency: 'low' });
    await expect(
      b.getDecision(
        { workerSessionId: 'w-2', taskId: 'task-2' },
        { escalationId: esc.escalationId },
      ),
    ).rejects.toBeInstanceOf(ToolError);
  });
  it('never lets the gate approve a repo-scope decision', async () => {
    const b = make({ gate: async () => ({ answer: 'yes', source: 'mini' }) });
    const r = await b.recordDecision(W1, { topic: 'db', decision: 'postgres', scope: 'repo' });
    expect(r.status).toBe('needs_approval');
    expect(types()).not.toContain('escalation.resolved');
    const raised = store.query({ typePrefix: 'escalation.raised' }).at(-1)?.raw.data;
    expect(raised).toMatchObject({
      category: 'decision',
      proposedDecision: {
        decisionId: r.decisionId,
        topic: 'db',
        decision: 'postgres',
        scope: 'repo',
      },
    });
  });

  it('accepts one handoff per session and fills defaults, ignoring a worker-supplied id', async () => {
    const b = make();
    const packet = {
      id: 'not-a-ulid',
      goal: 'G',
      acceptanceCriteria: [],
      stateSummary: 's',
      nextAction: 'n',
      verification: { status: 'not_run' },
    };
    expect((await b.requestHandoff(W1, { reason: 'r', packet })).accepted).toBe(true);
    await expect(b.requestHandoff(W1, { reason: 'r', packet })).rejects.toThrow(/already accepted/);
    // The next session may hand off again.
    await expect(
      b.requestHandoff({ workerSessionId: 'w-2', taskId: 'task-1' }, { reason: 'r', packet }),
    ).resolves.toMatchObject({ accepted: true });
  });

  it('records a gate failure with the escalation, and drops a late gate answer (#25)', async () => {
    const failing = make({ gate: async () => Promise.reject(new Error('gate down')) });
    await failing.escalate(W1, { question: 'q', urgency: 'low' });
    expect(store.query({ typePrefix: 'escalation.gate_failed' })[0]?.raw.data).toMatchObject({
      message: 'gate down',
    });
    let release: (v: { answer: string; source: 'mini' }) => void = () => {};
    const late = make({
      gate: () =>
        new Promise((r) => {
          release = r;
        }),
      gateTimeoutMs: 10,
    });
    const esc = await late.escalate(W1, { question: 'q2', urgency: 'low' });
    expect(esc.status).toBe('pending');
    // Written as pending once the time is up: the user can see it and answer it.
    expect(
      store
        .query({ typePrefix: 'escalation.raised' })
        .some((e) => (e.envelope.data as { id: string }).id === esc.escalationId),
    ).toBe(true);
    release({ answer: 'later', source: 'mini' });
    await new Promise((r) => setImmediate(r));
    expect(await late.getDecision(W1, { escalationId: esc.escalationId })).toEqual({
      status: 'pending',
    });
    expect(store.query({ typePrefix: 'decision.recorded' })).toEqual([]);

    let fail: (err: Error) => void = () => {};
    const lateFailure = make({
      gate: () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
      gateTimeoutMs: 10,
    });
    const third = await lateFailure.escalate(W1, { question: 'q3', urgency: 'low' });
    fail(new Error('too late'));
    await new Promise((r) => setImmediate(r));
    expect(
      store
        .query({ typePrefix: 'escalation.gate_failed' })
        .map((e) => e.envelope.data as { escalationId: string; message: string }),
    ).toContainEqual({ escalationId: third.escalationId, message: 'too late' });
  });

  it("writes the escalation and the gate's answer in one append (#25, ADR-003 addendum item 2)", async () => {
    let seen: string[] = [];
    const b = make({
      gate: async () => {
        // The user never sees a question the gate is still working on.
        seen = types();
        return { answer: 'use sqlite', source: 'precedent' as const, rationale: 'asked before' };
      },
    });
    const r = await b.escalate(W1, { question: 'db?', urgency: 'normal' });
    expect(seen).not.toContain('escalation.raised');
    const written = store.query({}).slice(1);
    expect(written.map((e) => e.envelope.type)).toEqual([
      'escalation.raised',
      'decision.recorded',
      'escalation.resolved',
      'escalation.delivered',
    ]);
    const [, decision, resolved, delivered] = written.map((e) => e.envelope.data);
    expect(decision).toMatchObject({
      escalationId: r.escalationId,
      taskId: 'task-1',
      topic: 'db?',
      decision: 'use sqlite',
      rationale: 'asked before',
      scope: 'task',
      source: 'precedent',
    });
    expect(resolved).toEqual({
      escalationId: r.escalationId,
      answer: 'use sqlite',
      source: 'precedent',
      decisionId: (decision as { id: string }).id,
      rationale: 'asked before',
    });
    expect(delivered).toMatchObject({ escalationId: r.escalationId, inline: true });
  });

  it('never gates a blocking question, and never takes a gate answer as the user (#25)', async () => {
    let calls = 0;
    const blocking = await make({
      gate: async () => {
        calls++;
        return { answer: 'x', source: 'precedent' as const };
      },
    }).escalate(W1, { question: 'stop?', urgency: 'blocking' });
    expect(blocking.status).toBe('pending');
    expect(calls).toBe(0);

    const asUser = await make({
      // biome-ignore lint/suspicious/noExplicitAny: a misbehaving gate, which the types forbid.
      gate: async () => ({ answer: 'x', source: 'user' }) as any,
    }).escalate(W1, { question: 'who?', urgency: 'low' });
    expect(asUser.status).toBe('pending');
    expect(store.query({ typePrefix: 'escalation.resolved' })).toEqual([]);
  });

  it("shares task decisions across a root task's sub-tasks, not across root tasks (#25)", async () => {
    const created = (id: string, parentId?: string) =>
      store.append({
        v: 1,
        id: newUlid(),
        ts: NOW,
        source: { kind: 'mini', id: 'mini' },
        taskId: id,
        type: 'task.created',
        data: {
          id,
          goal: 'G',
          acceptanceCriteria: ['A'],
          createdAt: NOW,
          ...(parentId ? { parentId } : {}),
        },
      });
    created('task-1.a', 'task-1');
    created('task-1.b', 'task-1');
    created('task-2');
    const b = make();
    await b.recordDecision(
      { workerSessionId: 'w-a', taskId: 'task-1.a' },
      { topic: 'logging library', decision: 'pino', scope: 'task' },
    );
    const sibling = await b.searchDecisions(
      { workerSessionId: 'w-b', taskId: 'task-1.b' },
      { query: 'logging' },
    );
    expect(sibling.decisions.map((d) => d.decision)).toEqual(['pino']);
    const other = await b.searchDecisions(
      { workerSessionId: 'w-2', taskId: 'task-2' },
      { query: 'logging' },
    );
    expect(other.decisions).toEqual([]);
  });

  it('never lets a late gate answer resolve what the user has answered (#25)', async () => {
    let release: (v: { answer: string; source: 'mini' }) => void = () => {};
    const late = make({
      gate: () =>
        new Promise((r) => {
          release = r;
        }),
      gateTimeoutMs: 10,
    });
    const esc = await late.escalate(W1, { question: 'q3', urgency: 'low' });
    // The user answers while the gate is still at work.
    store.append({
      v: 1,
      id: newUlid(),
      ts: NOW,
      source: { kind: 'mini', id: 'mini' },
      taskId: 'task-1',
      type: 'escalation.resolved',
      data: { escalationId: esc.escalationId, answer: 'mine', source: 'user' },
    });
    release({ answer: 'the gate', source: 'mini' });
    await new Promise((r) => setImmediate(r));
    const answers = store
      .query({ typePrefix: 'escalation.resolved' })
      .map((e) => (e.envelope.data as { answer: string }).answer);
    expect(answers).toEqual(['mine']);
  });

  it('asks to approve or reject a repo-wide proposal (#25)', async () => {
    const r = await make().recordDecision(W1, { topic: 'db', decision: 'postgres', scope: 'repo' });
    const raised = store.query({ typePrefix: 'escalation.raised' }).at(-1)?.envelope.data;
    expect(raised).toMatchObject({
      id: r.escalationId,
      category: 'decision',
      options: ['approve', 'reject'],
      proposedDecision: { decisionId: r.decisionId, scope: 'repo' },
    });
  });

  it('writes escalations as escalationStats counts them (#25)', async () => {
    await make({ gate: async () => ({ answer: 'a', source: 'precedent' as const }) }).escalate(W1, {
      question: 'answered by precedent',
      urgency: 'low',
    });
    await make().escalate(W1, { question: 'left to the user', urgency: 'low' });
    await make().recordDecision(W1, { topic: 'db', decision: 'postgres', scope: 'repo' });
    expect(escalationStats(store.query({}).map((e) => e.envelope))).toMatchObject({
      raised: 2,
      resolvedLocally: { precedent: 1 },
      open: 1,
      rate: 0.5,
      approvals: 1,
      raisedByMini: 0,
    });
  });
});
