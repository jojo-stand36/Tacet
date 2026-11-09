import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
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
  it('accepts a dependency DAG, diamonds included, and fills defaults', () => {
    expect(planIssues([st('a'), st('b', ['a']), st('c', ['a']), st('d', ['b', 'c'])])).toEqual([]);
    const plan = TaskPlan.parse({ subtasks: [st('a'), st('b', ['a']), st('c', ['a', 'b'])] });
    expect(plan.subtasks[0]).toMatchObject({ kind: 'implement', dependsOn: [] });
  });

  it('rejects duplicate ids, unknown and self dependencies, and cycles', () => {
    expect(planIssues([st('a'), st('a')])).toEqual(['duplicate sub-task id a']);
    expect(planIssues([st('a', ['zz'])])).toEqual(['sub-task a depends on unknown zz']);
    expect(planIssues([st('a', ['a'])])).toEqual(['sub-task a depends on itself']);
    expect(planIssues([st('a', ['c']), st('b', ['a']), st('c', ['b']), st('d')])).toEqual([
      'sub-tasks cannot be ordered (dependency cycle): a, b, c',
    ]);
    expect(planIssues([st('a'), st('b', ['a', 'a'])])).toEqual([
      'sub-task b lists dependency a twice',
    ]);
    expect(TaskPlan.safeParse({ subtasks: [st('a', ['b']), st('b', ['a'])] }).success).toBe(false);
    expect(TaskPlan.safeParse({ subtasks: [] }).success).toBe(false);
  });

  it('reads an unknown sub-task kind as explore, the read-only kind', () => {
    const plan = TaskPlan.parse({ subtasks: [{ ...st('a'), kind: 'deploy' }] });
    expect(plan.subtasks[0]?.kind).toBe('explore');
  });

  it('lists its invariants in the JSON Schema, which alone accepts a cyclic plan', () => {
    const schema = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', '..', 'schema', 'v1', 'task-plan.json'), 'utf8'),
    ) as { 'x-tacet-invariants': string[] };
    expect(schema['x-tacet-invariants']).toContain('the dependency graph has no cycles');
    const cyclic = { subtasks: [st('a', ['b']), st('b', ['a'])] };
    expect(new Ajv2020({ strict: false }).validate(schema, cyclic)).toBe(true);
    expect(TaskPlan.safeParse(cyclic).success).toBe(false);
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

  it('rejects an absolute path in filesTouched', () => {
    const bad = {
      v: 1,
      taskId: 't',
      createdAt: '2026-11-09T12:00:00.000Z',
      outcome: 'completed',
      summary: 's',
      filesTouched: ['/home/u/.tacet/worktrees/x/src/a.ts'],
      verification: { status: 'passed' },
    };
    expect(SummaryPacket.safeParse(bad).success).toBe(false);
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
