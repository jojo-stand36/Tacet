import { type Escalation, newUlid } from '@tacet/core';
import { type EventStore, openEventStore, type WorkerBinding } from '@tacet/core/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventLogBackend } from '../mcp/backend.js';
import {
  alwaysAskMatch,
  deterministicGate,
  findPrecedent,
  normalizeQuestion,
  precedentKey,
  rootTasks,
} from './gate.js';

const NOW = '2026-11-12T12:00:00.000Z';

describe('normalizeQuestion and precedentKey', () => {
  it('folds case, width and punctuation, and collapses space', () => {
    expect(normalizeQuestion('  Use  ＰｏｓｔｇｒｅＳＱＬ — or SQLite?! ')).toBe(
      'use postgresql or sqlite',
    );
    expect(precedentKey('Which DB?', ['SQLite', 'Postgres'])).toBe(
      precedentKey('which db', ['postgres', 'sqlite']),
    );
    expect(precedentKey('Which DB?', ['a'])).not.toBe(precedentKey('Which DB?', ['a', 'b']));
    expect(precedentKey('Which DB?')).not.toBe(precedentKey('Which cache?'));
    // Symbols change what a question asks.
    expect(precedentKey('Pin x >= 2?')).not.toBe(precedentKey('Pin x <= 2?'));
    expect(precedentKey('Use a+b?')).not.toBe(precedentKey('Use a b?'));
  });
});

describe('alwaysAskMatch', () => {
  const q = (question: string, context?: string, options?: string[]) => ({
    question,
    ...(context !== undefined ? { context } : {}),
    ...(options ? { options } : {}),
  });
  it('matches when every word of an entry appears, filler words dropped', () => {
    const entries = ['anything touching auth', 'database migrations', 'deploy to prod'];
    expect(alwaysAskMatch(entries, q('Change the auth flow?'))).toBe('anything touching auth');
    expect(alwaysAskMatch(entries, q('Run the migrations?', 'on the database'))).toBe(
      'database migrations',
    );
    expect(alwaysAskMatch(entries, q('Where?', undefined, ['deploy prod', 'staging']))).toBe(
      'deploy to prod',
    );
    // Whole words only, and every one of them.
    expect(alwaysAskMatch(entries, q('Change the author list?'))).toBeUndefined();
    expect(alwaysAskMatch(entries, q('Add a database index?'))).toBeUndefined();
    // Paths and dotted names stay one word.
    expect(alwaysAskMatch(['src/auth.ts'], q('Edit src/auth.ts?'))).toBe('src/auth.ts');
    expect(alwaysAskMatch(['src/auth.ts'], q('Edit src/auth?'))).toBeUndefined();
  });
  it('matches a word that ends a sentence, and paths under a path entry', () => {
    expect(alwaysAskMatch(['deploy to prod'], q('Can I deploy to prod.'))).toBe('deploy to prod');
    expect(alwaysAskMatch(['schema migrations'], q('Run the schema migrations.'))).toBe(
      'schema migrations',
    );
    expect(alwaysAskMatch(['auth'], q('Should I refactor the auth...'))).toBe('auth');
    // ARCHITECTURE §4's example: a path entry covers what is under it, and only that.
    expect(alwaysAskMatch(['anything touching /infra'], q('Edit /infra/main.tf?'))).toBe(
      'anything touching /infra',
    );
    expect(alwaysAskMatch(['/infra'], q('Edit /infrastructure/main.tf?'))).toBeUndefined();
    expect(alwaysAskMatch(['/infra/'], q('Edit /infra/x?'))).toBe('/infra/');
  });
  it('never matches with an entry of filler words alone', () => {
    expect(alwaysAskMatch(['anything', 'the and or'], q('the question'))).toBeUndefined();
  });
});

