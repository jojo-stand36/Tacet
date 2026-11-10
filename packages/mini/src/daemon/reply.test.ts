import { describe, expect, it } from 'vitest';
import { MAX_REPLY_CHARS, unfence } from './reply.js';

describe('unfence (#203)', () => {
  it('removes a code fence, with or without json, as the old pattern did', () => {
    expect(unfence('{"a":1}')).toBe('{"a":1}');
    expect(unfence('  ```json\n{"a":1}\n```  ')).toBe('{"a":1}');
    expect(unfence('```JSON {"a":1}```')).toBe('{"a":1}');
    expect(unfence('```\n{"a":1}\n```')).toBe('{"a":1}');
    expect(unfence('{"a":1}\n```')).toBe('{"a":1}');
    expect(unfence('```')).toBe('');
  });

  it('takes linear time on a long whitespace run (quadratic before: about 20 s here)', () => {
    const text = `x${' '.repeat(200_000)}y`;
    const t0 = performance.now();
    expect(unfence(text)).toBe(text);
    expect(unfence(`\`\`\`json\n${text}`)).toBe(text);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it('refuses a reply longer than the cap, at once', () => {
    const t0 = performance.now();
    expect(() => unfence(' '.repeat(MAX_REPLY_CHARS + 1))).toThrow(/longer than/);
    expect(() => unfence(`x${' '.repeat(1024 * 1024)}y`)).toThrow(/longer than/);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
