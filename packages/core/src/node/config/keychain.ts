import { spawnSync } from 'node:child_process';
import { Secret } from '../auth/secret.js';

/** What running the platform tool gave: as `spawnSync` reports it, output decoded as UTF-8. */
export interface KeychainToolResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Set when the tool could not be run (`ENOENT`: not installed) or timed out (`ETIMEDOUT`). */
  error?: NodeJS.ErrnoException;
}

/** Runs the platform's keychain tool; replaced in tests. */
export type KeychainToolRunner = (
  file: string,
  args: string[],
  timeoutMs: number,
) => KeychainToolResult;

export interface KeychainOptions {
  /** Default `process.platform`. Only `darwin` and `linux` are supported. */
  platform?: NodeJS.Platform;
  /** Default: `spawnSync`, no shell, stdin closed. */
  run?: KeychainToolRunner;
  /**
   * Milliseconds to wait for the tool. A keychain that needs unlocking can make it wait for a
   * dialog Tacet never answers. Default 20000.
   */
  timeoutMs?: number;
}

/** Why a keychain item could not be read. Never holds a value. */
export class KeychainError extends Error {
  override name = 'KeychainError';
}

const defaultRun: KeychainToolRunner = (file, args, timeoutMs) => {
  const r = spawnSync(file, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    windowsHide: true,
  });
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    ...(r.error ? { error: r.error as NodeJS.ErrnoException } : {}),
  };
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const CONTROL = /[\u0000-\u001f\u007f]/;
/** Printable ASCII: what API keys are, and all macOS returns unencoded. */
const PRINTABLE = /^[\u0020-\u007e]+$/;

/** `service/account` → its parts; the account is everything after the first `/`. */
export function parseKeychainRef(ref: string): { service: string; account: string } {
  const i = ref.indexOf('/');
  const service = i < 0 ? '' : ref.slice(0, i);
  const account = i < 0 ? '' : ref.slice(i + 1);
  if (!service || !account) {
    throw new KeychainError(`keychain reference ${JSON.stringify(ref)} must be "service/account"`);
  }
  // Both become arguments of the platform tool: one starting with `-` could be read as an option,
  // and a control character (a NUL) cannot be an argument at all.
  if (service.startsWith('-') || account.startsWith('-') || CONTROL.test(ref)) {
    throw new KeychainError(
      `keychain reference ${JSON.stringify(ref)}: service and account may not start with "-" or hold control characters`,
    );
  }
  return { service, account };
}

/**
 * The first line of a tool's message, for an error (the value is only ever on stdout), with
 * anything but printable ASCII dropped so no escape sequence reaches a log.
 */
function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.replace(/[^\u0020-\u007e]/g, '').slice(0, 200);
}

/**
 * Reads a generic password from the OS keychain (#160), without a shell and without the value
 * touching disk or any argv: only `service` and `account` are arguments.
 *
 * - **macOS:** `/usr/bin/security find-generic-password -s <service> -a <account> -w`. It prints the
 *   password and a newline, or the password as hex when any byte is not printable ASCII
 *   (`keychain_find.c`), so only printable ASCII values (API keys are) read back as stored.
 *   A missing item, and a search that fails (a locked keychain), exit 44 (`errSecItemNotFound`,
 *   -25300); a failure reading the password exits with its own status (for example 51,
 *   `errSecAuthFailed`).
 * - **Linux:** `secret-tool lookup service <service> account <account>` (libsecret, Secret
 *   Service): the value exactly as stored. Not found and, without a display, a locked keyring
 *   both exit 1 with no output; no session bus exits 1 with a message.
 *
 * One trailing newline is dropped on both (`echo key | secret-tool store` stores `key\n`), and the
 * value must then be printable ASCII: anything else (a NUL, which cannot go into an environment;
 * other control characters; non-ASCII, which macOS returns as hex) is refused, without the value.
 * Tacet never unlocks a keychain or answers a prompt. It runs synchronously, up to the timeout per
 * reference.
 */
export function readKeychain(ref: string, opts: KeychainOptions = {}): Secret {
  const { service, account } = parseKeychainRef(ref);
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? defaultRun;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const where = `service ${JSON.stringify(service)} and account ${JSON.stringify(account)}`;
  let tool: string;
  let args: string[];
  let install: string;
  if (platform === 'darwin') {
    // Absolute, so an earlier `security` on PATH cannot answer in its place.
    tool = '/usr/bin/security';
    args = ['find-generic-password', '-s', service, '-a', account, '-w'];
    install = 'it ships with macOS at /usr/bin/security';
  } else if (platform === 'linux') {
    tool = 'secret-tool';
    args = ['lookup', 'service', service, 'account', account];
    install =
      'install libsecret-tools (Debian, Ubuntu) or libsecret, and run a Secret Service such as gnome-keyring';
  } else {
    throw new KeychainError(`keychain references are not supported on ${platform}`);
  }
  const r = run(tool, args, timeoutMs);
  if (r.error?.code === 'ENOENT') throw new KeychainError(`${tool} is not installed: ${install}`);
  if (r.error?.code === 'ETIMEDOUT') {
    throw new KeychainError(
      `${tool} did not answer within ${timeoutMs} ms reading ${where}: the keychain may be locked and waiting for a password, which Tacet never enters`,
    );
  }
  if (r.error)
    throw new KeychainError(`${tool} could not be run: ${r.error.code ?? r.error.message}`);
  if (r.status === 0) {
    const value = r.stdout.replace(/\r?\n$/, '');
    if (value === '') throw new KeychainError(`the keychain item for ${where} is empty`);
    if (!PRINTABLE.test(value)) {
      throw new KeychainError(
        `the keychain item for ${where} holds characters other than printable ASCII (a newline, a control character or non-ASCII); store the key alone, e.g. with printf '%s'`,
      );
    }
    return new Secret(value);
  }
  if (platform === 'darwin' && r.status === 44) {
    throw new KeychainError(`no keychain item for ${where}, or the keychain is locked`);
  }
  if (platform === 'linux' && r.status === 1 && r.stderr.trim() === '') {
    throw new KeychainError(`no keyring item for ${where}, or the keyring is locked`);
  }
  const detail = firstLine(r.stderr);
  throw new KeychainError(
    `${tool} could not read ${where} (exit ${r.status ?? 'none'}${detail ? `: ${detail}` : ''})`,
  );
}
