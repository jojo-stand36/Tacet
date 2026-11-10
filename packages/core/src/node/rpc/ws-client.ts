import { WebSocket } from 'ws';
import { HelloResult } from '../../schema/hello.js';
import type { Secret } from '../auth/secret.js';

/** An error answer from the server, or a failure to reach it. Never carries the token. */
export class RpcClientError extends Error {
  override name = 'RpcClientError';
  constructor(
    message: string,
    /** The JSON-RPC error code, when the server answered with one. */
    readonly code?: number,
  ) {
    super(message);
  }
}

export interface RpcClient {
  hello: HelloResult;
  call(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<unknown>;
  close(): Promise<void>;
}

export interface ConnectRpcOptions {
  port: number;
  token: Secret;
  clientInfo: { name: string; version: string };
  role?: 'cli' | 'mini';
  /** Milliseconds for the connection and hello together, and the default per call. Default 10000. */
  timeoutMs?: number;
  maxPayload?: number;
}

/**
 * Connect to a Tacet JSON-RPC server (`startRpcServer`) on 127.0.0.1 and say hello. The token goes
 * in the upgrade's `Authorization` header only, never in a URL, argument or error.
 */
export async function connectRpc(o: ConnectRpcOptions): Promise<RpcClient> {
  const timeoutMs = o.timeoutMs ?? 10_000;
  const ws = new WebSocket(`ws://127.0.0.1:${o.port}/`, {
    headers: { authorization: `Bearer ${o.token.reveal()}` },
    perMessageDeflate: false,
    maxPayload: o.maxPayload ?? 16 * 1024 * 1024,
    handshakeTimeout: timeoutMs,
  });
  let next = 1;
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  const failAll = (err: Error) => {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  ws.on('message', (data) => {
    let msg: { id?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } };
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    if (typeof msg.id !== 'number') return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) {
      const code = typeof msg.error.code === 'number' ? msg.error.code : undefined;
      const message = typeof msg.error.message === 'string' ? msg.error.message : 'error';
      p.reject(new RpcClientError(message, code));
    } else p.resolve(msg.result);
  });
  ws.on('close', (code, reason) => {
    failAll(new RpcClientError(`connection closed (${code}${reason.length ? ` ${reason}` : ''})`));
  });

  const call = (method: string, params?: unknown, opts: { timeoutMs?: number } = {}) =>
    new Promise<unknown>((resolve, reject) => {
      if (ws.readyState !== ws.OPEN) return reject(new RpcClientError('not connected'));
      const id = next++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new RpcClientError(`${method} timed out`));
      }, opts.timeoutMs ?? timeoutMs);
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
        JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }),
      );
    });

  try {
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      // `ws` names only the status (e.g. "Unexpected server response: 401"), never headers.
      ws.once('error', (err) => reject(new RpcClientError(`cannot connect: ${err.message}`)));
    });
    const hello = HelloResult.parse(
      await call('tacet/hello', {
        protocolVersions: [1],
        role: o.role ?? 'cli',
        clientInfo: o.clientInfo,
        capabilities: {},
      }),
    );
    ws.on('error', () => {});
    return {
      hello,
      call,
      close: () =>
        new Promise<void>((resolve) => {
          if (ws.readyState === ws.CLOSED) return resolve();
          ws.once('close', () => resolve());
          ws.close(1000);
          setTimeout(() => ws.terminate(), 2000).unref();
        }),
    };
  } catch (err) {
    ws.terminate();
    throw err instanceof RpcClientError ? err : new RpcClientError('hello failed');
  }
}
