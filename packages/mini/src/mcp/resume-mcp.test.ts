import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeSdkAdapter } from '@tacet/adapter-claude-sdk';
import { type MockMessagesApi, startMockMessagesApi } from '@tacet/adapter-claude-sdk/testing';
import { CodexAppServerAdapter } from '@tacet/adapter-codex-app-server';
import {
  type MockResponsesApi,
  startMockResponsesApi,
} from '@tacet/adapter-codex-app-server/testing';
import { type AgentAdapter, newUlid, type SessionHandle } from '@tacet/core';
import { type EventStore, openEventStore, WorkerTokens } from '@tacet/core/node';
import { EventTap } from '@tacet/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventLogBackend } from './backend.js';
import { MiniMcpServer } from './server.js';

/**
 * #128: after a restart the Mini-conductor listens on a new port and every Worker token is new.
 * A resumed vendor session is given only the new MCP server config. Each test runs a real vendor
 * binary against its local model mock: a first session calls `escalate` on server 1, server 1
 * goes away, and the resumed session must call `escalate` on server 2, as the Worker the new
 * token names.
 */

const TASK = 'task-128';

function seed(store: EventStore): void {
  store.append({
    v: 1,
    id: newUlid(),
    ts: new Date().toISOString(),
    source: { kind: 'mini', id: 'mini' },
    taskId: TASK,
    type: 'task.created',
    data: {
      id: TASK,
      goal: 'Add a cache',
      acceptanceCriteria: ['tests pass'],
      createdAt: new Date().toISOString(),
    },
  });
}

/** A Mini-conductor's MCP server with its own store and token registry, as after a restart. */
async function miniServer() {
  const store = openEventStore(':memory:');
  seed(store);
  const server = await MiniMcpServer.start({
    backend: new EventLogBackend({ store, repo: 'repo-1' }),
    tokens: new WorkerTokens(),
  });
  return { store, server };
}

/** Run one `ESCALATE` turn, allowing every approval the vendor asks for, then close. */
async function escalateTurn(adapter: AgentAdapter, h: SessionHandle): Promise<EventTap> {
  const tap = new EventTap(adapter.events(h));
  let done = false;
  void (async () => {
    for (let from = 0; !done; ) {
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
  const from = tap.events.length;
  await adapter.send(h, { text: 'ESCALATE' });
  await tap.waitFor((e) => e.t === 'status' && e.state === 'running', 60_000, from);
  await tap.waitFor((e) => e.t === 'status' && e.state === 'idle', 60_000, from + 1);
  done = true;
  await adapter.close(h);
  return tap;
}

function escalateSucceeded(tap: EventTap): boolean {
  const call = tap.events.find((e) => e.t === 'tool.call' && /escalate/.test(e.name));
  if (call?.t !== 'tool.call') return false;
  return tap.events.some((e) => e.t === 'tool.result' && e.id === call.id && e.ok);
}

describe('a resumed Worker reaches the restarted Mini-conductor (#128)', () => {
  let root: string;

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tacet-mini-resume-')));
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('Claude Code: --resume with a new --mcp-config', { timeout: 180_000 }, async () => {
    const api: MockMessagesApi = await startMockMessagesApi();
    const home = join(root, 'claude-home');
    const cwd = join(root, 'claude-worktree');
    mkdirSync(home);
    mkdirSync(cwd);
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
    });
    const one = await miniServer();
    const two = await miniServer();
    try {
      const first = one.server.workerConfig({ workerSessionId: 'worker-1', taskId: TASK });
      const h1 = await adapter.start({
        cwd,
        model: 'claude-sonnet-5-5',
        mcpServers: [first.config],
      });
      expect(escalateSucceeded(await escalateTurn(adapter, h1))).toBe(true);
      expect(one.store.query({ typePrefix: 'escalation.raised' })).toHaveLength(1);
      first.revoke();
      await one.server.close();
      const firstCalls = api.requests.length;
      const firstToolUses = api.requests.flatMap((r) => r.toolUseIds);
      expect(firstToolUses.length).toBeGreaterThan(0);

      const second = two.server.workerConfig({ workerSessionId: 'worker-2', taskId: TASK });
      expect(second.config.url).not.toBe(first.config.url);
      const vendorSessionId = h1.vendorSessionId ?? '';
      expect(vendorSessionId).not.toBe('');
      const h2 = await adapter.start({
        cwd,
        model: 'claude-sonnet-5-5',
        mcpServers: [second.config],
        resume: { vendorSessionId },
      });
      expect(escalateSucceeded(await escalateTurn(adapter, h2))).toBe(true);
      // Read after the turn: the id the CLI reported, not the one the adapter was given.
      expect(h2.vendorSessionId).toBe(vendorSessionId);
      second.revoke();
      // The call reached the new server, as the Worker its new token names.
      const raised = two.store.query({ typePrefix: 'escalation.raised' });
      expect(raised).toHaveLength(1);
      expect(raised[0]?.envelope.sessionId).toBe('worker-2');
      // And it was the same conversation: the model got the first session's tool call back.
      const resumed = api.requests.slice(firstCalls).filter((r) => r.text === 'ESCALATE');
      expect(resumed.length).toBeGreaterThan(0);
      for (const r of resumed) expect(r.toolUseIds).toEqual(expect.arrayContaining(firstToolUses));
    } finally {
      await one.server.close().catch(() => {});
      await two.server.close();
      one.store.close();
      two.store.close();
      await api.close();
    }
  });

  it('Codex: thread/resume with new config.mcp_servers', { timeout: 180_000 }, async () => {
    const api: MockResponsesApi = await startMockResponsesApi();
    const home = join(root, 'codex-home');
    const cwd = join(root, 'codex-worktree');
    mkdirSync(home);
    mkdirSync(cwd);
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
    const one = await miniServer();
    const two = await miniServer();
    try {
      const first = one.server.workerConfig({ workerSessionId: 'worker-1', taskId: TASK });
      const h1 = await adapter.start({ cwd, model: 'gpt-mock-1', mcpServers: [first.config] });
      expect(escalateSucceeded(await escalateTurn(adapter, h1))).toBe(true);
      expect(one.store.query({ typePrefix: 'escalation.raised' })).toHaveLength(1);
      first.revoke();
      await one.server.close();
      const firstCalls = api.requests.length;
      const firstCallIds = api.requests.flatMap((r) => r.callIds);
      expect(firstCallIds.length).toBeGreaterThan(0);

      const second = two.server.workerConfig({ workerSessionId: 'worker-2', taskId: TASK });
      expect(second.config.url).not.toBe(first.config.url);
      const vendorSessionId = h1.vendorSessionId ?? '';
      expect(vendorSessionId).not.toBe('');
      const h2 = await adapter.start({
        cwd,
        model: 'gpt-mock-1',
        mcpServers: [second.config],
        resume: { vendorSessionId },
      });
      expect(h2.vendorSessionId).toBe(vendorSessionId);
      expect(escalateSucceeded(await escalateTurn(adapter, h2))).toBe(true);
      second.revoke();
      const raised = two.store.query({ typePrefix: 'escalation.raised' });
      expect(raised).toHaveLength(1);
      expect(raised[0]?.envelope.sessionId).toBe('worker-2');
      const resumed = api.requests.slice(firstCalls).filter((r) => r.text === 'ESCALATE');
      expect(resumed.length).toBeGreaterThan(0);
      for (const r of resumed) expect(r.callIds).toEqual(expect.arrayContaining(firstCallIds));
    } finally {
      await one.server.close().catch(() => {});
      await two.server.close();
      one.store.close();
      two.store.close();
      await api.close();
    }
  });
});
