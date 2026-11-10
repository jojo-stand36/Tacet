import { describe, expect, it } from 'vitest';
import { DeltaScrubber, mcpHeaderSecrets, scrubLiterals } from './redact.js';

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

  describe('DeltaScrubber (#109)', () => {
    const TOKEN = 'tok3nAAAA1111zzzz';
    const secrets = mcpHeaderSecrets([
      { name: 'a', url: 'http://x', headers: { authorization: `Bearer ${TOKEN}` } },
    ]);
    const text = `before ${TOKEN} after, and Bearer ${TOKEN} again.`;
    const expected = scrubLiterals(text, secrets);

    /** Stream `parts` through a scrubber; returns what was emitted, event by event. */
    const stream = (parts: string[]) => {
      const d = new DeltaScrubber(secrets);
      const out = parts.map((p) => d.push(p));
      out.push(d.flush());
      return out;
    };

    it('never emits a token split across two deltas, at any offset', () => {
      for (let i = 0; i <= text.length; i++) {
        const out = stream([text.slice(0, i), text.slice(i)]);
        for (const piece of out) expect(piece).not.toContain(TOKEN);
        expect(out.join('')).toBe(expected);
      }
    });

    it('also across many small deltas', () => {
      for (const size of [1, 2, 3, 5, 7]) {
        const parts: string[] = [];
        for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
        const out = stream(parts);
        for (const piece of out) expect(piece).not.toContain(TOKEN);
        expect(out.join('')).toBe(expected);
      }
    });

    it('holds nothing back for text that cannot start a secret', () => {
      const d = new DeltaScrubber(secrets);
      const words = ['The ', 'quick ', 'brown ', 'fox.'];
      expect(words.map((w) => d.push(w))).toEqual(words);
      expect(d.flush()).toBe('');
      // Held back at most the longest secret's length minus one.
      const e = new DeltaScrubber(secrets);
      expect(e.push(`x ${TOKEN.slice(0, -1)}`)).toBe('x ');
      expect(e.flush()).toBe(TOKEN.slice(0, -1));
    });

    it('passes text through when there are no secrets', () => {
      const d = new DeltaScrubber([]);
      expect(d.push('anything')).toBe('anything');
      expect(d.flush()).toBe('');
    });
  });
});
