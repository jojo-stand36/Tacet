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

type AnyClient = {
  connect(t: unknown): Promise<void>;
  listTools(): Promise<{ tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] }>;
  callTool(p: { name: string; arguments: Record<string, unknown> }): Promise<{
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    content?: unknown[];
  }>;
  close(): Promise<void>;
};

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

  const clients: [
    string,
    () => { client: AnyClient; transport: (h: Record<string, string>) => unknown },
  ][] = [
    [
      'SDK v1 1.32.2 (2025-era)',
      () => ({
        client: new ClientV1({ name: 'v1', version: '0' }) as unknown as AnyClient,
        transport: (headers) => new HttpV1(new URL(server.url), { requestInit: { headers } }),
      }),
    ],
    [
      'client v2 2.4.0 pinned to 2026-07-28',
      () => ({
        client: new ClientV2(
          { name: 'v2-pin', version: '0' },
          { versionNegotiation: { mode: { pin: '2026-07-28' } } },
        ) as unknown as AnyClient,
        transport: (headers) => new HttpV2(new URL(server.url), { requestInit: { headers } }),
      }),
    ],
    [
      'client v2 2.4.0 default (2025 handshake)',
      () => ({
        client: new ClientV2({ name: 'v2-default', version: '0' }) as unknown as AnyClient,
        transport: (headers) => new HttpV2(new URL(server.url), { requestInit: { headers } }),
      }),
    ],
  ];

  it.each(clients)('%s lists the tools in order and calls every one', async (_name, make) => {
    const { config } = server.workerConfig({ workerSessionId: 'w-1', taskId: 'task-1' });
    const { client, transport } = make();
    await client.connect(transport(config.headers ?? {}));
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    expect(listed.tools.find((t) => t.name === 'read_task')?.annotations?.readOnlyHint).toBe(true);

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

    // The token is never written to the event log.
    const token = (config.headers?.Authorization ?? '').replace('Bearer ', '');
    expect(token.length).toBeGreaterThan(20);
    expect(JSON.stringify(store.query().map((e) => e.raw))).not.toContain(token);
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

  it('answers /.well-known/* with a fast 404, without a token', async () => {
    expect(await fetchStatus(server.port, '/.well-known/oauth-protected-resource', {})).toBe(404);
    expect(await fetchStatus(server.port, '/.well-known/oauth-authorization-server/mcp', {})).toBe(
      404,
    );
  });

  it('rejects a DNS-rebinding Host and a foreign Origin', async () => {
    const { config } = server.workerConfig({ workerSessionId: 'w-1', taskId: 'task-1' });
    const headers = config.headers ?? {};
    expect(
      await fetchStatus(server.port, '/mcp', { ...headers, host: `evil.example:${server.port}` }),
    ).toBe(403);
    expect(
      await fetchStatus(server.port, '/mcp', { ...headers, origin: 'http://attacker.example' }),
    ).toBe(403);
  });

  it('keeps each worker to its own task and applies the tool policy', async () => {
    await server.close();
    server = await MiniMcpServer.start({
      backend: new EventLogBackend({ store }),
      tokens,
      policy: (tool, b) => !(tool === 'record_decision' && b.workerSessionId === 'w-2'),
    });
    const connect = async (binding: { workerSessionId: string; taskId: string }) => {
      const { config } = server.workerConfig(binding);
      const c = new ClientV2(
        { name: 'c', version: '0' },
        { versionNegotiation: { mode: { pin: '2026-07-28' } } },
      );
      await c.connect(
        new HttpV2(new URL(server.url), { requestInit: { headers: config.headers ?? {} } }),
      );
      return c;
    };
    const one = await connect({ workerSessionId: 'w-1', taskId: 'task-1' });
    const two = await connect({ workerSessionId: 'w-2', taskId: 'task-2' });
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
    ).toMatchObject({
      goal: 'Goal of task-2',
      budgetRemaining: null,
    });
    // Policy: w-2 may not record decisions.
    const denied = await two.callTool({
      name: 'record_decision',
      arguments: { topic: 't', decision: 'd', scope: 'task' },
    });
    expect(denied.isError).toBe(true);
    await one.close();
    await two.close();
  });
});

function fetchStatus(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...headers,
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
  });
}
