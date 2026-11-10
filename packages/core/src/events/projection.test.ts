import { describe, expect, it } from 'vitest';
import type { EventEnvelope } from '../schema/envelope.js';
import { project, tasksProjection, workspacesProjection } from './projection.js';

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

describe('workspaces projection (#126)', () => {
  const commit = 'a'.repeat(40);
  const ws = (n: number, type: string, data: unknown): EventEnvelope => ({
    v: 1,
    id: `01J00000000000000000000${String(n).padStart(3, '0')}`,
    ts: `2026-11-10T12:00:0${n}.000Z`,
    source: { kind: 'mini', id: 'mini' },
    type,
    data,
  });
  const events = [
    ws(1, 'workspace.created', {
      workspaceId: 'w-1',
      workerId: 's-1',
      baseCommit: commit,
      baseBranch: 'main',
      extra: 1,
    }),
    ws(2, 'workspace.created', {
      workspaceId: 'w-2',
      workerId: 's-2',
      baseCommit: commit,
      migrated: true,
    }),
    ws(3, 'workspace.removed', { workspaceId: 'w-1', reason: 'gone' }),
    // A late duplicate never brings a removed workspace back; malformed ones are skipped.
    ws(4, 'workspace.created', { workspaceId: 'w-1', workerId: 's-1', baseCommit: commit }),
    ws(5, 'workspace.created', { workspaceId: 'w-3', workerId: 's-3', baseCommit: 'nope' }),
    ws(6, 'workspace.removed', { workspaceId: 'w-2', reason: 'something new' }),
    ws(7, 'workspace.created', { workspaceId: 'w-4', workerId: 's-4', baseCommit: commit }),
  ];

  it('keeps the created and not removed, deterministically', () => {
    const state = project(workspacesProjection, events);
    expect(state).toEqual(project(workspacesProjection, events));
    expect(state.live).toEqual({
      'w-4': {
        workspaceId: 'w-4',
        workerId: 's-4',
        baseCommit: commit,
        createdAt: '2026-11-10T12:00:07.000Z',
      },
    });
    expect(Object.keys(state.removed).sort()).toEqual(['w-1', 'w-2']);
  });

  it('records the base, branch and migration of a live workspace, never a path', () => {
    const state = project(workspacesProjection, events.slice(0, 2));
    expect(state.live['w-1']).toEqual({
      workspaceId: 'w-1',
      workerId: 's-1',
      baseCommit: commit,
      baseBranch: 'main',
      createdAt: '2026-11-10T12:00:01.000Z',
    });
    expect(state.live['w-2']?.migrated).toBe(true);
  });
});
