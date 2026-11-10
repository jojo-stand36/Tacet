import type { SecretRef } from '../../config/schema.js';
import { Secret } from '../auth/secret.js';
import { KeychainError, type KeychainOptions, readKeychain } from './keychain.js';

/** A secret reference in config that could not be resolved. Says where, never a value. */
export class SecretRefError extends Error {
  override name = 'SecretRefError';
  constructor(
    /** The config path, e.g. `agents.goose.env.GOOSE_API_KEY`. */
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
  }
}

/**
 * The value a config secret reference points to (#149), held as a `Secret` until the point of use.
 * `{ env }` reads `env` (the same snapshot the Workers' environment is built from). `{ keychain:
 * "service/account" }` reads the OS keychain (#160, `readKeychain`: macOS Keychain, or a Secret
 * Service keyring on Linux). Anything unresolved is an error naming the config path, never a
 * value, so a run never goes on without the credential it was configured with.
 */
export function resolveSecretRef(
  ref: SecretRef,
  path: string,
  env: Record<string, string | undefined>,
  opts: { keychain?: KeychainOptions } = {},
): Secret {
  if ('keychain' in ref) {
    try {
      return readKeychain(ref.keychain, opts.keychain);
    } catch (err) {
      if (err instanceof KeychainError) throw new SecretRefError(path, err.message);
      throw err;
    }
  }
  const value = env[ref.env];
  if (value === undefined || value === '') {
    throw new SecretRefError(path, `environment variable ${ref.env} is not set`);
  }
  return new Secret(value);
}
