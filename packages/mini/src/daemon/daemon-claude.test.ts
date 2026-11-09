import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeSdkAdapter } from '@tacet/adapter-claude-sdk';
import { type MockMessagesApi, startMockMessagesApi } from '@tacet/adapter-claude-sdk/testing';
import { newUlid, tasksProjection } from '@tacet/core';
import { type EventStore, openEventStore, WorkerTokens } from '@tacet/core/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventLogBackend } from '../mcp/backend.js';
import { MiniMcpServer } from '../mcp/server.js';
import { MiniConductor } from './daemon.js';
import { SingleStepPlanner } from './planner.js';
import { TempWorkspaces } from './testing.js';

/**
 * The daemon with real parts: a Claude Code Worker (Agent SDK, local mock of the Messages API)
 * calls the Mini-conductor's MCP `escalate` tool; the turn ends with the escalation open, so the
 * sub-task waits as `input_required`; once answered, the daemon delivers the answer as the
 * Worker's next message and the sub-task completes.
 */
describe('Mini-conductor with a real Claude Worker', () => {
  let api: MockMessagesApi;
  let root: string;
  let store: EventStore;
  let server: MiniMcpServer;
  let ws: TempWorkspaces;
  let daemon: MiniConductor;

  beforeAll(async () => {
    api = await startMockMessagesApi();
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tacet-mini-e2e-')));
    mkdirSync(join(root, 'home'));
    store = openEventStore(':memory:');
    server = await MiniMcpServer.start({
      backend: new EventLogBackend({ store, gateTimeoutMs: 200 }),
      tokens: new WorkerTokens(),
    });
    ws = new TempWorkspaces();
  });

  afterAll(async () => {
    await daemon?.stop();
    await server?.close();
    store?.close();
    await api?.close();
    ws?.dispose();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('escalates, waits for the answer, then completes', { timeout: 120_000 }, async () => {
    const home = join(root, 'home');
    const claude = new ClaudeSdkAdapter({
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
    daemon = new MiniConductor({
      store,
      config: { tiers: { worker: { adapter: 'claude-sdk', model: 'claude-sonnet-5-5' } } },
      adapters: { 'claude-sdk': { adapter: claude, authRoute: 'api_key' } },
      workspaces: ws,
      planner: new SingleStepPlanner(),
      mcp: server,
      lockPath: join(root, 'mini.lock'),
      pollMs: 50,
    });
    await daemon.start();
    const id = daemon.submit({
      goal: 'ESCALATE before choosing a database',
      acceptanceCriteria: ['ok'],
    });
    const sub = `${id}.1`;
    const state = () => store.replay(tasksProjection).tasks[sub]?.state;

    await expect.poll(state, { timeout: 60_000, interval: 100 }).toBe('input_required');
    const raised = store.query({ taskId: sub, typePrefix: 'escalation.raised' });
    expect(raised).toHaveLength(1);
    const escalation = raised[0]?.envelope;
    const escalationId = (escalation?.data as { id: string } | undefined)?.id;
    if (!escalationId) throw new Error('no escalation id');
    // Raised by the Worker itself, under the session the daemon started for this sub-task.
    const started = store.query({ taskId: sub, typePrefix: 'worker.started' })[0]?.envelope;
    expect(escalation?.sessionId).toBe(
      (started?.data as { sessionId: string } | undefined)?.sessionId,
    );

    // The user answers (as the Conductor or UI would record it).
    store.append({
      v: 1,
      id: newUlid(),
      ts: new Date().toISOString(),
      source: { kind: 'conductor', id: 'test' },
      taskId: sub,
      type: 'escalation.resolved',
      data: { escalationId, answer: 'Use Postgres' },
    });
    await expect.poll(state, { timeout: 60_000, interval: 100 }).toBe('completed');
    await daemon.settled();
    expect(store.replay(tasksProjection).tasks[id]?.state).toBe('completed');
    expect(store.query({ taskId: sub, typePrefix: 'escalation.delivered' })).toHaveLength(1);
    // The answer reached the model as the Worker's next message.
    expect(api.requests.some((r) => r.text?.includes('Use Postgres'))).toBe(true);
    expect(daemon.errors.map(String)).toEqual([]);
  });
});
