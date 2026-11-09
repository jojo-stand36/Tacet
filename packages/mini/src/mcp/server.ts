import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
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
    { capabilities: { tools: {} } },
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

  for (const name of TOOL_NAMES) {
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
        if (!(opts.policy?.(name, binding) ?? true)) {
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

function toHeaders(raw: IncomingMessage['headers']): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
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

  private constructor(opts: MiniMcpServerOptions, listener: LoopbackListener) {
    this.#opts = opts;
    this.#listener = listener;
  }

  static async start(opts: MiniMcpServerOptions): Promise<MiniMcpServer> {
    const handler = createMcpHandler((ctx) => {
      // The HTTP layer already checked the token; resolve it again from the request itself, so the
      // identity never travels through any other object.
      const binding = opts.tokens.resolveHeader(ctx.requestInfo?.headers.get('authorization'));
      if (!binding) throw new Error('unauthenticated');
      return buildToolServer(binding, opts);
    });
    let port = 0;
    const listener = await listenLoopback(() =>
      createServer((req, res) => {
        serve(req, res, port, opts, handler).catch(() => {
          if (!res.headersSent) reply(res, 500, { error: 'internal error' });
          else res.destroy();
        });
      }),
    );
    port = listener.port;
    return new MiniMcpServer(opts, listener);
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

  close(): Promise<void> {
    return this.#listener.close();
  }
}

async function serve(
  req: IncomingMessage,
  res: ServerResponse,
  port: number,
  opts: MiniMcpServerOptions,
  handler: ReturnType<typeof createMcpHandler>,
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
  if (!opts.tokens.resolveHeader(req.headers.authorization)) {
    return reply(res, 401, { error: 'invalid or missing worker token' });
  }

  const limit = opts.maxBodyBytes ?? 1024 * 1024;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) return reply(res, 413, { error: 'request too large' });
    chunks.push(c as Buffer);
  }
  const method = req.method ?? 'GET';
  const request = new Request(`http://127.0.0.1:${port}${req.url ?? '/mcp'}`, {
    method,
    headers: toHeaders(req.headers),
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: Buffer.concat(chunks) }),
  });
  const response = await handler.fetch(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) return void res.end();
  Readable.fromWeb(response.body as import('node:stream/web').ReadableStream).pipe(res);
}
