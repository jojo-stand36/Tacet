import { describe, expect, it } from 'vitest';
import { type KeychainToolResult, type KeychainToolRunner, readKeychain } from './keychain.js';

const VALUE = 'sk-test-keychain-value-0000';
/** A fake platform tool that records how it was called and answers `result`. */
function tool(result: Partial<KeychainToolResult>) {
  const calls: { file: string; args: string[] }[] = [];
  const run: KeychainToolRunner = (file, args) => {
    calls.push({ file, args });
    return { status: 0, stdout: '', stderr: '', ...result };
  };
  return { run, calls };
}
const enoent = Object.assign(new Error('spawnSync security ENOENT'), { code: 'ENOENT' });
const timedOut = Object.assign(new Error('spawnSync security ETIMEDOUT'), { code: 'ETIMEDOUT' });
/** The error `fn` throws, which must never contain the value. */
function failure(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    expect(String(err)).not.toContain(VALUE);
    expect(JSON.stringify(err)).not.toContain(VALUE);
    return err as Error;
  }
  throw new Error('expected a failure');
}

describe('readKeychain (#160)', () => {
  it('macOS: security find-generic-password -s -a -w, without its trailing newline', () => {
    const t = tool({ stdout: `${VALUE}\n` });
    const s = readKeychain('tacet/goose', { platform: 'darwin', run: t.run });
    expect(s.reveal()).toBe(VALUE);
    expect(String(s)).toBe('[redacted]');
    expect(t.calls).toEqual([
      {
        file: '/usr/bin/security',
        args: ['find-generic-password', '-s', 'tacet', '-a', 'goose', '-w'],
      },
    ]);
  });

  it('Linux: secret-tool lookup service account; one trailing newline (from `echo`) dropped', () => {
    const t = tool({ stdout: `${VALUE}\n` });
    expect(readKeychain('tacet/goose/team', { platform: 'linux', run: t.run }).reveal()).toBe(
      VALUE,
    );
    expect(
      readKeychain('a/b', { platform: 'linux', run: tool({ stdout: VALUE }).run }).reveal(),
    ).toBe(VALUE);
    expect(
      readKeychain('a/b', {
        platform: 'linux',
        run: tool({ stdout: `${VALUE}\r\n` }).run,
      }).reveal(),
    ).toBe(VALUE);
    expect(t.calls).toEqual([
      { file: 'secret-tool', args: ['lookup', 'service', 'tacet', 'account', 'goose/team'] },
    ]);
  });

  it('reports a missing item, or a locked keychain, as such', () => {
    expect(
      failure(() =>
        readKeychain('a/b', {
          platform: 'darwin',
          run: tool({
            status: 44,
            stderr:
              'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n',
          }).run,
        }),
      ).message,
    ).toMatch(/no keychain item for service "a" and account "b", or the keychain is locked/);
    expect(
      failure(() => readKeychain('a/b', { platform: 'linux', run: tool({ status: 1 }).run }))
        .message,
    ).toMatch(/no keyring item for service "a" and account "b", or the keyring is locked/);
  });

  it('reports a refused read, a missing session bus and a timeout with what the tool said', () => {
    expect(
      failure(() =>
        readKeychain('a/b', {
          platform: 'darwin',
          run: tool({
            status: 51,
            stderr:
              'security: SecKeychainItemCopyContent: The user name or passphrase you entered is not correct.\n',
          }).run,
        }),
      ).message,
    ).toMatch(
      /security could not read service "a" and account "b" \(exit 51: security: SecKeychainItemCopyContent/,
    );
    expect(
      failure(() =>
        readKeychain('a/b', {
          platform: 'linux',
          run: tool({
            status: 1,
            stderr: 'secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY\n',
          }).run,
        }),
      ).message,
    ).toMatch(/exit 1: secret-tool: Cannot autolaunch D-Bus/);
    expect(
      failure(() =>
        readKeychain('a/b', {
          platform: 'darwin',
          timeoutMs: 5,
          run: tool({ status: null, error: timedOut }).run,
        }),
      ).message,
    ).toMatch(/did not answer within 5 ms .* locked .* never enters/);
  });

  it('says how to install a missing tool', () => {
    expect(
      failure(() =>
        readKeychain('a/b', { platform: 'linux', run: tool({ status: null, error: enoent }).run }),
      ).message,
    ).toMatch(/secret-tool is not installed: install libsecret-tools/);
    expect(
      failure(() =>
        readKeychain('a/b', { platform: 'darwin', run: tool({ status: null, error: enoent }).run }),
      ).message,
    ).toMatch(/security is not installed/);
  });

  it('never returns an empty value, and never puts what stdout held into an error', () => {
    expect(
      failure(() => readKeychain('a/b', { platform: 'darwin', run: tool({ stdout: '\n' }).run }))
        .message,
    ).toMatch(/is empty/);
    // A tool that printed something and still failed: the output is not repeated.
    failure(() =>
      readKeychain('a/b', {
        platform: 'linux',
        run: tool({ status: 2, stdout: VALUE, stderr: 'odd\n' }).run,
      }),
    );
  });

  it('refuses a value that is not printable ASCII, without showing it', () => {
    // A NUL cannot go into an environment (Node would print the value refusing it); a newline
    // inside, other control characters and non-ASCII are not an API key either.
    for (const stdout of [
      `fake\u0000${VALUE}`,
      `${VALUE}\nsecond line\n`,
      `${VALUE}\u001b[0m`,
      `${VALUE}é`,
      `${VALUE}\n\n`,
    ]) {
      for (const platform of ['linux', 'darwin'] as const) {
        expect(
          failure(() => readKeychain('a/b', { platform, run: tool({ stdout }).run })).message,
        ).toMatch(/holds characters other than printable ASCII .* printf '%s'/);
      }
    }
  });

  it('keeps escape sequences from the tool out of its errors', () => {
    const message = failure(() =>
      readKeychain('a/b', {
        platform: 'linux',
        run: tool({ status: 3, stderr: '\u001b[31mboom\u001b[0m\n' }).run,
      }),
    ).message;
    expect(message).toMatch(/exit 3: \[31mboom\[0m\)$/);
    expect(message).not.toContain('\u001b');
  });

  it('refuses malformed references and other platforms before running anything', () => {
    for (const ref of ['tacet', '/b', 'a/', '-w/b', 'a/--help', 'a/b\u0000c', 'a\n/b']) {
      const t = tool({});
      expect(() => readKeychain(ref, { platform: 'linux', run: t.run }), ref).toThrow(
        /keychain reference/,
      );
      expect(t.calls).toEqual([]);
    }
    const t = tool({});
    expect(() => readKeychain('a/b', { platform: 'win32', run: t.run })).toThrow(
      /not supported on win32/,
    );
    expect(t.calls).toEqual([]);
  });
});
