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

/** `service/account` → its parts; the account is everything after the first `/`. */
export function parseKeychainRef(ref: string): { service: string; account: string } {
  const i = ref.indexOf('/');
  const service = i < 0 ? '' : ref.slice(0, i);
  const account = i < 0 ? '' : ref.slice(i + 1);
  if (!service || !account) {
    throw new KeychainError(`keychain reference ${JSON.stringify(ref)} must be "service/account"`);
  }
  // Both become arguments of the platform tool: one starting with `-` could be read as an option.
  if (service.startsWith('-') || account.startsWith('-')) {
    throw new KeychainError(
      `keychain reference ${JSON.stringify(ref)}: service and account may not start with "-"`,
    );
  }
  return { service, account };
}

/** The first line of a tool's message, for an error (the value is only ever on stdout). */
function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.slice(0, 200) ?? '';
}

/**
 * Reads a generic password from the OS keychain (#160), without a shell and without the value
 * touching disk or any argv: only `service` and `account` are arguments.
 *
 * - **macOS:** `security find-generic-password -s <service> -a <account> -w`. It prints the
 *   password and a newline, or the password as hex when any byte is not printable ASCII
 *   (`keychain_find.c`), so only printable ASCII values (API keys are) read back as stored.
 *   A missing item, and a search that fails (a locked keychain), exit 44 (`errSecItemNotFound`,
 *   -25300); a failure reading the password exits with its own status (for example 51,
 *   `errSecAuthFailed`).
 * - **Linux:** `secret-tool lookup service <service> account <account>` (libsecret, Secret
 *   Service): the value exactly as stored. Not found and a locked keyring both exit 1 with no
 *   output (its unlock prompt needs a display); no session bus exits 1 with a message.
 *
 * Tacet never unlocks a keychain or answers a prompt.
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
    tool = 'security';
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
    const value =
      platform === 'darwin' && r.stdout.endsWith('\n') ? r.stdout.slice(0, -1) : r.stdout;
    if (value !== '') return new Secret(value);
    throw new KeychainError(`the keychain item for ${where} is empty`);
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
