import { checkHostAndOrigin, type RequestCheck } from './origin.js';
import { parseBearer, randomToken, type Secret, tokenKey } from './secret.js';

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

/**
 * Browser sessions created by redeeming a one-time code (ADR-003 §3.4 addendum, 2026-11-09).
 * The page holds the session token in memory only and presents it in the `tacet/hello` params
 * on the WebSocket and as `Authorization: Bearer` on HTTP. No cookie is ever set. Only token
 * hashes are stored, in memory; sessions end with the daemon. At most `max` are kept; creating
 * one more evicts the oldest.
 */
export class BrowserSessions {
  readonly #sessions = new Set<string>();
  readonly #max: number;

  constructor(opts: { max?: number } = {}) {
    this.#max = opts.max ?? 32;
  }

  create(): Secret {
    const id = randomToken(32);
    this.#sessions.add(tokenKey(id.reveal()));
    while (this.#sessions.size > this.#max) {
      const oldest = this.#sessions.values().next().value;
      if (oldest === undefined) break;
      this.#sessions.delete(oldest);
    }
    return id;
  }

  validate(id: string | undefined | null): boolean {
    return typeof id === 'string' && id.length > 0 && this.#sessions.has(tokenKey(id));
  }

  /** Validate an `Authorization: Bearer <token>` header from the page's HTTP calls. */
  validateHeader(header: string | undefined | null): boolean {
    return this.validate(parseBearer(header));
  }

  revoke(id: string): boolean {
    return this.#sessions.delete(tokenKey(id));
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `BrowserSessions(${this.#sessions.size})`;
  }
}

/** URL `tacet open` launches: the code travels in the fragment, which browsers never send. */
export function openUrl(port: number, code: Secret): string {
  return `http://127.0.0.1:${port}/#code=${code.reveal()}`;
}

/** Response headers for `POST /auth/session`: JSON, never cached. No `Set-Cookie`. */
export const SESSION_RESPONSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-type': 'application/json',
  'cache-control': 'no-store',
});

export type CodeExchange = { ok: true; token: Secret } | { ok: false; httpStatus: 401 };

/**
 * JSON body for a successful `POST /auth/session`: `{"sessionToken":"…"}`. Build it only at the
 * point of sending, so the raw token never sits in a loggable object. The page keeps the token in
 * memory only.
 */
export function sessionResponseBody(token: Secret): string {
  return JSON.stringify({ sessionToken: token.reveal() });
}

/**
 * Handler logic for `POST /auth/session`: trade a valid one-time code for a browser session
 * token. Respond with `SESSION_RESPONSE_HEADERS` and `sessionResponseBody(result.token)`.
 */
export function exchangeCode(
  codes: OneTimeCodes,
  sessions: BrowserSessions,
  code: string | undefined | null,
): CodeExchange {
  if (!codes.redeem(code)) return { ok: false, httpStatus: 401 };
  return { ok: true, token: sessions.create() };
}

/**
 * Authorize a web UI HTTP call that carries a browser session token: rejects WebSocket upgrades
 * (they use `checkHostAndOrigin(..., 'browser')` and the hello), then applies the `session`
 * Host/Origin rule with the real request method (403), then requires a valid
 * `Authorization: Bearer <session token>` (401). Pass Node's `req` (`method` and `headers`) directly.
 */
export function authorizeSessionRequest(
  req: {
    method?: string | undefined;
    headers: {
      host?: string | undefined;
      origin?: string | undefined;
      authorization?: string | undefined;
      upgrade?: string | undefined;
    };
  },
  port: number,
  sessions: BrowserSessions,
): RequestCheck {
  if (req.headers.upgrade !== undefined) {
    return {
      ok: false,
      httpStatus: 403,
      wsCloseCode: 4401,
      reason: 'upgrade is not a session call',
    };
  }
  // Host and Origin first, as for every request, so a rebinding Host never reaches the token
  // lookup. Both checks must pass; the order only decides the status code.
  const check = checkHostAndOrigin(req.headers, port, 'session', req.method);
  if (!check.ok) return check;
  if (!sessions.validateHeader(req.headers.authorization)) {
    return { ok: false, httpStatus: 401, wsCloseCode: 4401, reason: 'invalid session' };
  }
  return check;
}
