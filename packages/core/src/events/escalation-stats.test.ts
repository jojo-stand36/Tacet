import { describe, expect, it } from 'vitest';
import type { EventEnvelope } from '../schema/envelope.js';
import { escalationStats } from './escalation-stats.js';

let n = 0;
const ev = (
  type: string,
  data: Record<string, unknown>,
  kind: 'worker' | 'mini' = 'mini',
  ts = '2026-11-11T12:00:00.000Z',
): EventEnvelope => ({
  v: 1,
  id: `01J0000000000000000000${String(++n).padStart(4, '0')}`,
  ts,
  source: { kind, id: kind === 'worker' ? 'w-1' : 'standalone' },
  taskId: 't1/1',
  type,
  data,
});
const raise = (id: string, kind: 'worker' | 'mini' = 'worker', ts?: string) =>
  ev('escalation.raised', { id, question: 'q' }, kind, ts);
const resolve = (escalationId: string, source?: string) =>
  ev('escalation.resolved', { escalationId, answer: 'a', ...(source ? { source } : {}) });

describe('escalationStats (#25)', () => {
  it('counts what the gate answered, what the user answered, and what waits', () => {
    const s = escalationStats([
      raise('e1'),
      resolve('e1', 'precedent'),
      raise('e2'),
      resolve('e2', 'user'),
      raise('e3'),
      resolve('e3', 'policy'),
      raise('e4'),
      raise('e5'),
      resolve('e5', 'mini'),
      // An older log: answered, with no source.
      raise('e6'),
      resolve('e6'),
      // The Mini-conductor's own: counted apart.
      raise('m1', 'mini'),
      resolve('m1', 'user'),
      // A second answer to the same escalation changes nothing.
      resolve('e2', 'mini'),
    ]);
    expect(s).toEqual({
      raised: 6,
      resolvedLocally: { policy: 1, precedent: 1, mini: 1 },
      answeredByUser: 1,
      answeredUnknown: 1,
      open: 1,
      rate: 0.5,
      raisedByMini: 1,
    });
  });

  it('counts only escalations raised since a time, and has no rate without any', () => {
    expect(escalationStats([]).rate).toBeUndefined();
    const s = escalationStats(
      [raise('old', 'worker', '2026-11-01T00:00:00.000Z'), raise('new'), resolve('old', 'user')],
      { since: '2026-11-04T00:00:00.000Z' },
    );
    expect(s).toMatchObject({ raised: 1, open: 1, answeredByUser: 0, rate: 1 });
  });
});
