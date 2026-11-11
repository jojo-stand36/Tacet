import type { RawData, WebSocket } from 'ws';

/**
 * The parts of a Tacet JSON-RPC socket both ends share (#24, ADR-003 §4: after `tacet/hello` the
 * socket is bidirectional; either side may send requests and notifications). Requests the peer
 * sends are dispatched to handlers; responses the peer sends are matched only to a request this
 * side sent, by id. Errors never echo params.
 */

/** A JSON-RPC error a handler throws to answer with that code; its message goes to the peer. */
export class RpcError extends Error {
  override name = 'RpcError';
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/** An error answer from the peer, or a failure to reach it. Never carries a token or params. */
export class RpcCallError extends Error {
  override name = 'RpcCallError';
  /** The JSON-RPC error code, when the peer answered with one. */
  readonly code: number | undefined;
  constructor(message: string, code?: number) {
    super(message);
    this.code = code;
  }
}

/** A parsed frame: a request or notification (with `method`), or a response (without). */
export type RpcFrame = Record<string, unknown>;

/**
 * Parse one text frame: an object, `'parse'` when it is not JSON (`-32700`), or `'invalid'` when
 * it is JSON but not an object, such as a batch (`-32600`; Tacet sends no batches).
 */
export function parseFrame(data: RawData | string): RpcFrame | 'parse' | 'invalid' {
  let msg: unknown;
  try {
    msg = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
  } catch {
    return 'parse';
  }
  return typeof msg === 'object' && msg !== null && !Array.isArray(msg)
    ? (msg as RpcFrame)
    : 'invalid';
}

/**
 * A response: no `method`, and a result or an error, with an id (`null` only on an error the peer
 * could not tie to a request, such as its own parse error). Never answered.
 */
export function isResponse(msg: RpcFrame): boolean {
  if (msg.method !== undefined) return false;
  if (typeof msg.id === 'string' || typeof msg.id === 'number') {
    return 'result' in msg || 'error' in msg;
  }
  return msg.id === null && 'error' in msg;
}

/** Requests this side sent and waits on. */
export interface Outgoing {
  call(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<unknown>;
  /** Send a notification; resolves once it is handed to the socket. */
  notify(method: string, params?: unknown): Promise<void>;
  /** Settle the request a response answers; false when it answers none of ours. */
  settle(msg: RpcFrame): boolean;
  failAll(err: Error): void;
}

export function outgoing(
  ws: WebSocket,
  defaultTimeoutMs: number,
  makeError: (message: string, code?: number) => Error = (m, c) => new RpcCallError(m, c),
): Outgoing {
  let next = 1;
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  return {
    call: (method, params, opts = {}) =>
      new Promise<unknown>((resolve, reject) => {
        if (ws.readyState !== ws.OPEN) return reject(makeError('not connected'));
        const id = next++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(makeError(`${method} timed out`));
        }, opts.timeoutMs ?? defaultTimeoutMs);
        timer.unref();
        pending.set(id, {
          resolve: (v) => {
            clearTimeout(timer);
            resolve(v);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            method,
            ...(params === undefined ? {} : { params }),
          }),
        );
      }),
    notify: (method, params) =>
      new Promise<void>((resolve, reject) => {
        if (ws.readyState !== ws.OPEN) return reject(makeError('not connected'));
        ws.send(
          JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }),
          (err) => (err ? reject(makeError('not sent')) : resolve()),
        );
      }),
    settle: (msg) => {
      if (typeof msg.id !== 'number') return false;
      const p = pending.get(msg.id);
      if (!p) return false;
      pending.delete(msg.id);
      const error = msg.error as { code?: unknown; message?: unknown } | undefined;
      if (error) {
        const code = typeof error.code === 'number' ? error.code : undefined;
        const message = typeof error.message === 'string' ? error.message : 'error';
        p.reject(makeError(message, code));
      } else p.resolve(msg.result);
      return true;
    },
    failAll: (err) => {
      for (const p of pending.values()) p.reject(err);
      pending.clear();
    },
  };
}

/** Handles one method the peer calls. Throw `RpcError` for a JSON-RPC error; anything else is `-32603`. */
export type PeerHandler<C> = (params: unknown, ctx: C) => unknown;

export interface IncomingOptions<C> {
  handlers: Readonly<Record<string, PeerHandler<C>>>;
  ctx: C;
  /** Requests in flight at once; more get `-32000`. Default 32. */
  maxInFlight?: number;
  /**
   * Notifications queued at once. They run one at a time, in order, and are never answered. A
   * peer past this is closed (1008): refusing one would lose it silently, and pausing the socket
   * would also stop pongs and close frames, so a busy peer would look dead. A sender keeps its own
   * backpressure and resumes from its cursor after a reconnect. Default 64.
   */
  maxQueued?: number;
  /** Methods never served here, e.g. `tacet/hello` after the hello. */
  reserved?: readonly string[];
  /** Told about handler failures, by message only. */
  report?: (err: unknown) => void;
}

/**
 * Requests and notifications the peer sends. Requests run concurrently up to `maxInFlight`;
 * notifications run serially, in order, up to `maxQueued` waiting. A request may overtake an
 * earlier notification. Notification handlers should be quick and must not wait on a call to the
 * peer whose answer would queue behind them.
 */
export function incoming<C>(ws: WebSocket, o: IncomingOptions<C>) {
  let inFlight = 0;
  let queued = 0;
  let chain: Promise<void> = Promise.resolve();
  const send = (msg: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  const run = async (msg: RpcFrame): Promise<unknown> => {
    const { jsonrpc, id, method, params } = msg;
    const notification = id === undefined;
    const rpcId = typeof id === 'string' || typeof id === 'number' ? id : null;
    const error = (code: number, message: string) =>
      notification ? undefined : { jsonrpc: '2.0', id: rpcId, error: { code, message } };
    if (jsonrpc !== '2.0' || typeof method !== 'string' || (!notification && rpcId === null)) {
      return error(-32600, 'invalid request');
    }
    if (o.reserved?.includes(method)) return error(-32600, `${method} is not served here`);
    const handler = Object.hasOwn(o.handlers, method) ? o.handlers[method] : undefined;
    if (!handler) return error(-32601, `method not found: ${method}`);
    try {
      const result = await handler(params, o.ctx);
      return notification ? undefined : { jsonrpc: '2.0', id: rpcId, result: result ?? null };
    } catch (err) {
      if (err instanceof RpcError) return error(err.code, err.message);
      // Internal errors can name paths or state: the peer gets a generic message.
      o.report?.(err);
      return error(-32603, 'internal error');
    }
  };

  return {
    /** Handle one frame that is not a response. */
    handle(msg: RpcFrame | 'parse' | 'invalid'): void {
      if (msg === 'parse') {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
        return;
      }
      if (msg === 'invalid') {
        send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } });
        return;
      }
      if (msg.id === undefined) {
        if (queued >= (o.maxQueued ?? 64)) {
          ws.close(1008, 'too many notifications');
          return;
        }
        queued++;
        chain = chain
          .then(() => run(msg))
          .then(
            () => {},
            (err) => o.report?.(err),
          )
          .finally(() => {
            queued--;
          });
        return;
      }
      if (inFlight >= (o.maxInFlight ?? 32)) {
        const rpcId = typeof msg.id === 'string' || typeof msg.id === 'number' ? msg.id : null;
        send({ jsonrpc: '2.0', id: rpcId, error: { code: -32000, message: 'too many requests' } });
        return;
      }
      inFlight++;
      void run(msg)
        .then((reply) => reply && send(reply))
        .finally(() => {
          inFlight--;
        });
    },
  };
}
