import { describe, expect, it } from 'vitest';
import { mcpHeaderSecrets, scrubLiterals } from './redact.js';

describe('mcpHeaderSecrets / scrubLiterals', () => {
  it('collects header values and bare tokens, longest first, and scrubs them everywhere', () => {
    const secrets = mcpHeaderSecrets([
      {
        name: 'a',
        url: 'http://x',
        headers: { authorization: 'Bearer tokenAAAA1111', h: 'short' },
      },
    ]);
    expect(secrets).toEqual(['Bearer tokenAAAA1111', 'tokenAAAA1111']);
    expect(
      scrubLiterals({ a: ['x Bearer tokenAAAA1111 y', 'tokenAAAA1111'], n: 1 }, secrets),
    ).toEqual({ a: ['x [redacted] y', '[redacted]'], n: 1 });
    expect(scrubLiterals('plain', [])).toBe('plain');
    expect(mcpHeaderSecrets(undefined)).toEqual([]);
  });
});
