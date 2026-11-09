import { describe, expect, it } from 'vitest';
import { redactSecrets } from './secrets.js';

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
  it('leaves ordinary text alone', () => {
    expect(redactSecrets('touch file.txt')).toBe('touch file.txt');
  });
});
