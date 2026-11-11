import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { type RawData, type WebSocket, WebSocketServer } from 'ws';
import { HelloGate, type HelloInfo } from '../auth/hello.js';
import { listenLoopback } from '../auth/listen.js';
import { checkHostAndOrigin } from '../auth/origin.js';
import { checkBearer, type Secret } from '../auth/secret.js';
import { incoming, isResponse, outgoing, parseFrame, RpcCallError, RpcError } from './peer.js';

export { RpcError };

export interface RpcContext {
  /** The session id `tacet/hello` returned on this socket. */
  sessionId: string;
  hello: HelloInfo;
}

/** Handles one method. Throw `RpcError` for a JSON-RPC error; anything else is `-32603`. */
export type RpcHandler = (params: unknown, ctx: RpcContext) => unknown;

export interface RpcServerOptions {
  /** The daemon token every upgrade must carry as `Authorization: Bearer` (ADR-003 §3.3). */
  token: Secret;
  /** Methods served after `tacet/hello`, by name. */
  handlers: Readonly<Record<string, RpcHandler>>;
  serverInfo: { name: string; version: string };
  /** Tacet protocol majors served. Default `[1]`. */
  versions?: number[];
  capabilities?: Record<string, unknown>;
  /** Largest frame accepted, in bytes; a larger one closes the socket (1009). Default 1 MiB. */
  maxPayload?: number;
  /** Told about handler failures, by message only (never a request's params or headers). */
  onError?: (message: string) => void;
  /** Hello roles accepted. Default `cli` and `mini`; `ui` is never served here. */
  roles?: readonly ('cli' | 'mini')[];
  /** Milliseconds a socket may take to say hello before it is closed. Default 10000. */
  helloTimeoutMs?: number;
  /** Requests one socket may have in flight; more get `-32000`. Default 32. */
  maxInFlight?: number;
  /**
   * Notifications one socket may have queued; past this its reads pause until they drain (never
   * an answer, never a drop). Default 16.
   */
  maxQueued?: number;
  /**
   * A live byte stream for `/pty/<id>` (ADR-003 §5, #201): the terminal of the Worker session
   * `id`, or undefined when there is none (404). The upgrade passes the same Host, Origin and
   * bearer checks as `/`, and no hello is said: the socket carries the stream's chunks, as binary
   * frames, from server to client only. It closes 1000 when the stream ends; a frame from the
   * client closes it 1003. The stream is pulled only as fast as the client reads it. `left` aborts
   * when the client goes: the producer must then let go of what it holds, even mid-wait.
   */
  pty?: (id: string, left: AbortSignal) => AsyncIterable<Uint8Array> | undefined;
  /** `/pty` sockets open at once; more are refused (503). Default 8. */
  maxPtySockets?: number;
  /** Told about each connection once its hello is answered (#23). */
  onConnection?: (conn: RpcConnection) => void;
}

/**
 * One client connection after its `tacet/hello` (#23): what a daemon needs to keep a registry of
 * its peers, such as the Conductor's Mini-conductors.
 */
