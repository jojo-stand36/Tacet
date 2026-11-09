import { describe, expect, it } from 'vitest';
import { project, tasksProjection } from '../events/projection.js';
import type { EventEnvelope } from './envelope.js';
import { planIssues, TaskPlan } from './plan.js';
import { SummaryPacket } from './summary.js';
import { WorkerEnded, WorkerStarted } from './worker.js';

const st = (id: string, dependsOn: string[] = []) => ({
  id,
  goal: `goal ${id}`,
  acceptanceCriteria: [`done ${id}`],
  dependsOn,
});

describe('TaskPlan', () => {
  it('accepts a dependency DAG and fills defaults', () => {
    const plan = TaskPlan.parse({ subtasks: [st('a'), st('b', ['a']), st('c', ['a', 'b'])] });
    expect(plan.subtasks[0]).toMatchObject({ kind: 'implement', dependsOn: [] });
  });

  it('rejects duplicate ids, unknown and self dependencies, and cycles', () => {
    expect(planIssues([st('a'), st('a')])).toEqual(['duplicate sub-task id a']);
    expect(planIssues([st('a', ['zz'])])).toEqual(['sub-task a depends on unknown zz']);
    expect(planIssues([st('a', ['a'])])).toEqual(['sub-task a depends on itself']);
    expect(planIssues([st('a', ['c']), st('b', ['a']), st('c', ['b']), st('d')])).toEqual([
      'dependency cycle among a, b, c',
    ]);
    expect(TaskPlan.safeParse({ subtasks: [st('a', ['b']), st('b', ['a'])] }).success).toBe(false);
    expect(TaskPlan.safeParse({ subtasks: [] }).success).toBe(false);
  });

  it('reads an unknown sub-task kind as implement', () => {
    const plan = TaskPlan.parse({ subtasks: [{ ...st('a'), kind: 'deploy' }] });
    expect(plan.subtasks[0]?.kind).toBe('implement');
  });
});

describe('worker and summary payloads', () => {
  it('reads an unknown end reason or outcome as failed, never as success', () => {
    expect(WorkerEnded.parse({ sessionId: 's', reason: 'vanished' }).reason).toBe('failed');
    expect(WorkerEnded.parse({ sessionId: 's' }).reason).toBeUndefined();
    const summary = SummaryPacket.parse({
      v: 1,
      taskId: 't',
      createdAt: '2026-11-09T12:00:00.000Z',
      outcome: 'shipped',
      summary: 's',
      verification: { status: 'passed' },
    });
    expect(summary.outcome).toBe('failed');
    expect(summary).toMatchObject({ filesTouched: [], commits: [], openQuestions: [] });
  });

  it('still accepts a worker.started written before the new fields existed', () => {
    expect(WorkerStarted.parse({ sessionId: 's' })).toEqual({ sessionId: 's' });
  });

  it('rejects a short commit id in a summary', () => {
    const bad = {
      v: 1,
      taskId: 't',
      createdAt: '2026-11-09T12:00:00.000Z',
      outcome: 'completed',
      summary: 's',
      commits: ['4b825dc'],
      verification: { status: 'passed' },
    };
    expect(SummaryPacket.safeParse(bad).success).toBe(false);
  });
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

  it('records the plan, worker lifecycle and result of a task', () => {
    const state = project(tasksProjection, [
      ev('task.created', 'p', task('p')),
      ev('task.planned', 'p', { subtasks: [st('p.1'), st('p.2', ['p.1'])] }),
      ev('task.created', 'p.1', task('p.1', 'p')),
      ev('worker.started', 'p.1', { sessionId: 'w1', adapter: 'claude-sdk', attempt: 1 }),
      ev('worker.ended', 'p.1', { sessionId: 'w1', reason: 'completed' }),
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
