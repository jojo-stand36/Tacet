import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, Query, query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from '@tacet/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeSdkAdapter, toPermissionResult } from './adapter.js';
import { AuthRoutingError } from './auth.js';
import { AsyncQueue } from './queue.js';

// Fake values only.
const FAKE_KEY = 'fake-key-for-tests';
const LEAKY = `sk-ant-${'b'.repeat(24)}`;

/** A stand-in for the SDK's `query()` that records its options and plays scripted messages. */
function stubQuery() {
  const calls: Options[] = [];
  const out = new AsyncQueue<SDKMessage>();
  let closed = false;
  const fn = ((args: { options?: Options }) => {
    calls.push(args.options ?? {});
    const q = {
      [Symbol.asyncIterator]: () => out[Symbol.asyncIterator](),
      interrupt: async () => ({ still_queued: [] }),
      setModel: async () => {},
      getContextUsage: async () => ({ totalTokens: 10, maxTokens: 100 }),
      close: () => {
        closed = true;
        out.end();
      },
    };
    return q as unknown as Query;
  }) as unknown as typeof query;
  return { fn, calls, out, isClosed: () => closed };
}

describe('ClaudeSdkAdapter (stubbed SDK)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tacet-claude-unit-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const make = (stub: ReturnType<typeof stubQuery>, extra: object = {}) =>
    new ClaudeSdkAdapter({
      query: stub.fn,
      baseEnv: { PATH: '/bin', ANTHROPIC_API_KEY: FAKE_KEY },
      mcpConfigDir: join(root, 'mcp'),
      ...extra,
    });

  it('passes the MCP config as a file, never on the command line, and removes it on close', async () => {
    const stub = stubQuery();
    const adapter = make(stub);
    const h = await adapter.start({
      cwd: join(root, 'wt'),
      mcpServers: [{ name: 'tacet', url: 'http://127.0.0.1:1/mcp', headers: { a: 'b' } }],
    });
    const opts = stub.calls[0];
    expect(opts?.mcpServers).toBeUndefined();
    const path = opts?.extraArgs?.['mcp-config'];
    expect(path).toBe(join(root, 'mcp', `${h.id}.json`));
    expect(existsSync(path as string)).toBe(true);
    expect(opts?.includePartialMessages).toBe(true);
    expect(opts?.sessionId).toBe(h.vendorSessionId);
    await adapter.close(h);
    expect(existsSync(path as string)).toBe(false);
    expect(stub.isClosed()).toBe(true);
    expect(adapter.status(h)).toBe('done');
  });

  it('routes auth through the environment without storing anything', async () => {
    const stub = stubQuery();
    const h1 = await make(stub).start({ cwd: root });
    expect(stub.calls[0]?.env?.ANTHROPIC_API_KEY).toBe(FAKE_KEY);
    const h2 = await make(stub, { authRoute: 'subscription' }).start({ cwd: root });
    expect(stub.calls[1]?.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(stub.calls[1]?.env?.PATH).toBe('/bin');
    const noKey = new ClaudeSdkAdapter({
      query: stub.fn,
      baseEnv: { PATH: '/bin' },
      mcpConfigDir: join(root, 'mcp'),
    });
    await expect(
      noKey.start({ cwd: root, mcpServers: [{ name: 't', url: 'http://127.0.0.1:1' }] }),
    ).rejects.toThrow(AuthRoutingError);
    expect(existsSync(join(root, 'mcp'))).toBe(false);
    expect(h1.id).not.toBe(h2.id);
  });

  it('maps resume and fork to the SDK options', async () => {
    const stub = stubQuery();
    const adapter = make(stub);
    const resumed = await adapter.start({ cwd: root, resume: { vendorSessionId: 'v-1' } });
    expect(stub.calls[0]).toMatchObject({ resume: 'v-1' });
    expect(stub.calls[0]?.sessionId).toBeUndefined();
    expect(resumed.vendorSessionId).toBe('v-1');
    const forked = await adapter.start({
      cwd: root,
      resume: { vendorSessionId: 'v-1', fork: true },
    });
    expect(stub.calls[1]).toMatchObject({ resume: 'v-1', forkSession: true });
    expect(forked.vendorSessionId).toBe(stub.calls[1]?.sessionId);
    expect(forked.vendorSessionId).not.toBe('v-1');
  });

  it('removes the MCP file if the SDK fails to start', async () => {
    const adapter = new ClaudeSdkAdapter({
      query: (() => {
        throw new Error('spawn failed');
      }) as unknown as typeof query,
      baseEnv: { ANTHROPIC_API_KEY: FAKE_KEY },
      mcpConfigDir: join(root, 'mcp'),
    });
    await expect(
      adapter.start({
        cwd: join(root, 'wt'),
        mcpServers: [{ name: 't', url: 'http://127.0.0.1:1' }],
      }),
    ).rejects.toThrow('spawn failed');
    expect(existsSync(join(root, 'mcp'))).toBe(true);
    expect(readdirSync(join(root, 'mcp'))).toEqual([]);
  });

  it('redacts secrets in tool.call input and turns cumulative cost into deltas', async () => {
    const stub = stubQuery();
    const adapter = make(stub);
    const h = await adapter.start({ cwd: root });
    const events: AgentEvent[] = [];
    const done = (async () => {
      for await (const e of adapter.events(h)) events.push(e);
    })();
    const msg = (m: object) => stub.out.push(m as SDKMessage);
    msg({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: `echo ${LEAKY}` } },
        ],
      },
    });
    const result = (cost: number) => ({
      type: 'result',
      subtype: 'success',
      is_error: false,
      total_cost_usd: cost,
      usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 1 },
    });
    msg(result(0.5));
    msg(result(0.75));
    await new Promise((r) => setTimeout(r, 20));
    await adapter.close(h);
    await done;
    const call = events.find((e) => e.t === 'tool.call');
    expect(JSON.stringify(call)).not.toContain(LEAKY);
    const usage = events.filter((e) => e.t === 'usage');
    expect(usage.map((u) => (u.t === 'usage' ? u.costUsd : 0))).toEqual([0.5, 0.25]);
    expect(usage[0]).toMatchObject({
      inputTokens: 6,
      outputTokens: 2,
      contextUsed: 10,
      contextMax: 100,
    });
  });
});

