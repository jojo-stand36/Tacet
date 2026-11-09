import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import type { McpServerConfig } from '@tacet/core';
import {
  checkHostAndOrigin,
  type LoopbackListener,
  listenLoopback,
  mcpAuthHeaders,
  type WorkerBinding,
  type WorkerTokens,
} from '@tacet/core/node';
import { type MiniBackend, ToolError } from './backend.js';
import { TOOL_NAMES, type ToolName, ToolSchemas } from './tools.js';

/** Decides whether a worker may call a tool (per-tool policy gating). Default: all v1 tools. */
export type ToolPolicy = (tool: ToolName, binding: WorkerBinding) => boolean;

export interface MiniMcpServerOptions {
  backend: MiniBackend;
  tokens: WorkerTokens;
  policy?: ToolPolicy;
  /** Server name in the MCP handshake. Default `tacet-mini`. */
  name?: string;
  /** Largest request body accepted, in bytes. Default 1 MiB. */
  maxBodyBytes?: number;
  /** Told about internal failures (message only; never headers or bodies). */
  onError?: (message: string) => void;
}

const VERSION = '0.0.0';
const PENDING_TEXT =
  'Escalation pending. Continue independent work, or end your turn if you are blocked; the answer will arrive as your next message. You can also check it with get_decision.';

/**
 * The tools for one caller, bound to that caller's identity. The tools take no task or worker
 * argument; `binding` comes from the per-worker token (ADR-003 §6).
 */
export function buildToolServer(binding: WorkerBinding, opts: MiniMcpServerOptions): McpServer {
  const server = new McpServer(
    { name: opts.name ?? 'tacet-mini', version: VERSION },
    // The tool list never changes during a request, so no change notifications.
    { capabilities: { tools: { listChanged: false } } },
  );
  const b = opts.backend;
  const run = {
    read_task: () => b.readTask(binding),
    report_progress: (i: never) => b.reportProgress(binding, i),
    escalate: (i: never) => b.escalate(binding, i),
    get_decision: (i: never) => b.getDecision(binding, i),
    request_handoff: (i: never) => b.requestHandoff(binding, i),
    record_decision: (i: never) => b.recordDecision(binding, i),
    search_decisions: (i: never) => b.searchDecisions(binding, i),
  } satisfies Record<ToolName, (i: never) => Promise<unknown>>;

  const allowed = (name: ToolName) => opts.policy?.(name, binding) ?? true;
  for (const name of TOOL_NAMES) {
    // A tool the policy refuses is not even listed; the call-time check below stays as a guard.
    if (!allowed(name)) continue;
    const spec = ToolSchemas[name];
    server.registerTool(
      name,
      {
        description: spec.description,
        inputSchema: spec.input,
        outputSchema: spec.output,
        annotations: {
          readOnlyHint: spec.readOnly,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      async (args: unknown) => {
        if (!allowed(name)) {
          return failure(`${name} is not allowed for this worker`);
        }
        try {
          const out = (await (run[name] as (i: unknown) => Promise<unknown>)(args)) as Record<
            string,
            unknown
          >;
          const text =
            name === 'escalate' && out.status === 'pending' ? PENDING_TEXT : JSON.stringify(out);
          return { content: [{ type: 'text' as const, text }], structuredContent: out };
        } catch (err) {
          if (err instanceof ToolError) return failure(err.message, err.detail);
          // Internal errors are not described to the worker: they could carry anything.
          opts.onError?.(`${name}: ${err instanceof Error ? err.message : String(err)}`);
          return failure(`${name} failed inside the Mini-conductor`);
        }
      },
    );
  }
  return server;
}

function failure(message: string, detail?: Record<string, unknown>) {
  return {
    isError: true,
    content: [
      { type: 'text' as const, text: detail ? `${message}\n${JSON.stringify(detail)}` : message },
    ],
  };
}

/** Request headers for the SDK, without `authorization`: the SDK never holds the token. */
function toHeaders(raw: IncomingMessage['headers']): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined || k === 'authorization') continue;
    for (const one of Array.isArray(v) ? v : [v]) h.append(k, one);
  }
  return h;
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/**
 * The Mini-conductor's MCP endpoint: Streamable HTTP at `http://127.0.0.1:<port>/mcp`
 * (ADR-003 §6), answering 2026-07-28 and 2025-era clients through the SDK's defaults (spike #69,
 * ADR-003 addendum for #18). Every request needs a valid per-worker bearer token and passes the
 * Host/Origin checks (ADR-003 §3.5). `/.well-known/*` gets a fast 404, because Codex probes OAuth
 * discovery there (#68).
 */
export class MiniMcpServer {
  readonly #opts: MiniMcpServerOptions;
  readonly #listener: LoopbackListener;
  readonly #handler: McpHandler;

  private constructor(opts: MiniMcpServerOptions, listener: LoopbackListener, handler: McpHandler) {
    this.#opts = opts;
    this.#listener = listener;
    this.#handler = handler;
  }