describe('the deterministic gate', () => {
  let store: EventStore;
  beforeEach(() => {
    store = openEventStore(':memory:');
    created('root-1');
    created('root-1.a', 'root-1');
    created('root-1.b', 'root-1');
    created('root-1.a.x', 'root-1.a');
    created('root-2');
  });
  afterEach(() => store.close());

  function append(taskId: string, type: string, data: unknown, kind: 'mini' | 'worker' = 'mini') {
    store.append({
      v: 1,
      id: newUlid(),
      ts: NOW,
      source: { kind, id: kind === 'mini' ? 'mini' : 'w' },
      taskId,
      type,
      data,
    });
  }
  function created(id: string, parentId?: string) {
    append(id, 'task.created', {
      id,
      goal: 'G',
      acceptanceCriteria: ['A'],
      createdAt: NOW,
      ...(parentId ? { parentId } : {}),
    });
  }
  function escalation(taskId: string, over: Partial<Escalation> = {}): Escalation {
    return {
      id: newUlid(),
      taskId,
      sessionId: 'w',
      question: 'Which database?',
      urgency: 'normal',
      blockedWorkers: 0,
      status: 'pending',
      createdAt: NOW,
      reescalations: 0,
      ...over,
    };
  }
  /** An escalation raised on `taskId` and answered by `source`, as the daemon records it. */
  function answered(
    taskId: string,
    decision: string,
    over: Partial<Escalation> = {},
    d: { source?: string; scope?: string; supersedes?: string } = {},
  ): { escalation: Escalation; decisionId: string } {
    const x = escalation(taskId, over);
    append(taskId, 'escalation.raised', x, 'worker');
    const decisionId = newUlid();
    append(taskId, 'decision.recorded', {
      id: decisionId,
      escalationId: x.id,
      taskId,
      topic: x.question,
      decision,
      scope: d.scope ?? 'task',
      source: d.source ?? 'user',
      decidedAt: NOW,
      ...(d.supersedes ? { supersedes: d.supersedes } : {}),
    });
    append(taskId, 'escalation.resolved', {
      escalationId: x.id,
      answer: decision,
      source: d.source ?? 'user',
      decisionId,
    });
    return { escalation: x, decisionId };
  }
  const gate = (alwaysAsk: string[] = []) => deterministicGate({ store, alwaysAsk });
  const binding = (taskId: string): WorkerBinding => ({ workerSessionId: 'w', taskId });

  it('walks parentId to the root task', () => {
    const rootOf = rootTasks(store);
    expect(rootOf('root-1.a.x')).toBe('root-1');
    expect(rootOf('root-1')).toBe('root-1');
    expect(rootOf('unknown')).toBe('unknown');
  });

  it("answers with the user's own exact precedent, within the same root task", async () => {
    const { decisionId } = answered('root-1.a', 'Postgres');
    const r = await gate()(escalation('root-1.b', { question: 'which  DATABASE' }), binding('x'));
    expect(r).toMatchObject({ answer: 'Postgres', source: 'precedent' });
    expect(r?.rationale).toContain(decisionId);
    // Another root task does not share task-scope precedent.
    expect(await gate()(escalation('root-2'), binding('x'))).toBeUndefined();
  });

  it('applies repo-scope precedent from any task, and the newest first', async () => {
    answered('root-1', 'MySQL', {}, { scope: 'repo' });
    answered('root-1', 'Postgres', {}, { scope: 'repo' });
    expect(await gate()(escalation('root-2'), binding('x'))).toMatchObject({ answer: 'Postgres' });
  });

  it('never uses a Decision that is not the user’s, or one that was superseded', async () => {
    for (const source of ['worker', 'mini', 'policy', 'precedent']) {
      answered('root-1', `by ${source}`, {}, { source, scope: 'repo' });
    }
    expect(await gate()(escalation('root-1'), binding('x'))).toBeUndefined();
    const old = answered('root-1', 'Postgres', {}, { scope: 'repo' });
    append('root-1', 'decision.recorded', {
      id: newUlid(),
      taskId: 'root-1',
      topic: 'db',
      decision: 'ask me again',
      scope: 'repo',
      source: 'user',
      decidedAt: NOW,
      supersedes: old.decisionId,
    });
    expect(await gate()(escalation('root-1'), binding('x'))).toBeUndefined();
  });

  it('needs the same options, and an answer that is one of them', async () => {
    answered('root-1', 'postgres', { options: ['Postgres', 'SQLite'] });
    // Same options in another order and case: the answer is spelled as the new question has it.
    expect(
      await gate()(escalation('root-1', { options: ['sqlite', 'POSTGRES'] }), binding('x')),
    ).toMatchObject({ answer: 'POSTGRES' });
    expect(
      await gate()(
        escalation('root-1', { options: ['Postgres', 'SQLite', 'MySQL'] }),
        binding('x'),
      ),
    ).toBeUndefined();
    expect(await gate()(escalation('root-1'), binding('x'))).toBeUndefined();
    // A free-text answer to a question with no options never answers one that has options.
    answered('root-2', 'whatever you like');
    expect(
      await gate()(escalation('root-2', { options: ['a', 'b'] }), binding('x')),
    ).toBeUndefined();
  });

  it('ignores the context when matching', async () => {
    answered('root-1', 'Postgres', { context: 'for the API' });
    expect(
      await gate()(escalation('root-1', { context: 'for the batch jobs' }), binding('x')),
    ).toMatchObject({ answer: 'Postgres' });
  });

  it('never answers blocking questions, approvals, or always_ask matches', async () => {
    answered('root-1', 'Postgres', {}, { scope: 'repo' });
    expect(
      await gate()(escalation('root-1', { urgency: 'blocking' }), binding('x')),
    ).toBeUndefined();
    expect(await gate(['database'])(escalation('root-1'), binding('x'))).toBeUndefined();
    expect(
      await gate()(
        escalation('root-1', { category: 'decision', options: ['approve', 'reject'] }),
        binding('x'),
      ),
    ).toBeUndefined();
    // High urgency is answered by an exact precedent (ADR-004 B).
    expect(await gate()(escalation('root-1', { urgency: 'high' }), binding('x'))).toMatchObject({
      answer: 'Postgres',
    });
  });

  it("never takes the user's answer to the Mini-conductor's own escalation as precedent", async () => {
    // A blocked Worker or a merge conflict: raised by the Mini-conductor, with a category.
    answered('root-1', 'go on', { category: 'blocked' }, { scope: 'repo' });
    // Nor the answer to a policy `ask` about a Worker's tool request (#25 PR4).
    answered('root-1', 'use lib/', { category: 'help', question: 'Edit src?' }, { scope: 'repo' });
    expect(findPrecedent(store, escalation('root-1', { question: 'Edit src?' }))).toBeUndefined();
    const { sessionId: _none, ...mine } = escalation('root-1', { question: 'Unblock?' });
    append('root-1', 'escalation.raised', mine);
    const decisionId = newUlid();
    append('root-1', 'decision.recorded', {
      id: decisionId,
      escalationId: mine.id,
      taskId: 'root-1',
      topic: mine.question,
      decision: 'go on',
      scope: 'repo',
      source: 'user',
      decidedAt: NOW,
    });
    expect(findPrecedent(store, escalation('root-1'))).toBeUndefined();
    expect(findPrecedent(store, escalation('root-1', { question: 'Unblock?' }))).toBeUndefined();
  });

  it("never takes another repo's Decision as precedent", async () => {
    const x = escalation('root-1');
    append('root-1', 'escalation.raised', x, 'worker');
    append('root-1', 'decision.recorded', {
      id: newUlid(),
      escalationId: x.id,
      taskId: 'root-1',
      repo: 'other-repo',
      topic: x.question,
      decision: 'Postgres',
      scope: 'repo',
      source: 'user',
      decidedAt: NOW,
    });
    expect(findPrecedent(store, escalation('root-2'), 'this-repo')).toBeUndefined();
    expect(findPrecedent(store, escalation('root-2'), 'other-repo')).toMatchObject({
      answer: 'Postgres',
    });
  });

  it('never takes the answer to an approval request as precedent', async () => {
    const question = 'Approve a repo-wide decision on "db": postgres';
    answered(
      'root-1',
      'reject',
      { question, options: ['approve', 'reject'], category: 'decision' },
      { scope: 'repo' },
    );
    expect(
      findPrecedent(store, escalation('root-1', { question, options: ['approve', 'reject'] })),
    ).toBeUndefined();
  });

  it('answers a Worker through the MCP backend with one write (#25)', async () => {
    answered('root-1.a', 'Postgres');
    const backend = new EventLogBackend({ store, gate: gate() });
    const r = await backend.escalate(binding('root-1.b'), {
      question: 'Which database?',
      urgency: 'normal',
    });
    expect(r).toMatchObject({ status: 'resolved', answer: 'Postgres', source: 'precedent' });
    const own = store
      .query({ typePrefix: 'decision.recorded' })
      .map((e) => e.envelope.data as { source: string; scope: string; taskId: string })
      .at(-1);
    // The gate's own Decision is the sub-task's, and never precedent itself.
    expect(own).toMatchObject({ source: 'precedent', scope: 'task', taskId: 'root-1.b' });
  });
});
