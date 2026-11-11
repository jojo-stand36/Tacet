import { NO_ESCALATIONS } from '@tacet/core';
import { describe, expect, it } from 'vitest';
import { formatEscalationStats } from './commands/read.js';

describe('the escalation line of tacet status (#25)', () => {
  const stats = (more: Partial<typeof NO_ESCALATIONS>) => ({ ...NO_ESCALATIONS, ...more });
  it('says what was answered without the user, what reached them and what is open', () => {
    expect(formatEscalationStats(NO_ESCALATIONS)).toBe('none');
    expect(
      formatEscalationStats(
        stats({
          raised: 4,
          resolvedLocally: { policy: 0, precedent: 2, mini: 1 },
          answeredByUser: 0,
          open: 1,
          rate: 0.25,
          approvals: 2,
          raisedByMini: 3,
        }),
      ),
    ).toBe(
      '4 from Workers, 3 answered without you (precedent 2, Mini-conductor 1), 1 to you (25%; 1 still open), 2 proposals to approve, 3 from the Mini-conductor',
    );
    expect(formatEscalationStats(stats({ raisedByMini: 1 }))).toBe(
      '0 from Workers, 1 from the Mini-conductor',
    );
  });
});
