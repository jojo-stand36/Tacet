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
 * Who is calling. `browser`: the web UI, i.e. the unauthenticated WebSocket upgrade and every
 * HTTP call that carries a browser session token; it always requires a matching `Origin`.
 * `bearer`: programmatic clients with a daemon or worker token (CLI, Mini-conductor, worker MCP);
 * they may omit `Origin`, but a present one must match.
 */
export type RequestAuth = 'browser' | 'bearer';

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
 * served. `auth` is required so a browser route cannot forget the Origin requirement; it fails
 * closed for anything other than `bearer`.
 */
export function checkHostAndOrigin(
  headers: RequestHeaders,
  port: number,
  auth: RequestAuth,
): RequestCheck {
  const host = headers.host?.trim().toLowerCase();
  if (!host || !allowedHosts(port).includes(host)) return reject('host not allowed');
  const origin = headers.origin?.trim().toLowerCase();
  if (origin === undefined || origin === '') {
    return auth === 'bearer' ? { ok: true } : reject('origin required');
  }
  if (!allowedOrigins(port).includes(origin)) return reject('origin not allowed');
  return { ok: true };
}
