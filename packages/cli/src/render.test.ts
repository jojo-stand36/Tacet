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
});
