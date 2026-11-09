import { newUlid } from '@tacet/core';
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
});
