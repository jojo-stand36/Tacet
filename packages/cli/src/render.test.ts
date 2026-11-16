import type { EventEnvelope } from '@tacet/core';
import { describe, expect, it } from 'vitest';
import { formatEvent, isSummaryEvent, oneLine, terminalSafe } from './render.js';

describe('render (#21)', () => {
  it('replaces control characters and bidi overrides, keeping newlines and tabs', () => {
    expect(terminalSafe('a\x1b]52;c;eA==\x07b\x1b[2Jc\u009bd‮e\tf\ng\rh\x00')).toBe(
      'a?]52;c;eA==?b?[2Jc?d?e\tf\ng?h?',
    );
  });

  it('keeps transcript events out of the summary, but usage in', () => {
    expect(isSummaryEvent('task.status')).toBe(true);
    expect(isSummaryEvent('agent.usage')).toBe(true);
    expect(isSummaryEvent('agent.message.delta')).toBe(false);
    expect(oneLine('a\n b   c', 4)).toBe('a...');
  });

  it('formats a Worker message safely', () => {
    const e = {
      v: 1,
      id: '01JCX6000000000000000000ZZ',
      ts: '2026-11-10T12:34:56.000Z',
      source: { kind: 'mini', id: 'm' },
      taskId: 't/1',
      type: 'agent.message.delta',
      data: { t: 'message.delta', text: 'hi\x1b[31m\nthere' },
    } as EventEnvelope;
    expect(formatEvent(e)).toBe('12:34:56 t/1 says:\n  hi?[31m\n  there');
  });

  it('says what a budget event means (#35)', () => {
    const at = (type: string, data: unknown) =>
      formatEvent({
        v: 1,
        id: '01JCX6000000000000000000ZZ',
        ts: '2026-11-10T12:34:56.000Z',
        source: { kind: 'mini', id: 'm' },
        taskId: 't',
        type,
        data,
      } as EventEnvelope);
    expect(
      at('budget.threshold', { scope: 'task', key: 't', thresholdUsd: 1, spentUsd: 1.5 }),
    ).toBe(
      '12:34:56 t budget: spent $1.50, past the $1.00 you asked to hear about (nothing stops)',
    );
    expect(at('budget.exceeded', { scope: 'day', key: 'd', capUsd: 2, spentUsd: 2.1 })).toMatch(
      /the day cap \$2\.00 is spent \(\$2\.10\); Workers stopped/,
    );
    expect(at('budget.raised', { scope: 'task', key: 't', capUsd: 5 })).toMatch(
      /raised to \$5\.00/,
    );
    expect(at('budget.unpriced', { model: 'm', allowed: false })).toMatch(
      /m has no known price: refused/,
    );
  });
});
