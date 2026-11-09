/** Loopback addresses a daemon binds by default (ADR-003 §3.1). */
export const LOOPBACK_ADDRESSES = ['127.0.0.1', '::1'] as const;

/** `Host` header values accepted for a server on `port`. */
export function allowedHosts(port: number): string[] {
  return [`127.0.0.1:${port}`, `[::1]:${port}`, `localhost:${port}`];
}

/** Origins a browser page served by this daemon can have. */
export function allowedOrigins(port: number): string[] {
  return allowedHosts(port).map((h) => `http://${h}`);
}

export type RequestCheck =
  | { ok: true }
  | { ok: false; httpStatus: 401 | 403; wsCloseCode: 4401; reason: string };

export interface RequestHeaders {
  host?: string | undefined;
  origin?: string | undefined;
}

/**
 * Who is calling. A present `Origin` must always match; the kinds differ only in whether it may
 * be missing.
 * - `browser`: requests without a credential the page could only hold if served by this daemon,
 *   i.e. the unauthenticated WebSocket upgrade and the one-time-code exchange. `Origin` required.
 * - `session`: HTTP calls carrying a validated browser session token. Browsers send no `Origin`
 *   on GET and HEAD unless the request is CORS (Fetch standard, "append a request `Origin`
 *   header"), so it may be missing there; any other method requires it. A missing `Origin` is not
 *   proof of same-origin: the session token is the control and the Origin check is extra defence,
 *   so session GET/HEAD handlers must not change state. Low-level: daemons should call
 *   `authorizeSessionRequest`, which validates the token and rejects upgrades first.
 * - `bearer`: programmatic clients with a daemon or worker token (CLI, Mini-conductor, worker
 *   MCP). `Origin` may be missing.
 */
export type RequestAuth = 'browser' | 'session' | 'bearer';

const SAFE_METHODS = new Set(['GET', 'HEAD']);

function originOptional(auth: RequestAuth, method: string | undefined): boolean {
  if (auth === 'bearer') return true;
  // Methods are case-sensitive (RFC 9110 §9.1); Node and browsers send them uppercase.
  if (auth === 'session') return method !== undefined && SAFE_METHODS.has(method);
  return false;
}

const reject = (reason: string, httpStatus: 401 | 403 = 403): RequestCheck => ({
  ok: false,
  httpStatus,
  wsCloseCode: 4401,
  reason,
});

/**
 * Host and Origin checks for every HTTP and WebSocket request (ADR-003 §3.5). The `Host` must be
 * exactly a loopback name with the server's port; anything else, including a DNS-rebinding
 * hostname that resolved to 127.0.0.1, is rejected. A present `Origin` must be a page this daemon
 * served. `auth` is required so a browser route cannot forget the Origin requirement; a missing
 * `Origin` fails closed except where `RequestAuth` allows it. `method` is the request line's
 * method (`req.method`), never a header, and is only read for `session`.
 */
export function checkHostAndOrigin(
  headers: RequestHeaders,
  port: number,
  auth: RequestAuth,
  method?: string,
): RequestCheck {
  const host = headers.host?.trim().toLowerCase();
  if (!host || !allowedHosts(port).includes(host)) return reject('host not allowed');
  const origin = headers.origin?.trim().toLowerCase();
  if (origin === undefined || origin === '') {
    return originOptional(auth, method) ? { ok: true } : reject('origin required');
  }
  if (!allowedOrigins(port).includes(origin)) return reject('origin not allowed');
  return { ok: true };
}
