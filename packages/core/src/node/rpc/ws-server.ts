import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { type RawData, type WebSocket, WebSocketServer } from 'ws';
import { HelloGate, type HelloInfo } from '../auth/hello.js';
import { listenLoopback } from '../auth/listen.js';
import { checkHostAndOrigin } from '../auth/origin.js';
import { checkBearer, type Secret } from '../auth/secret.js';

/** A JSON-RPC error a handler throws to answer with that code; its message goes to the client. */
export class RpcError extends Error {
  override name = 'RpcError';
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

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
}

export interface RpcServer {
  port: number;
  /** The addresses listened on: loopback only (ADR-003 §3.1). */
  addresses(): string[];
  close(): Promise<void>;
}

const MAX_PAYLOAD = 1024 * 1024;

/** Refuse an upgrade before any WebSocket is made: status line only, no body that could echo. */
function refuse(socket: Duplex, status: 401 | 403 | 404): void {
  const text = { 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found' }[status];
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
    if (req.url !== '/') return refuse(socket, 404);
    if (!checkBearer(req.headers.authorization, o.token)) return refuse(socket, 401);
    wss.handleUpgrade(req, socket, head, (ws) => serve(ws));
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
        ctx = { sessionId: '', hello };
      },
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
        return;
      }
      if (isBinary || !ctx) {
        ws.close(1003, 'text frames only');
        return;
      }
      void dispatch(data.toString('utf8'), ctx).then((reply) => reply && send(reply));
    });
  };

  const dispatch = async (frame: string, ctx: RpcContext) => {
    let msg: unknown;
    try {
      msg = JSON.parse(frame);
    } catch {
      return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } };
    }
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } };
    }
    const { jsonrpc, id, method, params } = msg as Record<string, unknown>;
    const notification = id === undefined;
    const rpcId = typeof id === 'string' || typeof id === 'number' ? id : null;
    const error = (code: number, message: string) =>
      notification ? undefined : { jsonrpc: '2.0', id: rpcId, error: { code, message } };
    if (jsonrpc !== '2.0' || typeof method !== 'string' || (!notification && rpcId === null)) {
      return error(-32600, 'invalid request');
    }
    if (method === 'tacet/hello') return error(-32600, 'already said hello');
    const handler = Object.hasOwn(o.handlers, method) ? o.handlers[method] : undefined;
    if (!handler) return error(-32601, `method not found: ${method}`);
    try {
      const result = await handler(params, ctx);
      return notification ? undefined : { jsonrpc: '2.0', id: rpcId, result: result ?? null };
    } catch (err) {
      if (err instanceof RpcError) return error(err.code, err.message);
      // Internal errors can name paths or state: the client gets a generic message.
      report(err);
      return error(-32603, 'internal error');
    }
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
