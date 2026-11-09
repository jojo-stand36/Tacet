import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAppServerAdapter } from '@tacet/adapter-codex-app-server';
import {
  type MockResponsesApi,
  startMockResponsesApi,
} from '@tacet/adapter-codex-app-server/testing';
import { newUlid } from '@tacet/core';
import { type EventStore, openEventStore, WorkerTokens } from '@tacet/core/node';
import { EventTap } from '@tacet/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventLogBackend } from './backend.js';
import { MiniMcpServer } from './server.js';

/**
 * A real Codex Worker (`codex app-server`, pinned @openai/codex) calls the Mini-conductor's
 * `escalate` tool over Streamable HTTP with its per-worker token, which the Codex adapter passes
 * as thread config over stdin. The model is a local mock of the Responses API.
 */
describe('a real Codex Worker calls escalate (#18 acceptance)', () => {
  let api: MockResponsesApi;
  let root: string;
  let store: EventStore;
  let server: MiniMcpServer;

  beforeAll(async () => {
    api = await startMockResponsesApi();
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tacet-mini-codex-')));
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
    const adapter = new CodexAppServerAdapter({
      authRoute: 'api_key',
      apiBaseUrl: api.url,
      config: { 'features.plugins': false },
      baseEnv: {
        PATH: process.env.PATH,
        HOME: home,
        CODEX_HOME: join(home, '.codex'),
        OPENAI_API_KEY: 'placeholder-not-a-real-key',
      },
    });
    const { config, revoke } = server.workerConfig({
      workerSessionId: 'worker-1',
      taskId: 'task-1',
    });
    const h = await adapter.start({
      cwd: join(root, 'worktree'),
      model: 'gpt-mock-1',
      mcpServers: [config],
    });
    const tap = new EventTap(adapter.events(h));
    // Approve whatever Codex asks for while the turn runs (it may ask before an MCP call).
    void (async () => {
      for (let from = 0; ; ) {
        const req = await tap
          .waitFor((e) => e.t === 'approval.request', 60_000, from)
          .catch(() => undefined);
        if (req?.event.t !== 'approval.request') return;
        from = req.index + 1;
        await adapter
          .respond(h, req.event.id, { kind: 'allow_once', persist: false })
          .catch(() => {});
      }
    })();
    await adapter.send(h, { text: 'ESCALATE' });
    await tap.waitFor((e) => e.t === 'status' && e.state === 'idle', 60_000, 1);
    await adapter.close(h);
    revoke();

    // Codex 0.167.0 offers the Mini-conductor's tools as the `mcp__tacet` namespace.
    const offered = api.requests.find((r) => r.text === 'ESCALATE')?.tools ?? [];
    expect(offered).toEqual(
      expect.arrayContaining([
        'mcp__tacet/read_task',
        'mcp__tacet/escalate',
        'mcp__tacet/search_decisions',
      ]),
    );
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
    const call = tap.events.find((e) => e.t === 'tool.call' && /escalate/.test(e.name));
    if (call?.t !== 'tool.call') throw new Error('no escalate tool.call event');
    expect(tap.events.find((e) => e.t === 'tool.result' && e.id === call.id)).toMatchObject({
      ok: true,
    });
  });
});
