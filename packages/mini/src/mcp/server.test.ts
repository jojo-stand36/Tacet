import { request } from 'node:http';
import {
  Client as ClientV2,
  StreamableHTTPClientTransport as HttpV2,
} from '@modelcontextprotocol/client';
import { Client as ClientV1 } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as HttpV1 } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { newUlid } from '@tacet/core';
import { type EventStore, openEventStore, WorkerTokens } from '@tacet/core/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventLogBackend } from './backend.js';
import { MiniMcpServer } from './server.js';
import { TOOL_NAMES } from './tools.js';

const NOW = '2026-11-09T12:00:00.000Z';

function seedTask(store: EventStore, taskId: string, budgetUsd?: number) {
  store.append({
    v: 1,
    id: newUlid(),
    ts: NOW,
    source: { kind: 'mini', id: 'mini' },
    taskId,
    type: 'task.created',
    data: {
      id: taskId,
      goal: `Goal of ${taskId}`,
      acceptanceCriteria: ['tests pass'],
      ...(budgetUsd !== undefined ? { budget: { usd: budgetUsd } } : {}),
      createdAt: NOW,
    },
  });
}

const PACKET = {
  v: 1,
  createdAt: NOW,
  goal: 'Finish it',
  acceptanceCriteria: ['tests pass'],
  stateSummary: 'Half done',
  nextAction: 'Run the tests',
  verification: { status: 'not_run' },
};

/** One call per tool, in TOOL_NAMES order. */
const CALLS: Record<(typeof TOOL_NAMES)[number], Record<string, unknown>> = {
  read_task: {},
  report_progress: { summary: 'Working on it', percent: 10 },
  escalate: { question: 'Which database?', options: ['sqlite', 'postgres'], urgency: 'normal' },
  get_decision: {}, // escalationId filled in from the escalate result
  request_handoff: { reason: 'context is full', packet: PACKET },
  record_decision: { topic: 'naming', decision: 'kebab-case files', scope: 'task' },
  search_decisions: { query: 'naming' },
};

type ToolResult = {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: unknown[];
};
type AnyClient = {
  connect(t: unknown): Promise<void>;
  listTools(): Promise<{ tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] }>;
  callTool(p: { name: string; arguments: Record<string, unknown> }): Promise<ToolResult>;
  getNegotiatedProtocolVersion?: () => string | undefined;
  close(): Promise<void>;
};
type Transport = { protocolVersion?: string | undefined };
type ClientCase = {
  client: AnyClient;
  transport: (h: Record<string, string>) => Transport;
  version: string;
};