export interface RpcConnection {
  readonly sessionId: string;
  readonly hello: HelloInfo;
  /** Close it with a WebSocket close code (e.g. 4409) and a short reason. */
  close(code: number, reason: string): void;
  /** Drop it at once, without the closing handshake: for a peer that no longer answers. */
  terminate(): void;
  /** Send a WebSocket ping; true when the pong comes back within `timeoutMs`. */
  ping(timeoutMs: number): Promise<boolean>;
  /** Settles when the socket is gone, with its close code. */
  readonly closed: Promise<{ code: number; reason: string }>;
  /**
   * Call a method the client serves on this socket (#24, ADR-003 §4: after the hello either side
   * may send requests). Rejects with an `RpcCallError`: the client's error, a timeout (default
   * 10 s), or the socket closing.
   */
  call(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<unknown>;
  /** Send the client a notification; resolves once it is handed to the socket. */
  notify(method: string, params?: unknown): Promise<void>;
}

export interface RpcServer {
  port: number;
  /** The addresses listened on: loopback only (ADR-003 §3.1). */
  addresses(): string[];
  close(): Promise<void>;
}

const MAX_PAYLOAD = 1024 * 1024;
/** A `/pty/<id>` path: the id is a Worker session id, so a short token of safe characters. */
const PTY_PATH = /^\/pty\/([A-Za-z0-9._-]{1,128})$/;

/** Refuse an upgrade before any WebSocket is made: status line only, no body that could echo. */
function refuse(socket: Duplex, status: 401 | 403 | 404 | 503): void {
  const text = {
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    503: 'Service Unavailable',
  }[status];
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * A Tacet JSON-RPC server over WebSocket (ADR-003 §1, §3), as a daemon's port for the CLI: bound
 * to 127.0.0.1 and ::1 only, on an OS-assigned port. Each upgrade is checked before a WebSocket is
 * made: the `Host` must be a loopback name with this port and any `Origin` this daemon's own
 * (DNS-rebinding and browser defence), and the bearer token must match, compared in constant time.
 * The first frame must then be `tacet/hello`; only `cli` and `mini` roles are accepted (no browser
 * sessions here). Requests are JSON-RPC 2.0, one per text frame, answered in any order.
 */
export async function startRpcServer(o: RpcServerOptions): Promise<RpcServer> {
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: o.maxPayload ?? MAX_PAYLOAD,
  });
  const report = (err: unknown) => o.onError?.(err instanceof Error ? err.message : String(err));

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    const port = req.socket.localPort ?? 0;
    const check = checkHostAndOrigin(
      { host: req.headers.host, origin: req.headers.origin },
      port,
      'bearer',
    );
    if (!check.ok) return refuse(socket, check.httpStatus);
    // The token before the path, so nobody without it learns which session ids exist.
    if (!checkBearer(req.headers.authorization, o.token)) return refuse(socket, 401);
    if (req.url === '/') {
      wss.handleUpgrade(req, socket, head, (ws) => serve(ws));
      return;
    }
    const id = o.pty ? PTY_PATH.exec(req.url ?? '')?.[1] : undefined;
    if (id === undefined) return refuse(socket, 404);
    if (ptySockets >= (o.maxPtySockets ?? 8)) return refuse(socket, 503);
    // Told when the viewer goes, so the stream's producer lets go even while it waits.
    const left = new AbortController();
    const stream = o.pty?.(id, left.signal);
    if (!stream) return refuse(socket, 404);
    // The slot is the connection's, freed when it closes, even if the upgrade never completes.
    ptySockets++;
    socket.once('close', () => {
      ptySockets--;
      left.abort();
    });
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.once('close', () => left.abort());
      void streamTo(ws, stream);
    });
  };
  let ptySockets = 0;

  /** Send `stream` until it ends or the client goes; each chunk once the last one is written. */
  const streamTo = async (ws: WebSocket, stream: AsyncIterable<Uint8Array>) => {
    const it = stream[Symbol.asyncIterator]();
    let gone = false;
    ws.on('error', () => ws.terminate());
    ws.on('message', () => ws.close(1003, 'read only'));
    ws.once('close', () => {
      gone = true;
      // Let the stream's producer let go of what it holds.
      void it.return?.();
    });
    try {
      for (;;) {
        const next = await it.next();
        if (gone) return;
        if (next.done) break;
        // Backpressure: the next chunk is pulled only once this one is handed to the socket.
        const sent = await new Promise<boolean>((resolve) =>
          ws.send(next.value, { binary: true }, (err) => resolve(!err)),
        );
        if (!sent || gone) return;
      }
      ws.close(1000, 'session ended');
    } catch (err) {
      report(err);
      if (!gone) ws.close(1011, 'stream failed');
    }
  };

  const serve = (ws: WebSocket) => {
    let ctx: RpcContext | undefined;
    const gate = new HelloGate({
      versions: o.versions ?? [1],
      serverInfo: o.serverInfo,
      ...(o.capabilities ? { capabilities: o.capabilities } : {}),
      newSessionId: randomUUID,
      // The upgrade carried the daemon token; a `ui` hello is still refused (no session verifier).
      upgradeAuth: 'bearer',
      onHello: (hello) => {
        // A throw here closes the socket ("hello rejected").
        if (!(o.roles ?? ['cli', 'mini']).includes(hello.role as 'cli' | 'mini')) {
          throw new Error('role not served');
        }
        ctx = { sessionId: '', hello };
      },
    });
    // Requests this side sends on the socket (#24), and what the client sends.
    const out = outgoing(ws, 10_000);
    let peer: ReturnType<typeof incoming<RpcContext>> | undefined;
    const helloTimer = setTimeout(() => {
      if (!ctx?.sessionId) ws.close(1008, 'no hello');
    }, o.helloTimeoutMs ?? 10_000);
    helloTimer.unref();
    ws.on('close', (code: number) => {
      clearTimeout(helloTimer);
      out.failAll(new RpcCallError(`connection closed (${code})`));
    });
    const send = (msg: unknown) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    };
    ws.on('error', () => ws.terminate());
    ws.on('message', (data: RawData, isBinary: boolean) => {
      const action = isBinary ? gate.handleBinary() : gate.handle(data.toString('utf8'));
      if (action.kind === 'close') {
        if (action.message) send(action.message);
        ws.close(action.code, action.reason);
        return;
      }
      if (action.kind === 'reply') {
        if (ctx) ctx.sessionId = action.message.result.sessionId;
        send(action.message);
        if (ctx) {
          peer = incoming(ws, {
            handlers: o.handlers,
            ctx,
            ...(o.maxInFlight !== undefined ? { maxInFlight: o.maxInFlight } : {}),
            ...(o.maxQueued !== undefined ? { maxQueued: o.maxQueued } : {}),
            reserved: ['tacet/hello'],
            report,
          });
        }
        if (ctx && o.onConnection) {
          try {
            o.onConnection(connection(ws, ctx, out));
          } catch (err) {
            report(err);
          }
        }
        return;
      }
      if (isBinary || !ctx) {
        ws.close(1003, 'text frames only');
        return;
      }
      const msg = parseFrame(data);
      // An answer to a request this side sent: matched by id, never dispatched. One that answers
      // nothing of ours is dropped (JSON-RPC never answers a response).
      if (msg && isResponse(msg)) {
        out.settle(msg);
        return;
      }
      peer?.handle(msg);
    });
  };

  const connection = (
    ws: WebSocket,
    ctx: RpcContext,
    out: ReturnType<typeof outgoing>,
  ): RpcConnection => {
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      if (ws.readyState === ws.CLOSED) resolve({ code: 1006, reason: '' });
      ws.once('close', (code: number, reason: Buffer) =>
        resolve({ code, reason: reason.toString('utf8') }),
      );
    });
    return {
      sessionId: ctx.sessionId,
      hello: ctx.hello,
      closed,
      close: (code, reason) => {
        if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(code, reason);
      },
      terminate: () => ws.terminate(),
      call: out.call,
      notify: out.notify,
      ping: (timeoutMs) =>
        new Promise<boolean>((resolve) => {
          if (ws.readyState !== ws.OPEN) return resolve(false);
          const done = (ok: boolean) => {
            clearTimeout(timer);
            ws.off('pong', onPong);
            resolve(ok);
          };
          const onPong = () => done(true);
          const timer = setTimeout(() => done(false), timeoutMs);
          timer.unref();
          ws.once('pong', onPong);
          ws.ping();
        }),
    };
  };

  const listener = await listenLoopback(() => {
    const server = createServer((_req, res) => {
      // Only WebSocket upgrades are served.
      res.writeHead(426, { connection: 'close', 'content-length': '0' }).end();
    });
    server.on('upgrade', onUpgrade);
    return server;
  });
  let closed: Promise<void> | undefined;
  return {
    port: listener.port,
    addresses: () =>
      listener.servers.flatMap((s) => {
        const a = s.address();
        return a && typeof a !== 'string' ? [a.address] : [];
      }),
    close: () => {
      closed ??= (async () => {
        for (const ws of wss.clients) ws.close(1001, 'server closing');
        await new Promise<void>((r) => wss.close(() => r()));
        for (const ws of wss.clients) ws.terminate();
        for (const s of listener.servers)
          (s as ReturnType<typeof createServer>).closeAllConnections?.();
        await listener.close();
      })();
      return closed;
    },
  };
}
