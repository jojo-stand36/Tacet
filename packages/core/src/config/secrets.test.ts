import { describe, expect, it } from 'vitest';
import { findSecrets, redactSecrets } from './secrets.js';

// Shaped like real keys but invented for this test.
const KEY = `sk-ant-${'a'.repeat(24)}`;

describe('redactSecrets', () => {
  it('replaces only the credential inside a string', () => {
    expect(redactSecrets(`curl -H "x-api-key: ${KEY}" ${KEY}`)).toBe(
      'curl -H "x-api-key: [redacted]" [redacted]',
    );
  });
  it('walks objects and arrays without mutating the input', () => {
    const input = { command: `echo ${KEY}`, args: [KEY, 'plain'], n: 1, nil: null };
    expect(redactSecrets(input)).toEqual({
      command: 'echo [redacted]',
      args: ['[redacted]', 'plain'],
      n: 1,
      nil: null,
    });
    expect(input.command).toContain(KEY);
  });
  it('drops a whole string holding a private key', () => {
    expect(redactSecrets('x\n-----BEGIN RSA PRIVATE KEY-----\nabc')).toBe('[redacted]');
  });
  it('redacts bearer tokens, such as Worker tokens, which have no vendor prefix', () => {
    expect(redactSecrets(`curl -H "Authorization: Bearer ${'Z9_-'.repeat(8)}" x`)).toBe(
      'curl -H "Authorization: [redacted]" x',
    );
    expect(redactSecrets('Bearer short')).toBe('Bearer short');
    for (const scheme of ['bearer', 'BEARER', 'bEaReR']) {
      expect(redactSecrets(`${scheme} ${'Z9_-'.repeat(8)}`)).toBe('[redacted]');
      expect(findSecrets({ h: `${scheme} ${'Z9_-'.repeat(8)}` })).toHaveLength(1);
    }
  });
  it('does not flag an environment reference after Bearer in config', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal ${VAR} reference is the input under test
    expect(findSecrets({ headers: { authorization: 'Bearer ${TACET_TOKEN}' } })).toEqual([]);
  });

  it('leaves ordinary text alone', () => {
    expect(redactSecrets('touch file.txt')).toBe('touch file.txt');
  });
});
