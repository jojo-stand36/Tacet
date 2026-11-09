import { describe, expect, it } from 'vitest';
import { blockedByFailure, pickReady, type SchedulableSubtask } from './scheduler.js';

const s = (id: string, over: Partial<SchedulableSubtask> = {}): SchedulableSubtask => ({
  id,
  dependsOn: [],
  phase: 'pending',
  priority: 'p2',
  adapter: 'claude-sdk',
  order: 0,
  ...over,
});

describe('pickReady', () => {
  it('starts only sub-tasks whose dependencies are done', () => {
    const plan = [
      s('a', { phase: 'done' }),
      s('b', { dependsOn: ['a'], order: 1 }),
      s('c', { dependsOn: ['b'], order: 2 }),
      s('d', { dependsOn: ['a', 'x'], order: 3 }),
    ];
    expect(pickReady(plan, [], { max: 4 })).toEqual(['b']);
  });

  it('orders by priority, then plan order', () => {
    const plan = [s('a', { order: 0 }), s('b', { priority: 'p0', order: 5 }), s('c', { order: 1 })];
    expect(pickReady(plan, [], { max: 2 })).toEqual(['b', 'a']);
  });

  it('counts every running Worker against the repo-wide cap', () => {
    const plan = [s('a'), s('b', { order: 1 })];
    expect(pickReady(plan, [{ adapter: 'x' }, { adapter: 'y' }], { max: 3 })).toEqual(['a']);
    expect(
      pickReady(plan, [{ adapter: 'x' }, { adapter: 'y' }, { adapter: 'z' }], { max: 3 }),
    ).toEqual([]);
  });

  it('applies per-adapter caps without blocking other adapters', () => {
    const plan = [
      s('a', { adapter: 'codex-app-server' }),
      s('b', { adapter: 'codex-app-server', order: 1 }),
      s('c', { adapter: 'claude-sdk', order: 2 }),
    ];
    expect(
      pickReady(plan, [{ adapter: 'codex-app-server' }], {
        max: 4,
        perAdapter: { 'codex-app-server': 2 },
      }),
    ).toEqual(['a', 'c']);
  });

  it('never starts running, blocked, failed or done sub-tasks', () => {
    const plan = (['running', 'blocked', 'failed', 'done'] as const).map((phase, i) =>
      s(`t${i}`, { phase }),
    );
    expect(pickReady(plan, [], { max: 10 })).toEqual([]);
  });
});

describe('blockedByFailure', () => {
  it('finds pending sub-tasks downstream of a failure, transitively', () => {
    const plan = [
      s('a', { phase: 'failed' }),
      s('b', { dependsOn: ['a'] }),
      s('c', { dependsOn: ['b'] }),
      s('d'),
    ];
    expect(blockedByFailure(plan)).toEqual(['b', 'c']);
  });
});
