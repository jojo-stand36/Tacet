import { WebSocket } from 'ws';
import { HelloResult } from '../../schema/hello.js';
import type { Secret } from '../auth/secret.js';
import {
  incoming,
  isResponse,
  outgoing,
  type PeerHandler,
  parseFrame,
  RpcCallError,
} from './peer.js';

/** An error answer from the server, or a failure to reach it. Never carries the token. */
export class RpcClientError extends RpcCallError {
  override name = 'RpcClientError';
  /** The HTTP status the server refused the upgrade with, if it did. */
  readonly httpStatus: number | undefined;
  constructor(message: string, code?: number, httpStatus?: number) {
    super(message, code);
    this.httpStatus = httpStatus;
  }
}

export interface RpcClient {
  hello: HelloResult;
  call(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<unknown>;
  close(): Promise<void>;
  /** Settles when the connection is gone, whoever ended it, with the WebSocket close code. */
  closed: Promise<{ code: number; reason: string }>;
  /** Send the server a notification; resolves once it is handed to the socket. */
  notify(method: string, params?: unknown): Promise<void>;
  /** Bytes queued on the socket and not yet sent: for a sender that must not outrun it. */
  bufferedAmount(): number;
}

/** What a client knows when the server calls it (#24): its own connection. */
export interface ClientContext {
  /** The session id the server's hello gave this connection. */
  sessionId: string;
  /** Send the server a notification on this connection. */
  notify(method: string, params?: unknown): Promise<void>;
  /** Bytes queued on this connection and not yet sent. */
  bufferedAmount(): number;
  /** Settles when this connection is gone. */
  closed: Promise<{ code: number; reason: string }>;
}

/** What a Mini-conductor says about itself in its hello (ADR-003 §3.6): a lightweight Agent Card. */
export interface MiniCard {
  repoId: string;
  repoPath: string;
  adapters: string[];
  miniVersion: string;
}

export interface ConnectRpcOptions {
  port: number;
  token: Secret;
  clientInfo: { name: string; version: string };
  role?: 'cli' | 'mini';
  /** Required with `role: 'mini'`. */
  card?: MiniCard;
  /**
   * Close the connection when the server has sent nothing, not even a ping, for this long (ms):
   * a server that hangs or a peer that vanished without a FIN (#23). Off by default.
   */
  silenceTimeoutMs?: number;
  /**
   * Methods the server may call on this socket after the hello (#24, ADR-003 §4: either side may
   * send requests). Anything else is answered `-32601`.
   */
  handlers?: Readonly<Record<string, PeerHandler<ClientContext>>>;
  /** Capability flags the hello advertises (ADR-003 §2), e.g. the methods `handlers` serves. */
  capabilities?: Record<string, unknown>;
  /** Requests from the server in flight at once; more get `-32000`. Default 32. */
  maxInFlight?: number;
  /** Told about handler failures, by message only. */
  onError?: (message: string) => void;
  /** Milliseconds for the connection and hello together, and the default per call. Default 10000. */
  timeoutMs?: number;
  maxPayload?: number;
}

/**
 * Connect to a Tacet JSON-RPC server (`startRpcServer`) on 127.0.0.1 and say hello. The token goes
 * in the upgrade's `Authorization` header only, never in a URL, argument or error.
 */
export async function connectRpc(o: ConnectRpcOptions): Promise<RpcClient> {
  if ((o.role ?? 'cli') === 'mini' && !o.card) {
    throw new RpcClientError('a mini hello needs its card');
  }
  const timeoutMs = o.timeoutMs ?? 10_000;
  const ws = new WebSocket(`ws://127.0.0.1:${o.port}/`, {
    headers: { authorization: `Bearer ${o.token.reveal()}` },
    perMessageDeflate: false,
    maxPayload: o.maxPayload ?? 16 * 1024 * 1024,
    handshakeTimeout: timeoutMs,
  });
  const out = outgoing(ws, timeoutMs, (m, code) => new RpcClientError(m, code));
  const failAll = out.failAll;
  // Filled in once `closed` exists, before any handler can run (only after the hello).
  let ctx = undefined as unknown as ClientContext;
  // Requests the server sends, served only once the hello is done.
  let peer: ReturnType<typeof incoming<ClientContext>> | undefined;
  const early: Record<string, unknown>[] = [];
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    const msg = parseFrame(data);
    if (typeof msg === 'string') return;
    if (isResponse(msg)) {
      out.settle(msg);
      return;
    }
    if (typeof msg.method === 'string') {
      // A request can come in the same read as the hello's answer, before the handlers are set:
      // held until then, in order (a few at most; the server sends after the hello).
      if (peer) peer.handle(msg);
      else if (early.length < 64) early.push(msg);
      // Never dropped quietly: a server that floods before the hello is done is closed.
      else ws.close(1008, 'too many requests before the hello');
    }
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.on('close', (code, reason) => {
      failAll(
        new RpcClientError(`connection closed (${code}${reason.length ? ` ${reason}` : ''})`),
      );
      resolve({ code, reason: reason.toString('utf8') });
    });
  });
  ctx = {
    sessionId: '',
    notify: out.notify,
    bufferedAmount: () => ws.bufferedAmount,
    closed,
  };
  // Any frame from the server, pings included, shows it is there.
  let silence: NodeJS.Timeout | undefined;
  const heard = () => {
    if (o.silenceTimeoutMs === undefined) return;
    if (silence) clearTimeout(silence);
    silence = setTimeout(() => ws.terminate(), o.silenceTimeoutMs);
    silence.unref();
  };
  ws.on('ping', heard);
  ws.on('message', heard);
  ws.once('open', heard);
  void closed.then(() => silence && clearTimeout(silence));

  const call = out.call;

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
        capabilities: o.capabilities ?? {},
        ...(o.role === 'mini' ? o.card : {}),
      }),
    );
    ws.on('error', () => {});
    ctx.sessionId = hello.sessionId;
    peer = incoming(ws, {
      handlers: o.handlers ?? {},
      ctx,
      ...(o.maxInFlight !== undefined ? { maxInFlight: o.maxInFlight } : {}),
      reserved: ['tacet/hello'],
      ...(o.onError
        ? { report: (e: unknown) => o.onError?.(e instanceof Error ? e.message : String(e)) }
        : {}),
    });
    for (const msg of early.splice(0)) peer.handle(msg);
    return {
      hello,
      call,
      closed,
      notify: out.notify,
      bufferedAmount: () => ws.bufferedAmount,
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

export interface PtyConnection {
  /** Settles when the stream ends: the server's close code and reason. */
  closed: Promise<{ code: number; reason: string }>;
  close(): void;
}

/**
 * Watch the terminal of Worker session `sessionId` on a Tacet server's `/pty/<id>` path (ADR-003
 * §5, #201): each binary frame is handed to `onData` as it comes. Rejects with an
 * `RpcClientError` whose `httpStatus` is 404 when the server has no terminal for that session.
 * The token goes in the upgrade's `Authorization` header only.
 */
export async function connectPty(o: {
  port: number;
  token: Secret;
  sessionId: string;
  onData: (chunk: Buffer) => void;
  timeoutMs?: number;
}): Promise<PtyConnection> {
  const ws = new WebSocket(`ws://127.0.0.1:${o.port}/pty/${encodeURIComponent(o.sessionId)}`, {
    headers: { authorization: `Bearer ${o.token.reveal()}` },
    perMessageDeflate: false,
    maxPayload: 16 * 1024 * 1024,
    handshakeTimeout: o.timeoutMs ?? 10_000,
  });
  let status: number | undefined;
  ws.on('unexpected-response', (_req, res) => {
    status = res.statusCode;
    res.resume();
    ws.terminate();
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString('utf8') }));
  });
  ws.on('message', (data, isBinary) => {
    if (isBinary) o.onData(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (err) =>
        reject(
          status
            ? new RpcClientError(`refused (${status})`, undefined, status)
            : new RpcClientError(`cannot connect: ${err.message}`),
        ),
      );
      ws.once('close', () =>
        reject(
          new RpcClientError(
            status ? `refused (${status})` : 'connection closed',
            undefined,
            status,
          ),
        ),
      );
    });
  } catch (err) {
    ws.terminate();
    throw err;
  }
  ws.on('error', () => {});
  return {
    closed,
    close: () => {
      if (ws.readyState === ws.OPEN) ws.close(1000);
      setTimeout(() => ws.terminate(), 2000).unref();
    },
  };
}
