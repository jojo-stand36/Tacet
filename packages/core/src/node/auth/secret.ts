import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const REDACTED = '[redacted]';

/**
 * Holds a credential so it cannot leak by accident: `String()`, template literals, `JSON.stringify`
 * and `util.inspect` (and so `console.log`) all print `[redacted]`. Call `reveal()` only at the
 * point of use, such as writing the runtime file or setting a header.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    if (value.length === 0) throw new Error('Secret must not be empty');
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  /** Constant-time comparison against an untrusted candidate. */
  equals(candidate: string | undefined | null): boolean {
    if (typeof candidate !== 'string') return false;
    return timingSafeEqual(sha256(this.#value), sha256(candidate));
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `Secret(${REDACTED})`;
  }
}

/** A fresh random token: `bytes` random bytes, base64url encoded. Defaults to 256 bits. */
export function randomToken(bytes = 32): Secret {
  return new Secret(randomBytes(bytes).toString('base64url'));
}

export function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Hex digest used as a map key, so stores keep hashes rather than raw tokens. */
export function tokenKey(value: string): string {
  return sha256(value).toString('hex');
}

/** Extract the token from an `Authorization: Bearer <token>` header value. */
export function parseBearer(header: string | undefined | null): string | undefined {
  if (typeof header !== 'string') return undefined;
  const match = /^bearer +([A-Za-z0-9._~+/=-]+)$/i.exec(header.trim());
  return match?.[1];
}

/** True if the header carries exactly `token`, compared in constant time. */
export function checkBearer(header: string | undefined | null, token: Secret): boolean {
  return token.equals(parseBearer(header));
}
