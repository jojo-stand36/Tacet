import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeSdkAdapter } from '@tacet/adapter-claude-sdk';
import { type MockMessagesApi, startMockMessagesApi } from '@tacet/adapter-claude-sdk/testing';
import { newUlid } from '@tacet/core';
import { type EventStore, openEventStore, WorkerTokens } from '@tacet/core/node';
import { EventTap } from '@tacet/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventLogBackend } from './backend.js';
import { MiniMcpServer } from './server.js';

/**
 * A real Claude Code Worker (bundled with the Claude Agent SDK) calls the Mini-conductor's
 * `escalate` tool over Streamable HTTP with its per-worker token. The model is a local mock of
 * the Messages API: no credentials, no network.
 */
describe('a real Claude Worker calls escalate (#18 acceptance)', () => {
  let api: MockMessagesApi;
  let root: string;
  let store: EventStore;
  let server: MiniMcpServer;

  beforeAll(async () => {
    api = await startMockMessagesApi();
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tacet-mini-claude-')));
    mkdirSync(join(root, 'worktree'));
    mkdirSync(join(root, 'home'));
    store = openEventStore(':memory:');
    store.append({
      v: 1,
      id: newUlid(),
      ts: new Date().toISOString(),
      source: { kind: 'mini', id: 'mini' },
      taskId: 'task-1',
      type: 'task.created',
      data: {
        id: 'task-1',
        goal: 'Add a cache',
        acceptanceCriteria: ['tests pass'],
        createdAt: new Date().toISOString(),
      },
    });
    server = await MiniMcpServer.start({
      backend: new EventLogBackend({ store, repo: 'repo-1' }),
      tokens: new WorkerTokens(),
    });
  });

  afterAll(async () => {
    await server?.close();
    store?.close();
    await api?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('reaches the Mini-conductor and records the escalation under its own identity', {
    timeout: 120_000,
  }, async () => {
    const home = join(root, 'home');
    const adapter = new ClaudeSdkAdapter({
      authRoute: 'api_key',
      baseEnv: {
        PATH: process.env.PATH,
        HOME: home,
        CLAUDE_CONFIG_DIR: join(home, '.claude'),
        ANTHROPIC_BASE_URL: api.url,
        ANTHROPIC_API_KEY: 'placeholder-not-a-real-key',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
      mcpConfigDir: join(root, 'run', 'mcp'),
      sdkOptions: { settingSources: [] },
    });
    const { config, revoke } = server.workerConfig({
      workerSessionId: 'worker-1',
      taskId: 'task-1',
    });
    const h = await adapter.start({
      cwd: join(root, 'worktree'),
      model: 'claude-sonnet-5-5',
      mcpServers: [config],
    });
    const tap = new EventTap(adapter.events(h));
    await adapter.send(h, { text: 'ESCALATE' });

    // Claude Code asks before using an MCP tool; the Mini-conductor allows it.
    const req = await tap.waitFor((e) => e.t === 'approval.request', 60_000);
    if (req.event.t !== 'approval.request') throw new Error('unreachable');
    expect(req.event.toolName).toBe('mcp__tacet__escalate');
    await adapter.respond(h, req.event.id, { kind: 'allow_once', persist: false });

    const result = await tap.waitFor((e) => e.t === 'tool.result', 60_000, req.index);
    expect(result.event).toMatchObject({ ok: true });
    await tap.waitFor((e) => e.t === 'status' && e.state === 'idle', 60_000, result.index);
    await adapter.close(h);
    revoke();

    const raised = store.query({ typePrefix: 'escalation.raised' });
    expect(raised).toHaveLength(1);
    expect(raised[0]?.envelope).toMatchObject({
      taskId: 'task-1',
      sessionId: 'worker-1',
      data: {
        question: 'Which database should the cache use?',
        urgency: 'normal',
        status: 'pending',
      },
    });
    // Claude Code 2.1.319 defers MCP tools behind ToolSearch (not in the first request's tool
    // list); calling one by its `mcp__<server>__<tool>` name still works.
    expect(api.requests[0]?.tools).toContain('ToolSearch');
    expect(api.requests[0]?.tools).not.toContain('mcp__tacet__escalate');
  });
});