describe('toPermissionResult', () => {
  const suggestions = [
    {
      type: 'addRules' as const,
      rules: [{ toolName: 'Bash', ruleContent: 'touch:*' }],
      behavior: 'allow' as const,
      destination: 'localSettings' as const,
    },
  ];
  it('allow_once allows without rules', () => {
    expect(toPermissionResult({ kind: 'allow_once', persist: false }, suggestions)).toEqual({
      behavior: 'allow',
    });
  });
  it('allow_always keeps rules to the session unless persist is set', () => {
    const session = toPermissionResult({ kind: 'allow_always', persist: false }, suggestions);
    expect(session).toMatchObject({ updatedPermissions: [{ destination: 'session' }] });
    const kept = toPermissionResult({ kind: 'allow_always', persist: true }, suggestions);
    expect(kept).toMatchObject({ updatedPermissions: [{ destination: 'localSettings' }] });
  });
  it('reject denies and cancel also interrupts', () => {
    expect(toPermissionResult({ kind: 'reject', persist: false }, undefined)).toMatchObject({
      behavior: 'deny',
    });
    expect(
      toPermissionResult({ kind: 'cancel', persist: false, message: 'stop' }, undefined),
    ).toEqual({ behavior: 'deny', message: 'stop', interrupt: true });
  });
  it('passes updatedInput through on allow', () => {
    expect(
      toPermissionResult({ kind: 'allow_once', persist: false, updatedInput: { a: 1 } }, undefined),
    ).toEqual({ behavior: 'allow', updatedInput: { a: 1 } });
  });
});
