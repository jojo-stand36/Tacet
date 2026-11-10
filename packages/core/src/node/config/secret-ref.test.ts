import { describe, expect, it } from 'vitest';
import { resolveSecretRef, SecretRefError } from './secret-ref.js';

describe('resolveSecretRef', () => {
  it('reads an environment reference from the given snapshot, held as a Secret', () => {
    const s = resolveSecretRef({ env: 'GOOSE_API_KEY' }, 'agents.goose.env.X', {
      GOOSE_API_KEY: 'value-1234',
    });
    expect(s.reveal()).toBe('value-1234');
    expect(String(s)).toBe('[redacted]');
  });

  it('names the config path, never a value, when it cannot resolve', () => {
    for (const env of [{}, { GOOSE_API_KEY: '' }]) {
      expect(() => resolveSecretRef({ env: 'GOOSE_API_KEY' }, 'agents.goose.env.X', env)).toThrow(
        /^agents\.goose\.env\.X: environment variable GOOSE_API_KEY is not set$/,
      );
    }
  });

  it('reads a keychain reference through the platform tool, and names the path when it cannot (#160)', () => {
    const run =
      (stdout: string, status = 0) =>
      () => ({ status, stdout, stderr: '' });
    const found = resolveSecretRef(
      { keychain: 'tacet/goose' },
      'agents.goose.env.X',
      {},
      {
        keychain: { platform: 'darwin', run: run('value-1234\n') },
      },
    );
    expect(found.reveal()).toBe('value-1234');
    const err = (() => {
      try {
        resolveSecretRef(
          { keychain: 'tacet/goose' },
          'agents.goose.env.X',
          {},
          {
            keychain: { platform: 'darwin', run: run('', 44) },
          },
        );
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(SecretRefError);
    expect(err).toMatchObject({ path: 'agents.goose.env.X' });
    expect(String(err)).toMatch(
      /^SecretRefError: agents\.goose\.env\.X: no keychain item for service "tacet" and account "goose", or the keychain is locked$/,
    );
  });
});