  static async start(opts: MiniMcpServerOptions): Promise<MiniMcpServer> {
    // Identity is resolved by the HTTP layer and handed to the SDK as `authInfo` (worker session
    // as clientId, task as a scope). The token itself is stripped from the request and replaced by
    // a placeholder, so no SDK object ever holds it.
    const handler = createMcpHandler(
      (ctx) => {
        const binding = fromAuthInfo(ctx.authInfo);
        if (!binding) throw new Error('unauthenticated');
        return buildToolServer(binding, opts);
      },
      // The tool surface uses no subscriptions (ADR-003 §6); `serve` rejects them, and this caps
      // them should one get through.
      { maxSubscriptions: 1 },
    );
    let port = 0;
    const listener = await listenLoopback(() =>
      createServer((req, res) => {
        serve(req, res, port, opts, handler).catch((err: unknown) => {
          opts.onError?.(`request failed: ${err instanceof Error ? err.message : String(err)}`);
          if (!res.headersSent) reply(res, 500, { error: 'internal error' });
          else res.destroy();
        });
      }),
    );
    port = listener.port;
    return new MiniMcpServer(opts, listener, handler);
  }

  get port(): number {
    return this.#listener.port;
  }

  /** Dial 127.0.0.1, never `localhost` (which may resolve to ::1 only). */
  get url(): string {
    return `http://127.0.0.1:${this.#listener.port}/mcp`;
  }

  /**
   * Mint a worker's MCP config for an adapter's `SessionOptions.mcpServers`, and a `revoke` to
   * call when the session closes. The token is only in the returned headers.
   */
  workerConfig(binding: WorkerBinding): { config: McpServerConfig; revoke: () => void } {
    const token = this.#opts.tokens.mint(binding);
    return {
      config: { name: 'tacet', url: this.url, headers: mcpAuthHeaders(token) },
      revoke: () => void this.#opts.tokens.revoke(binding.workerSessionId),
    };
  }

  /** Stop serving: aborts in-flight exchanges and drops open connections, then unbinds. */
  async close(): Promise<void> {
    await this.#handler.close();
    for (const s of this.#listener.servers) (s as Server).closeAllConnections();
    await this.#listener.close();
  }
}

type McpHandler = ReturnType<typeof createMcpHandler>;

async function serve(
  req: IncomingMessage,
  res: ServerResponse,
  port: number,
  opts: MiniMcpServerOptions,
  handler: McpHandler,
): Promise<void> {
  const check = checkHostAndOrigin(
    { host: req.headers.host, origin: req.headers.origin },
    port,
    'bearer',
  );
  if (!check.ok) return reply(res, check.httpStatus, { error: check.reason });
  const path = (req.url ?? '/').split('?')[0] ?? '/';
  if (path.startsWith('/.well-known/')) return reply(res, 404, { error: 'not found' });
  if (path !== '/mcp') return reply(res, 404, { error: 'not found' });
  const binding = opts.tokens.resolveHeader(req.headers.authorization);
  if (!binding) return reply(res, 401, { error: 'invalid or missing worker token' });
  // POST only: the tools need no server-to-client stream (GET would open one that never ends)
  // and no session to delete. Clients treat 405 on GET as "no stream offered".
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' });
    return void res.end();
  }

  const limit = opts.maxBodyBytes ?? 1024 * 1024;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) {
      // The rest of the body is never read, so this connection cannot carry another request.
      res.setHeader('connection', 'close');
      reply(res, 413, { error: 'request too large' });
      res.once('finish', () => req.destroy());
      return;
    }
    chunks.push(c as Buffer);
  }
  const body = Buffer.concat(chunks);
  if (wantsSubscription(body)) {
    return reply(res, 200, {
      jsonrpc: '2.0',
      id: requestId(body),
      error: { code: -32601, message: 'subscriptions are not offered by this server' },
    });
  }
  // The exchange ends when the client goes away.
  const abort = new AbortController();
  res.once('close', () => abort.abort());
  const request = new Request(`http://127.0.0.1:${port}${req.url ?? '/mcp'}`, {
    method: 'POST',
    headers: toHeaders(req.headers),
    signal: abort.signal,
    body,
  });
  const response = await handler.fetch(request, { authInfo: toAuthInfo(binding) });
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) return void res.end();
  await pipeline(
    Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
    res,
  ).catch(() => {
    // The client went away mid-stream; nothing left to answer.
  });
}

const TASK_SCOPE = 'tacet-task:';

function toAuthInfo(b: WorkerBinding) {
  return { token: '[redacted]', clientId: b.workerSessionId, scopes: [`${TASK_SCOPE}${b.taskId}`] };
}

function fromAuthInfo(
  info: { clientId?: string; scopes?: string[] } | undefined,
): WorkerBinding | undefined {
  const scope = info?.scopes?.find((x) => x.startsWith(TASK_SCOPE));
  if (!info?.clientId || !scope) return undefined;
  return { workerSessionId: info.clientId, taskId: scope.slice(TASK_SCOPE.length) };
}

function parse(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return undefined;
  }
}

function wantsSubscription(body: Buffer): boolean {
  const msg = parse(body);
  const all = Array.isArray(msg) ? msg : [msg];
  return all.some(
    (m) =>
      typeof m === 'object' &&
      m !== null &&
      (m as { method?: unknown }).method === 'subscriptions/listen',
  );
}

function requestId(body: Buffer): unknown {
  const msg = parse(body);
  return typeof msg === 'object' && msg !== null && !Array.isArray(msg)
    ? ((msg as { id?: unknown }).id ?? null)
    : null;
}
