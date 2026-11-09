import { randomToken, type Secret, tokenKey } from './secret.js';

export const SESSION_COOKIE = 'tacet_session';

/**
 * Single-use login codes for `tacet open` (ADR-003 §3.4). Only hashes are stored. A code is
 * consumed by its first redemption attempt, successful or not, and expires after `ttlMs`.
 */
export class OneTimeCodes {
  readonly #expiry = new Map<string, number>();
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(opts: { ttlMs?: number; now?: () => number } = {}) {
    this.#ttlMs = opts.ttlMs ?? 60_000;
    this.#now = opts.now ?? Date.now;
  }

  issue(): Secret {
    this.#sweep();
    const code = randomToken(16);
    this.#expiry.set(tokenKey(code.reveal()), this.#now() + this.#ttlMs);
    return code;
  }

  /** True once per issued code, and only within its lifetime. */
  redeem(code: string | undefined | null): boolean {
    if (typeof code !== 'string' || code.length === 0) return false;
    const key = tokenKey(code);
    const expiresAt = this.#expiry.get(key);
    if (expiresAt === undefined) return false;
    this.#expiry.delete(key);
    return this.#now() < expiresAt;
  }

  get pending(): number {
    this.#sweep();
    return this.#expiry.size;
  }

  #sweep(): void {
    const now = this.#now();
    for (const [key, expiresAt] of this.#expiry) if (expiresAt <= now) this.#expiry.delete(key);
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `OneTimeCodes(${this.#expiry.size} pending)`;
  }
}

/** Browser sessions created by redeeming a one-time code. In memory; they end with the daemon. */
export class BrowserSessions {
  readonly #sessions = new Set<string>();

  create(): Secret {
    const id = randomToken(32);
    this.#sessions.add(tokenKey(id.reveal()));
    return id;
  }

  validate(id: string | undefined | null): boolean {
    return typeof id === 'string' && id.length > 0 && this.#sessions.has(tokenKey(id));
  }

  revoke(id: string): boolean {
    return this.#sessions.delete(tokenKey(id));
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `BrowserSessions(${this.#sessions.size})`;
  }
}

/** `Set-Cookie` value for a session: HttpOnly and SameSite=Strict (ADR-003 §3.4). */
export function sessionCookie(id: Secret): string {
  return `${SESSION_COOKIE}=${id.reveal()}; HttpOnly; SameSite=Strict; Path=/`;
}

/** The session id from a `Cookie` request header, if present. */
export function readSessionCookie(cookieHeader: string | undefined | null): string | undefined {
  if (typeof cookieHeader !== 'string') return undefined;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE && rest.length > 0) return rest.join('=');
  }
  return undefined;
}

/** URL `tacet open` launches: the code travels in the fragment, which browsers never send. */
export function openUrl(port: number, code: Secret): string {
  return `http://127.0.0.1:${port}/#code=${code.reveal()}`;
}

export type CodeExchange = { ok: true; setCookie: string } | { ok: false; httpStatus: 401 };

/** Handler logic for `POST /auth/session`: trade a valid one-time code for a session cookie. */
export function exchangeCode(
  codes: OneTimeCodes,
  sessions: BrowserSessions,
  code: string | undefined | null,
): CodeExchange {
  if (!codes.redeem(code)) return { ok: false, httpStatus: 401 };
  return { ok: true, setCookie: sessionCookie(sessions.create()) };
}
