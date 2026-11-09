import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Options,
  Query,
  query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { EventTap } from '@tacet/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeSdkAdapter, toPermissionResult } from './adapter.js';
import { AuthRoutingError } from './auth.js';
import { AsyncQueue } from './queue.js';

// Fake values only.
const FAKE_KEY = 'fake-key-for-tests';
const LEAKY = `sk-ant-${'b'.repeat(24)}`;

const FAIL = Symbol('fail');

/**
 * A stand-in for the SDK's `query()` that records its options and plays scripted messages. Each
 * call gets its own output queue; `out` is the latest. Push `FAIL` to make the iterator throw,
 * as a crashed process does.
 */
function stubQuery(
  receipt: (sent: SDKUserMessage[]) => { still_queued: string[] } = () => ({ still_queued: [] }),
) {
  const calls: Options[] = [];
  const sent: SDKUserMessage[] = [];
  const outs: AsyncQueue<SDKMessage | typeof FAIL>[] = [];
  let closed = false;
  const fn = ((args: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => {
    calls.push(args.options ?? {});
    void (async () => {
      for await (const m of args.prompt) sent.push(m);
    })();
    const out = new AsyncQueue<SDKMessage | typeof FAIL>();
    outs.push(out);
    const q = {
      async *[Symbol.asyncIterator]() {
        for await (const m of out) {
          if (m === FAIL) throw new Error('process exited with code 1');
          yield m;
        }
      },
      interrupt: async () => receipt(sent),
      setModel: async () => {},
      getContextUsage: async () => ({ totalTokens: 10, maxTokens: 100 }),
      close: () => {
        closed = true;
        out.end();
      },
    };
    return q as unknown as Query;
  }) as unknown as typeof query;
  return {
    fn,
    calls,
    get out() {
      const last = outs.at(-1);
      if (!last) throw new Error('query() not called yet');
      return {
        push: (m: object | typeof FAIL) => last.push(m as SDKMessage),
        end: () => last.end(),
      };
    },
    sent,
    isClosed: () => closed,
  };
}

/** The context the SDK passes to `canUseTool`. */
const toolCtx = () => ({
  signal: new AbortController().signal,
  toolUseID: 'toolu_1',
  requestId: 'req_1',
});

const result = (cost: number, extra: object = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  total_cost_usd: cost,
  usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 1 },
  ...extra,
});

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

  /** Start a stubbed session and tap its events. */
  async function session(stub: ReturnType<typeof stubQuery>, opts: object = {}) {
    const adapter = make(stub);
    const h = await adapter.start({ cwd: join(root, 'wt'), ...opts });
    return { adapter, h, tap: new EventTap(adapter.events(h)) };
  }
  const usages = (tap: EventTap, n: number) =>
    tap.waitFor(() => tap.events.filter((e) => e.t === 'usage').length >= n, 5000);

  it('redacts secrets in tool.call input and turns cumulative cost into deltas', async () => {
    const stub = stubQuery();
    const { adapter, h, tap } = await session(stub);
    stub.out.push({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: `echo ${LEAKY}` } },
        ],
      },
    });
    stub.out.push(result(0.5));
    stub.out.push(result(0.75));
    await usages(tap, 2);
    await adapter.close(h);
    const call = tap.events.find((e) => e.t === 'tool.call');
    expect(JSON.stringify(call)).not.toContain(LEAKY);
    const usage = tap.events.filter((e) => e.t === 'usage');
    expect(usage.map((u) => (u.t === 'usage' ? u.costUsd : 0))).toEqual([0.5, 0.25]);
    // Result events carry cost only; tokens come per model call.
    expect(usage[0]).toMatchObject({ inputTokens: 0, outputTokens: 0, source: 'estimated' });
  });

  it('reports tokens, model and context per top-level model call', async () => {
    const stub = stubQuery();
    const { adapter, h, tap } = await session(stub, { model: 'requested-model' });
    const ev = (event: object, parent: string | null = null) =>
      stub.out.push({ type: 'stream_event', parent_tool_use_id: parent, event });
    const start = (model: string) =>
      ev({
        type: 'message_start',
        message: {
          model,
          usage: { input_tokens: 7, cache_read_input_tokens: 3, cache_creation_input_tokens: 0 },
        },
      });
    start('served-model-a');
    ev({ type: 'message_delta', usage: { output_tokens: 4 } });
    // A subagent's call is not counted here (result.usage excludes subagents too).
    ev(
      { type: 'message_start', message: { model: 'sub', usage: { input_tokens: 99 } } },
      'toolu_x',
    );
    ev({ type: 'message_delta', usage: { output_tokens: 99 } }, 'toolu_x');
    start('served-model-b');
    ev({ type: 'message_delta', usage: { output_tokens: 5 } });
    stub.out.push(result(0.25));
    await usages(tap, 3);
    const usage = tap.events.filter((e) => e.t === 'usage');
    expect(usage).toEqual([
      {
        t: 'usage',
        inputTokens: 10,
        outputTokens: 4,
        contextUsed: 14,
        contextMax: 100,
        model: 'served-model-a',
        source: 'reported',
      },
      {
        t: 'usage',
        inputTokens: 10,
        outputTokens: 5,
        contextUsed: 15,
        contextMax: 100,
        model: 'served-model-b',
        source: 'reported',
      },
      {
        t: 'usage',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0.25,
        contextUsed: 15,
        contextMax: 100,
        model: 'requested-model',
        source: 'estimated',
      },
    ]);
    await adapter.close(h);
  });

  it('a late interrupt cannot relabel a finished turn', async () => {
    const stub = stubQuery(() => ({ still_queued: [] }));
    const { adapter, h, tap } = await session(stub);
    await adapter.send(h, { text: 'one' });
    stub.out.push(result(0.1));
    await tap.waitFor((e) => e.t === 'status' && e.state === 'idle', 5000, 2);
    await adapter.interrupt(h); // lands after the result was handled
    await adapter.send(h, { text: 'two' });
    stub.out.push(result(0.2));
    const second = await tap.waitFor(
      (e) => e.t === 'status' && e.state !== 'running',
      5000,
      tap.events.findLastIndex((e) => e.t === 'status' && e.state === 'running') + 1,
    );
    expect(second.event).toMatchObject({ state: 'idle' });
    await adapter.close(h);
  });

  it('scrubs the Worker token from every event, even without a known prefix', async () => {
    const stub = stubQuery();
    const token = 'w0rkerT0kenWithoutAnyPrefix123';
    const { adapter, h, tap } = await session(stub, {
      mcpServers: [
        { name: 'tacet', url: 'http://127.0.0.1:1', headers: { 'x-tacet-token': token } },
      ],
    });
    stub.out.push({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: `curl -H ${token}` } },
        ],
      },
    });
    const canUseTool = stub.calls[0]?.canUseTool;
    void canUseTool?.('Bash', { command: `echo ${token}` }, toolCtx());
    await tap.waitFor((e) => e.t === 'approval.request', 5000);
    stub.out.push(FAIL);
    await tap.done;
    expect(JSON.stringify(tap.events)).not.toContain(token);
    expect(tap.events.some((e) => e.t === 'tool.call')).toBe(true);
    await adapter.close(h);
  });

  it('reports a crash as error, removes the MCP file and refuses further input', async () => {
    const stub = stubQuery();
    const { adapter, h, tap } = await session(stub, {
      mcpServers: [{ name: 't', url: 'http://127.0.0.1:1' }],
    });
    const path = stub.calls[0]?.extraArgs?.['mcp-config'] as string;
    const canUseTool = stub.calls[0]?.canUseTool;
    const pending = canUseTool?.('Bash', {}, toolCtx());
    await tap.waitFor((e) => e.t === 'approval.request', 5000);
    stub.out.push(FAIL);
    await tap.done;
    expect(tap.events.at(-1)).toMatchObject({
      t: 'status',
      state: 'error',
      message: 'process exited with code 1',
    });
    expect(adapter.status(h)).toBe('error');
    expect(existsSync(path)).toBe(false);
    await expect(pending).resolves.toMatchObject({ behavior: 'deny', interrupt: true });
    await expect(adapter.send(h, { text: 'hi' })).rejects.toThrow(/has ended/);
    expect(adapter.status(h)).toBe('error');
    await adapter.close(h);
    expect(adapter.status(h)).toBe('done');
  });

  it('maps an error result to error and a cancel decision to cancelled', async () => {
    const stub = stubQuery();
    const { adapter, h, tap } = await session(stub);
    await adapter.send(h, { text: 'a' });
    stub.out.push(result(0.1, { subtype: 'error_max_turns', is_error: true }));
    await tap.waitFor((e) => e.t === 'status' && e.state === 'error', 5000);

    await adapter.send(h, { text: 'b' });
    const canUseTool = stub.calls[0]?.canUseTool;
    const decision = canUseTool?.('Bash', {}, toolCtx());
    const req = await tap.waitFor((e) => e.t === 'approval.request', 5000);
    if (req.event.t !== 'approval.request') throw new Error('unreachable');
    await adapter.respond(h, req.event.id, { kind: 'cancel', persist: false });
    await expect(decision).resolves.toMatchObject({ behavior: 'deny', interrupt: true });
    stub.out.push(result(0.2, { subtype: 'error_during_execution', is_error: true }));
    await tap.waitFor((e) => e.t === 'status' && e.state === 'cancelled', 5000);
    await adapter.close(h);
  });

  it('runs input sent during a turn next: idle, then running again', async () => {
    const stub = stubQuery();
    const { adapter, h, tap } = await session(stub);
    await adapter.send(h, { text: 'one' });
    await adapter.send(h, { text: 'two' });
    stub.out.push(result(0.1));
    await usages(tap, 1);
    const states = () => tap.events.flatMap((e) => (e.t === 'status' ? [e.state] : []));
    await tap.waitFor(() => states().length >= 4, 5000);
    expect(states()).toEqual(['idle', 'running', 'idle', 'running']);
    stub.out.push(result(0.2));
    await tap.waitFor(() => states().length >= 5, 5000);
    expect(states().at(-1)).toBe('idle');
    await adapter.close(h);
  });

  it('does not carry an interrupt that missed its turn into the next one', async () => {
    const stub = stubQuery();
    const { adapter, h, tap } = await session(stub);
    await adapter.interrupt(h); // idle: nothing to cancel
    await adapter.send(h, { text: 'one' });
    stub.out.push(result(0.1));
    await usages(tap, 1);
    const end = await tap.waitFor(
      (e) => e.t === 'status' && e.state !== 'running',
      5000,
      tap.events.findIndex((e) => e.t === 'usage'),
    );
    expect(end.event).toMatchObject({ state: 'idle' });
    await adapter.close(h);
  });

  it('maps interrupt receipts back to the queued input text', async () => {
    // The receipt lists the uuid of the second message the adapter sent.
    const stub = stubQuery((sent) => ({ still_queued: sent.slice(1).map((m) => m.uuid ?? '') }));
    const { adapter, h } = await session(stub);
    await adapter.send(h, { text: 'first' });
    await adapter.send(h, { text: 'queued' });
    await expect.poll(() => stub.sent.length).toBe(2);
    expect(await adapter.interrupt(h)).toEqual({ stillQueued: ['queued'] });
    await adapter.close(h);
  });

  it('close() with an approval pending denies it and does not hang', async () => {
    const stub = stubQuery();
    const { adapter, h, tap } = await session(stub);
    const decision = stub.calls[0]?.canUseTool?.('Bash', {}, toolCtx());
    await tap.waitFor((e) => e.t === 'approval.request', 5000);
    await adapter.close(h);
    await expect(decision).resolves.toMatchObject({ behavior: 'deny' });
    expect(adapter.status(h)).toBe('done');
    await tap.done;
  });

  it('carries the cumulative cost across resume and fork instead of counting it again', async () => {
    const stub = stubQuery();
    const adapter = make(stub);
    const first = await adapter.start({ cwd: join(root, 'wt') });
    const tap1 = new EventTap(adapter.events(first));
    stub.out.push(result(0.3));
    await usages(tap1, 1);
    await adapter.close(first);
    const id = first.vendorSessionId as string;

    const resumed = await adapter.start({ cwd: join(root, 'wt'), resume: { vendorSessionId: id } });
    const tap2 = new EventTap(adapter.events(resumed));
    stub.out.push(result(0.5)); // the vendor total includes the first session's 0.3
    await usages(tap2, 1);
    expect(tap2.events.find((e) => e.t === 'usage')).toMatchObject({ costUsd: 0.2 });
    await adapter.close(resumed);

    // A fresh adapter has no baseline: the first resumed turn reports no cost rather than all of it.
    const other = make(stub);
    const cold = await other.start({ cwd: join(root, 'wt'), resume: { vendorSessionId: id } });
    const tap3 = new EventTap(other.events(cold));
    stub.out.push(result(0.9));
    stub.out.push(result(1.0));
    await tap3.waitFor(
      () => tap3.events.filter((e) => e.t === 'status' && e.state === 'idle').length >= 3,
      5000,
    );
    const costs = tap3.events.flatMap((e) => (e.t === 'usage' ? [e.costUsd] : []));
    expect(costs).toEqual([0.1]);
    await other.close(cold);
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
