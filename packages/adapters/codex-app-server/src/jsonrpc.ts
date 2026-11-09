import type { Readable, Writable } from 'node:stream';

/**
 * Minimal JSON-RPC 2.0 peer over newline-delimited JSON, as `codex app-server` speaks on stdio
 * (one message per line; requests in both directions). Codex omits the `jsonrpc` field, so it is
 * neither sent nor required here.
 */
export interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class RpcError extends Error {
  override name = 'RpcError';
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

/** JSON-RPC error codes this peer sends back. */
export const METHOD_NOT_FOUND = -32601;

export type RequestHandler = (method: string, params: unknown) => Promise<unknown>;
export type NotificationHandler = (method: string, params: unknown) => void;

export class JsonRpcPeer {
  #nextId = 1;
  #buffer = '';
  #closed: Error | undefined;
  readonly #pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  constructor(
    input: Readable,
    private readonly output: Writable,
    private readonly handlers: { onRequest: RequestHandler; onNotification: NotificationHandler },
  ) {
    input.setEncoding('utf8');
    input.on('data', (chunk: string) => this.#onData(chunk));
    input.on('end', () => this.fail(new Error('app-server closed its output')));
  }

  /** True once the peer failed or its input ended; requests then reject at once. */
  get closed(): boolean {
    return this.#closed !== undefined;
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.#closed) return Promise.reject(this.#closed);
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.#write({ id, method, ...(params !== undefined ? { params } : {}) });
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.#closed) this.#write({ method, ...(params !== undefined ? { params } : {}) });
  }

  /** Reject every pending request and stop accepting new ones. */
  fail(err: Error): void {
    if (this.#closed) return;
    this.#closed = err;
    for (const p of this.#pending.values()) p.reject(err);
    this.#pending.clear();
  }

  /**
   * Write one message. A pipe the other side already closed must never throw or emit an unhandled
   * `error` (EPIPE would take down the host process): the caller also listens for `error` on the
   * stream and fails the peer.
   */
  #write(msg: RpcMessage): void {
    if (!this.output.writable || this.output.destroyed) return;
    try {
      this.output.write(`${JSON.stringify(msg)}\n`);
    } catch (err) {
      this.fail(err instanceof Error ? err : new Error(String(err)));
    }
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    for (let i = this.#buffer.indexOf('\n'); i >= 0; i = this.#buffer.indexOf('\n')) {
      const line = this.#buffer.slice(0, i).trim();
      this.#buffer = this.#buffer.slice(i + 1);
      if (!line) continue;
      let msg: RpcMessage;
      try {
        msg = JSON.parse(line) as RpcMessage;
      } catch {
        continue; // Not protocol output; never echoed, since it could hold anything.
      }
      this.#dispatch(msg);
    }
  }

  #dispatch(msg: RpcMessage): void {
    if (msg.method !== undefined && msg.id !== undefined) {
      const id = msg.id;
      // Answers go out while the pipe is open, even after fail(): a denial sent on close is the
      // last thing the server should hear.
      this.handlers.onRequest(msg.method, msg.params).then(
        (result) => this.#write({ id, result: result ?? {} }),
        (err: unknown) =>
          this.#write({
            id,
            error:
              err instanceof RpcError
                ? { code: err.code, message: err.message }
                : { code: -32603, message: 'internal error' },
          }),
      );
    } else if (msg.method !== undefined) {
      this.handlers.onNotification(msg.method, msg.params);
    } else if (typeof msg.id === 'number') {
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
      else p.resolve(msg.result);
    }
  }
}
