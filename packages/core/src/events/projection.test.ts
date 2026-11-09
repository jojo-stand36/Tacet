import { describe, expect, it } from 'vitest';
import type { EventEnvelope } from '../schema/envelope.js';
import { project, tasksProjection } from './projection.js';

const st = (id: string, dependsOn: string[] = []) => ({
  id,
  goal: `goal ${id}`,
  acceptanceCriteria: [`done ${id}`],
  dependsOn,
});

describe('tasks projection: plans and results', () => {
  let n = 0;
  const ev = (type: string, taskId: string, data: unknown): EventEnvelope => {
    n += 1;
    return {
      v: 1,
      id: `01J${String(n).padStart(23, '0')}`,
      ts: '2026-11-09T12:00:00.000Z',
      source: { kind: 'mini', id: 'mini' },
      taskId,
      type,
      data,
    } as EventEnvelope;
  };
  const task = (id: string, parentId?: string) => ({
    id,
    goal: `goal ${id}`,
    acceptanceCriteria: ['ok'],
    priority: 'p2',
    createdAt: '2026-11-09T12:00:00.000Z',
    ...(parentId ? { parentId } : {}),
  });

  it('applies an old worker.ended without a reason', () => {
    const state = project(tasksProjection, [
      ev('task.created', 'o', task('o')),
      ev('worker.started', 'o', { sessionId: 'w9' }),
      ev('worker.ended', 'o', { sessionId: 'w9' }),
    ]);
    expect(state.tasks.o?.activeWorkers).toEqual([]);
    expect(state.skipped).toEqual([]);
  });

  it('replaces the plan with a later full plan, and skips a plan for an unknown task', () => {
    const state = project(tasksProjection, [
      ev('task.planned', 'q', { subtasks: [st('q.1')] }),
      ev('task.created', 'q', task('q')),
      ev('task.planned', 'q', { subtasks: [st('q.1')] }),
      ev('task.planned', 'q', { subtasks: [st('q.1'), st('q.2', ['q.1'])] }),
    ]);
    expect(state.tasks.q?.plan).toEqual([
      { id: 'q.1', dependsOn: [] },
      { id: 'q.2', dependsOn: ['q.1'] },
    ]);
    expect(state.skipped).toHaveLength(1);
  });

  it('records the plan, worker lifecycle and result of a task', () => {
    const state = project(tasksProjection, [
      ev('task.created', 'p', task('p')),
      ev('task.planned', 'p', { subtasks: [st('p.1'), st('p.2', ['p.1'])] }),
      ev('task.created', 'p.1', task('p.1', 'p')),
      ev('worker.started', 'p.1', { sessionId: 'w1', adapter: 'claude-sdk', attempt: 1 }),
      ev('worker.ended', 'p.1', { sessionId: 'w1', reason: 'finished' }),
      ev('task.result', 'p.1', {
        v: 1,
        taskId: 'p.1',
        createdAt: '2026-11-09T12:00:00.000Z',
        outcome: 'completed',
        summary: 'done',
        verification: { status: 'passed' },
      }),
      // A result naming another task is not applied.
      ev('task.result', 'p', {
        v: 1,
        taskId: 'p.1',
        createdAt: '2026-11-09T12:00:00.000Z',
        outcome: 'completed',
        summary: 'x',
        verification: { status: 'passed' },
      }),
      ev('task.planned', 'p', { subtasks: [st('x', ['x'])] }),
    ]);
    expect(state.tasks.p?.plan).toEqual([
      { id: 'p.1', dependsOn: [] },
      { id: 'p.2', dependsOn: ['p.1'] },
    ]);
    expect(state.tasks['p.1']?.activeWorkers).toEqual([]);
    expect(state.tasks['p.1']?.result).toEqual({
      outcome: 'completed',
      createdAt: '2026-11-09T12:00:00.000Z',
    });
    expect(state.tasks.p?.result).toBeUndefined();
    // The invalid plan and the mismatched result are skipped, not applied.
    expect(state.skipped).toHaveLength(2);
  });
});