const pinned = () =>
  new ClientV2(
    { name: 'c', version: '0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );

describe('Mini-conductor MCP server', () => {
  let store: EventStore;
  let tokens: WorkerTokens;
  let server: MiniMcpServer;
  let handoffs: string[];

  beforeEach(async () => {
    store = openEventStore(':memory:');
    tokens = new WorkerTokens();
    handoffs = [];
    seedTask(store, 'task-1', 5);
    seedTask(store, 'task-2');
    server = await MiniMcpServer.start({
      backend: new EventLogBackend({
        store,
        repo: 'repo-1',
        onHandoff: (b) => handoffs.push(b.workerSessionId),
      }),
      tokens,
    });
  });
  afterEach(async () => {
    await server.close();
    store.close();
  });

  const connect = async (binding: { workerSessionId: string; taskId: string }) => {
    const { config } = server.workerConfig(binding);
    const c = pinned();
    await c.connect(
      new HttpV2(new URL(server.url), { requestInit: { headers: config.headers ?? {} } }),
    );
    return { client: c, headers: config.headers ?? {} };
  };

  const clients: [string, () => ClientCase][] = [
    [
      'SDK v1 1.32.2 (2025-era)',
      () => ({
        client: new ClientV1({ name: 'v1', version: '0' }) as unknown as AnyClient,
        transport: (headers) => new HttpV1(new URL(server.url), { requestInit: { headers } }),
        version: '2025-11-25',
      }),
    ],
    [
      'client v2 2.4.0 pinned to 2026-07-28',
      () => ({
        client: pinned() as unknown as AnyClient,
        transport: (headers) => new HttpV2(new URL(server.url), { requestInit: { headers } }),
        version: '2026-07-28',
      }),
    ],
    [
      'client v2 2.4.0 default (2025 handshake)',
      () => ({
        client: new ClientV2({ name: 'v2-default', version: '0' }) as unknown as AnyClient,
        transport: (headers) => new HttpV2(new URL(server.url), { requestInit: { headers } }),
        version: '2025-11-25',
      }),
    ],
  ];

  it.each(clients)('%s lists the tools in order and calls every one', async (_name, make) => {
    const { config } = server.workerConfig({ workerSessionId: 'w-1', taskId: 'task-1' });
    const { client, transport, version } = make();
    const t = transport(config.headers ?? {});
    await client.connect(t);
    // No silent fallback: each client gets the protocol revision it asked for.
    expect(client.getNegotiatedProtocolVersion?.() ?? t.protocolVersion).toBe(version);
    const listed = await client.listTools();
    expect(listed.tools.map((x) => x.name)).toEqual([...TOOL_NAMES]);
    expect(listed.tools.find((x) => x.name === 'read_task')?.annotations?.readOnlyHint).toBe(true);

    const results: Record<string, Record<string, unknown> | undefined> = {};
    for (const name of TOOL_NAMES) {
      const args =
        name === 'get_decision'
          ? { escalationId: results.escalate?.escalationId as string }
          : CALLS[name];
      const r = await client.callTool({ name, arguments: args });
      expect(r.isError, name).toBeFalsy();
      results[name] = r.structuredContent;
    }
    expect(results.read_task).toMatchObject({
      goal: 'Goal of task-1',
      acceptanceCriteria: ['tests pass'],
      budgetRemaining: 5,
    });
    expect(results.report_progress).toEqual({ ack: true });
    expect(results.escalate).toMatchObject({ status: 'pending' });
    expect(results.get_decision).toEqual({ status: 'pending' });
    expect(results.request_handoff).toMatchObject({ accepted: true });
    expect(results.record_decision).toMatchObject({ status: 'recorded' });
    expect(results.search_decisions?.decisions).toEqual([
      expect.objectContaining({ topic: 'naming', scope: 'task', source: 'worker' }),
    ]);
    expect(handoffs).toEqual(['w-1']);
    await client.close();

    // The token is never written to the event log or returned in a result.
    const token = (config.headers?.Authorization ?? '').replace('Bearer ', '');
    expect(token.length).toBeGreaterThan(20);
    expect(JSON.stringify(store.query().map((e) => e.raw))).not.toContain(token);
    expect(JSON.stringify(results)).not.toContain(token);
  });

  it('answers a raw 2025-06-18 initialize (Codex and other 2025-era hosts)', async () => {
    const { config } = server.workerConfig({ workerSessionId: 'w-1', taskId: 'task-1' });
    const res = await fetch(server.url, {
      method: 'POST',
      headers: {
        ...config.headers,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'raw', version: '0' },
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('"protocolVersion":"2025-06-18"');
  });

  it('rejects missing, unknown and revoked tokens', async () => {
    const { config, revoke } = server.workerConfig({ workerSessionId: 'w-1', taskId: 'task-1' });
    const post = (headers: Record<string, string>) => fetchStatus(server.port, '/mcp', headers);
    expect(await post({})).toBe(401);
    expect(await post({ authorization: 'Bearer not-a-token' })).toBe(401);
    expect(await post(config.headers ?? {})).not.toBe(401);
    revoke();
    expect(await post(config.headers ?? {})).toBe(401);
  });

  it('makes the backend forget a Worker when its token is revoked (#122)', async () => {
    await server.close();
    const forgotten: string[] = [];
    const backend = new EventLogBackend({ store });
    const forget = backend.forget.bind(backend);
    backend.forget = (id: string) => {
      forgotten.push(id);
      forget(id);
    };
    server = await MiniMcpServer.start({ backend, tokens });
    const one = server.workerConfig({ workerSessionId: 'w-1', taskId: 'task-1' });
    server.workerConfig({ workerSessionId: 'w-2', taskId: 'task-1' });
    await backend.reportProgress({ workerSessionId: 'w-1', taskId: 'task-1' }, { summary: 'a' });
    expect(backend.workersWithState).toBe(1);
    one.revoke();
    expect(forgotten).toEqual(['w-1']);
    expect(backend.workersWithState).toBe(0);
  });

  it('answers /.well-known/* with a fast 404, without a token', async () => {
    expect(await fetchStatus(server.port, '/.well-known/oauth-protected-resource', {})).toBe(404);
    expect(await fetchStatus(server.port, '/.well-known/oauth-authorization-server/mcp', {})).toBe(
      404,
    );
  });

  it('rejects a DNS-rebinding Host and a foreign Origin, on every path', async () => {
    const { config } = server.workerConfig({ workerSessionId: 'w-1', taskId: 'task-1' });
    const headers = config.headers ?? {};
    const evil = { host: `evil.example:${server.port}` };
    expect(await fetchStatus(server.port, '/mcp', { ...headers, ...evil })).toBe(403);
    expect(await fetchStatus(server.port, '/.well-known/oauth-protected-resource', evil)).toBe(403);
    expect(await fetchStatus(server.port, '/nowhere', evil)).toBe(403);
    expect(
      await fetchStatus(server.port, '/mcp', { ...headers, origin: 'http://attacker.example' }),
    ).toBe(403);
  });

  it('refuses oversize bodies, GET/DELETE and path tricks', async () => {
    const { config } = server.workerConfig({ workerSessionId: 'w-1', taskId: 'task-1' });
    const h = config.headers ?? {};
    expect(await fetchStatus(server.port, '/mcp', h, { body: 'x'.repeat(2 * 1024 * 1024) })).toBe(
      413,
    );
    expect(await fetchStatus(server.port, '/mcp', h, { method: 'GET' })).toBe(405);
    expect(await fetchStatus(server.port, '/mcp', h, { method: 'DELETE' })).toBe(405);
    expect(await fetchStatus(server.port, '/mcp/', h)).toBe(404);
    expect(await fetchStatus(server.port, '//mcp', h)).toBe(404);
  });

  it('refuses subscriptions and closes while a client is connected', async () => {
    const { client, headers } = await connect({ workerSessionId: 'w-1', taskId: 'task-1' });
    const res = await fetch(server.url, {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'subscriptions/listen', params: {} }),
    });
    expect(await res.json()).toMatchObject({ id: 7, error: { code: -32601 } });
    // A body the SDK could read differently from the filter (here: a leading BOM) is refused.
    const bom = await fetch(server.url, {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: `\uFEFF${JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'subscriptions/listen', params: {} })}`,
    });
    expect(bom.status).toBe(400);
    expect(await bom.json()).toMatchObject({ error: { code: -32700 } });
    const closed = server.close().then(() => 'closed');
    const timeout = new Promise((r) => setTimeout(() => r('timeout'), 3000));
    expect(await Promise.race([closed, timeout])).toBe('closed');
    await client.close().catch(() => {});
    // afterEach closes the server again.
    server = await MiniMcpServer.start({ backend: new EventLogBackend({ store }), tokens });
  });

  it('keeps each worker to its own task and applies the tool policy', async () => {
    await server.close();
    server = await MiniMcpServer.start({
      backend: new EventLogBackend({ store }),
      tokens,
      policy: (tool, b) => !(tool === 'record_decision' && b.workerSessionId === 'w-2'),
    });
    const { client: one } = await connect({ workerSessionId: 'w-1', taskId: 'task-1' });
    const { client: two } = await connect({ workerSessionId: 'w-2', taskId: 'task-2' });
    const esc = await one.callTool({
      name: 'escalate',
      arguments: { question: 'q?', urgency: 'low' },
    });
    const escalationId = (esc.structuredContent as { escalationId: string }).escalationId;
    // Another task's worker cannot read it.
    const peek = await two.callTool({ name: 'get_decision', arguments: { escalationId } });
    expect(peek.isError).toBe(true);
    expect(
      (await two.callTool({ name: 'read_task', arguments: {} })).structuredContent,
    ).toMatchObject({ goal: 'Goal of task-2', budgetRemaining: null });
    // Policy: w-2 may not record decisions, and does not even see the tool.
    expect((await two.listTools()).tools.map((t) => t.name)).not.toContain('record_decision');
    expect((await one.listTools()).tools.map((t) => t.name)).toContain('record_decision');
    await expect(
      two.callTool({
        name: 'record_decision',
        arguments: { topic: 't', decision: 'd', scope: 'task' },
      }),
    ).rejects.toThrow(/not found/);
    await one.close();
    await two.close();
  });

  it('never echoes internal errors or the token in error results', async () => {
    const errors: string[] = [];
    await server.close();
    const backend = new EventLogBackend({ store });
    backend.searchDecisions = async () => {
      throw new Error('database file /secret/path is locked');
    };
    server = await MiniMcpServer.start({ backend, tokens, onError: (m) => errors.push(m) });
    const { client, headers } = await connect({ workerSessionId: 'w-1', taskId: 'task-1' });
    const token = (headers.Authorization ?? '').replace('Bearer ', '');
    const failed = await client.callTool({ name: 'search_decisions', arguments: { query: 'x' } });
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed)).not.toContain('/secret/path');
    expect(errors).toEqual([expect.stringContaining('/secret/path')]);
    const unknown = await client.callTool({
      name: 'get_decision',
      arguments: { escalationId: 'nope' },
    });
    expect(unknown.isError).toBe(true);
    expect(JSON.stringify([failed, unknown, errors])).not.toContain(token);
    await client.close();
  });
});

function fetchStatus(
  port: number,
  path: string,
  headers: Record<string, string>,
  opts: { method?: string; body?: string } = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const method = opts.method ?? 'POST';
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...headers,
        },
      },
      // Settles only once the response has ended, so a refusal that never finishes fails here.
      (res) => {
        res.resume();
        res.once('end', () => resolve(res.statusCode ?? 0));
        res.once('error', reject);
      },
    );
    // Any error before the response ends (e.g. a reset instead of an answer) fails the call.
    req.on('error', reject);
    if (method === 'GET' || method === 'DELETE') req.end();
    else
      req.end(
        opts.body ?? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      );
  });
}
