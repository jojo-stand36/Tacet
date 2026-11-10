import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Options,
  Query,
  query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { AsyncQueue } from '@tacet/core';
import { repoStateDir } from '@tacet/core/node';
import { EventTap } from '@tacet/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeSdkAdapter, toPermissionResult } from './adapter.js';
import { AuthRoutingError } from './auth.js';
import { ownOwnerDirName } from './mcp-config.js';

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
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tacet-claude-unit-')));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const make = (stub: ReturnType<typeof stubQuery>, extra: object = {}) =>
    new ClaudeSdkAdapter({
      query: stub.fn,
      baseEnv: { PATH: '/bin', ANTHROPIC_API_KEY: FAKE_KEY },
      mcpConfigDir: join(root, 'mcp'),
      stateDir: join(root, 'state'),
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
    expect(path).toBe(join(root, 'mcp', ownOwnerDirName(), `${h.id}.json`));
    expect(existsSync(path as string)).toBe(true);
    expect(opts?.includePartialMessages).toBe(true);
    expect(opts?.sessionId).toBe(h.vendorSessionId);
    await adapter.close(h);
    expect(existsSync(path as string)).toBe(false);
    expect(stub.isClosed()).toBe(true);
    expect(adapter.status(h)).toBe('done');
  });

  it('sweeps the MCP files of a dead Mini-conductor once, at its first session (#108)', async () => {
    const ns = ownOwnerDirName().split('-')[0];
    const stale = join(root, 'mcp', `${ns}-999999999-000000000000`);
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, 'old.json'), '{"token":"leftover"}');
    const swept: unknown[] = [];
    const stub = stubQuery();
    const adapter = make(stub, { onSweep: (n: number) => swept.push(n) });
    const h1 = await adapter.start({ cwd: join(root, 'wt') });
    const h2 = await adapter.start({ cwd: join(root, 'wt') });
    expect(swept).toEqual([1]);
    expect(existsSync(stale)).toBe(false);
    await adapter.close(h1);
    await adapter.close(h2);
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
      stateDir: join(root, 'state'),
    });
    await expect(
      noKey.start({ cwd: root, mcpServers: [{ name: 't', url: 'http://127.0.0.1:1' }] }),
    ).rejects.toThrow(AuthRoutingError);
    expect(existsSync(join(root, 'mcp'))).toBe(false);
    expect(h1.id).not.toBe(h2.id);
  });

  it('gives the Worker an allowlist of the environment, not all of it (#147)', async () => {
    const user = {
      PATH: '/bin',
      HOME: '/home/u',
      JAVA_HOME: '/opt/jdk',
      ANTHROPIC_API_KEY: FAKE_KEY,
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
      OPENAI_API_KEY: 'sk-other-vendor',
      GEMINI_API_KEY: 'other-vendor',
      GITHUB_TOKEN: 'ghp_x',
      GITHUB_ACTIONS: 'true',
      AWS_SECRET_ACCESS_KEY: 'aws-x',
      MYAPP_HOME: '/opt/myapp',
    };
    const dropped: string[][] = [];
    const stub = stubQuery();
    const adapter = make(stub, {
      baseEnv: user,
      envPolicy: { pass: ['MYAPP_*'] },
      onEnvDropped: (n: string[]) => dropped.push(n),
    });
    await adapter.start({ cwd: root, env: { TACET_WORKER_MARKER: 'm-1' } });
    const env = stub.calls[0]?.env ?? {};
    expect(Object.keys(env).sort()).toEqual([
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_BASE_URL',
      'CLAUDE_AGENT_SDK_CLIENT_APP',
      'CLAUDE_CONFIG_DIR',
      'HOME',
      'JAVA_HOME',
      'MYAPP_HOME',
      'PATH',
      'TACET_WORKER_MARKER',
    ]);
    expect(dropped).toEqual([
      [
        'AWS_SECRET_ACCESS_KEY',
        'GEMINI_API_KEY',
        'GITHUB_ACTIONS',
        'GITHUB_TOKEN',
        'OPENAI_API_KEY',
      ],
    ]);
    // A cloud route the user chose brings its credential chain; interactive may inherit all.
    await make(stub, {
      baseEnv: { ...user, ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_USE_BEDROCK: '1' },
    }).start({ cwd: root });
    expect(stub.calls[1]?.env?.AWS_SECRET_ACCESS_KEY).toBe('aws-x');
    expect(stub.calls[1]?.env?.OPENAI_API_KEY).toBeUndefined();
    await make(stub, { baseEnv: user, envPolicy: { inherit: 'all' } }).start({ cwd: root });
    expect(stub.calls[2]?.env?.OPENAI_API_KEY).toBe('sk-other-vendor');
    // Vertex brings the Google project and credentials file, not other Google keys.
    await make(stub, {
      baseEnv: {
        ...user,
        ANTHROPIC_API_KEY: undefined,
        CLAUDE_CODE_USE_VERTEX: '1',
        CLOUD_ML_REGION: 'us-east5',
        GOOGLE_APPLICATION_CREDENTIALS: '/home/u/adc.json',
        GOOGLE_API_KEY: 'google-other-product',
        GEMINI_API_KEY: 'gemini-other-vendor',
        CLAUDE_CODE_SOME_LOGIN_TOKEN: 'login',
      },
    }).start({ cwd: root });
    const vertex = stub.calls[3]?.env ?? {};
    expect(vertex).toMatchObject({
      CLOUD_ML_REGION: 'us-east5',
      GOOGLE_APPLICATION_CREDENTIALS: '/home/u/adc.json',
    });
    for (const k of ['GOOGLE_API_KEY', 'GEMINI_API_KEY', 'AWS_SECRET_ACCESS_KEY']) {
      expect(vertex[k]).toBeUndefined();
    }
    // A vendor prefix never carries a secret-looking name along: only the named key variables.
    expect(vertex.CLAUDE_CODE_SOME_LOGIN_TOKEN).toBeUndefined();
  });

  it('loads no filesystem settings unless the caller opts in (#181)', async () => {
    const stub = stubQuery();
    await make(stub).start({ cwd: root });
    await make(stub, { sdkOptions: { permissionMode: 'default' } }).start({ cwd: root });
    // Other SDK options do not drop the default, and a resume keeps it too.
    const first = await make(stub).start({ cwd: root });
    await make(stub).start({
      cwd: root,
      resume: { vendorSessionId: first.vendorSessionId as string },
    });
    expect(stub.calls.map((c) => c.settingSources)).toEqual([[], [], [], []]);
    expect(stub.calls.every((c) => c.strictMcpConfig === true)).toBe(true);
    await make(stub, { sdkOptions: { settingSources: ['project'] } }).start({ cwd: root });
    expect(stub.calls[4]?.settingSources).toEqual(['project']);
  });

  it('gives an unattended Worker only the file tools, no shell, and asks Tacet about reads (#206)', async () => {
    const stub = stubQuery();
    await make(stub).start({ cwd: root });
    // Not set unless asked for: interactive sessions keep the SDK's defaults.
    expect(stub.calls[0]?.tools).toBeUndefined();
    expect(stub.calls[0]?.hooks).toBeUndefined();

    const adapter = make(stub, { fileToolsOnly: true });
    const h = await adapter.start({ cwd: root });
    const opts = stub.calls[1] as Options;
    expect(opts.tools).toEqual(['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep']);
    expect(opts.disallowedTools).toEqual(['Bash', 'PowerShell', 'Monitor']);
    expect(opts.allowedTools).toEqual([]);
    expect(opts.permissionMode).toBe('default');
    expect(opts.verbatimPrompts).toBe(true);
    const matcher = opts.hooks?.PreToolUse?.[0];
    expect(matcher).toMatchObject({ matcher: 'Read|Glob|Grep', onFailure: 'block' });
    const hook = matcher?.hooks[0] as NonNullable<typeof matcher>['hooks'][number];

    // The hook turns a read into an approval request; Tacet's answer becomes the hook's decision.
    const tap = new EventTap(adapter.events(h));
    const call = (tool_name: string, tool_input: unknown, id: string) =>
      hook(
        {
          hook_event_name: 'PreToolUse',
          tool_name,
          tool_input,
          tool_use_id: id,
          session_id: 's',
          transcript_path: '',
          cwd: root,
        } as never,
        id,
        { signal: new AbortController().signal },
      );
    const allowed = call('Glob', { pattern: '**/*.ts' }, 'toolu_a');
    const req = await tap.waitFor((e) => e.t === 'approval.request', 5000);
    if (req.event.t !== 'approval.request') throw new Error('no request');
    expect(req.event).toMatchObject({
      toolName: 'Glob',
      requestedGrant: { input: { pattern: '**/*.ts' } },
    });
    await adapter.respond(h, req.event.id, { kind: 'allow_once', persist: false });
    await expect(allowed).resolves.toMatchObject({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
    });
    const refused = call('Read', { file_path: '/etc/passwd' }, 'toolu_b');
    const req2 = await tap.waitFor((e) => e.t === 'approval.request', 5000, req.index + 1);
    if (req2.event.t !== 'approval.request') throw new Error('no request');
    await adapter.respond(h, req2.event.id, { kind: 'reject', persist: false, message: 'outside' });
    await expect(refused).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'outside' },
    });
    expect(await refused).not.toHaveProperty('continue');
    // A rewritten input is what runs; a cancel stops the turn.
    const rewritten = call('Read', { file_path: 'a' }, 'toolu_c');
    const req3 = await tap.waitFor((e) => e.t === 'approval.request', 5000, req2.index + 1);
    await adapter.respond(h, (req3.event as { id: string }).id, {
      kind: 'allow_once',
      persist: false,
      updatedInput: { file_path: 'b' },
    });
    await expect(rewritten).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: 'allow', updatedInput: { file_path: 'b' } },
    });
    const cancelled = call('Read', { file_path: 'a' }, 'toolu_d');
    const req4 = await tap.waitFor((e) => e.t === 'approval.request', 5000, req3.index + 1);
    await adapter.respond(h, (req4.event as { id: string }).id, { kind: 'cancel', persist: false });
    await expect(cancelled).resolves.toMatchObject({
      continue: false,
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    await adapter.close(h);
  });

  describe('config dir of its own (#237)', () => {
    const configRoot = () => join(repoStateDir(root, join(root, 'state')), 'claude-sdk');
    const dirOf = (stub: ReturnType<typeof stubQuery>, i: number) =>
      stub.calls[i]?.env?.CLAUDE_CONFIG_DIR as string;

    it("runs each API-key session in its own empty, private config dir, never the user's", async () => {
      const stub = stubQuery();
      const adapter = make(stub, {
        baseEnv: {
          PATH: '/bin',
          ANTHROPIC_API_KEY: FAKE_KEY,
          CLAUDE_CONFIG_DIR: '/home/u/.claude',
        },
      });
      const h = await adapter.start({ cwd: root });
      expect(dirOf(stub, 0)).toBe(join(configRoot(), h.vendorSessionId as string));
      expect(statSync(dirOf(stub, 0)).mode & 0o777).toBe(0o700);
      expect(readdirSync(dirOf(stub, 0))).toEqual([]);
      await adapter.close(h);
      // The subscription route keeps the user's own dir: their login lives there.
      const sub = stubQuery();
      await make(sub, {
        authRoute: 'subscription',
        baseEnv: { PATH: '/bin', CLAUDE_CONFIG_DIR: '/home/u/.claude' },
      }).start({ cwd: root });
      expect(dirOf(sub, 0)).toBe('/home/u/.claude');
    });

    it('resumes in the same dir, and forks into a copy of a closed source', async () => {
      const stub = stubQuery();
      const adapter = make(stub);
      await expect(
        adapter.start({
          cwd: root,
          resume: { vendorSessionId: '99999999-9999-4999-8999-999999999999' },
        }),
      ).rejects.toThrow(/no Claude session .* to resume/);
      await expect(
        adapter.start({ cwd: root, resume: { vendorSessionId: '../x' } }),
      ).rejects.toThrow(/named by its UUID/);
      const h = await adapter.start({ cwd: root });
      const v = h.vendorSessionId as string;
      writeFileSync(join(dirOf(stub, 0), 'transcript.jsonl'), 'turn 1\n');
      await expect(
        adapter.start({ cwd: root, resume: { vendorSessionId: v, fork: true } }),
      ).rejects.toThrow(/is open; fork it once it is closed/);
      await adapter.close(h);
      const r = await adapter.start({ cwd: root, resume: { vendorSessionId: v } });
      expect(dirOf(stub, 1)).toBe(dirOf(stub, 0));
      await adapter.close(r);
      const f = await adapter.start({ cwd: root, resume: { vendorSessionId: v, fork: true } });
      expect(dirOf(stub, 2)).toBe(join(configRoot(), f.vendorSessionId as string));
      expect(readdirSync(dirOf(stub, 2))).toEqual(['transcript.jsonl']);
      await adapter.close(f);
    });

    it('discards a closed session by its exact id, refusing an open one', async () => {
      const stub = stubQuery();
      const adapter = make(stub);
      const a = await adapter.start({ cwd: root });
      const b = await adapter.start({ cwd: root });
      const va = a.vendorSessionId as string;
      await expect(adapter.discard(va, root)).rejects.toThrow(/still open/);
      await adapter.close(a);
      await adapter.discard(va, root);
      expect(existsSync(join(configRoot(), va))).toBe(false);
      expect(existsSync(dirOf(stub, 1))).toBe(true);
      await expect(adapter.discard('*', root)).rejects.toThrow(/named by its UUID/);
      await adapter.close(b);
      // The subscription route never removes anything: Tacet did not make those dirs.
      const userDir = join(root, 'user-claude', va);
      mkdirSync(userDir, { recursive: true });
      await make(stubQuery(), { authRoute: 'subscription' }).discard(va, join(root, 'user-claude'));
      expect(existsSync(userDir)).toBe(true);
    });

    it('sweeps dirs older than the retention at its first start, never the one resumed', async () => {
      const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
      for (const id of ids) {
        mkdirSync(join(configRoot(), id), { recursive: true });
        writeFileSync(join(configRoot(), id, 't.jsonl'), 'x');
        utimesSync(join(configRoot(), id, 't.jsonl'), old, old);
        utimesSync(join(configRoot(), id), old, old);
      }
      const stub = stubQuery();
      const adapter = make(stub, { retentionDays: 7 });
      const h = await adapter.start({ cwd: root, resume: { vendorSessionId: ids[1] as string } });
      expect(existsSync(join(configRoot(), ids[0] as string))).toBe(false);
      expect(existsSync(join(configRoot(), ids[1] as string))).toBe(true);
      await adapter.close(h);
    });

    it('removes the dir of a fresh session that failed to start', async () => {
      const adapter = new ClaudeSdkAdapter({
        query: (() => {
          throw new Error('spawn failed');
        }) as unknown as typeof query,
        baseEnv: { ANTHROPIC_API_KEY: FAKE_KEY },
        mcpConfigDir: join(root, 'mcp'),
        stateDir: join(root, 'state'),
      });
      await expect(adapter.start({ cwd: root })).rejects.toThrow('spawn failed');
      expect(readdirSync(configRoot())).toEqual([]);
    });
  });

  it('maps resume and fork to the SDK options', async () => {
    const stub = stubQuery();
    const adapter = make(stub);
    const first = await adapter.start({ cwd: root });
    const v1 = first.vendorSessionId as string;
    await adapter.close(first);
    const resumed = await adapter.start({ cwd: root, resume: { vendorSessionId: v1 } });
    expect(stub.calls[1]).toMatchObject({ resume: v1 });
    expect(stub.calls[1]?.sessionId).toBeUndefined();
    expect(resumed.vendorSessionId).toBe(v1);
    await adapter.close(resumed);
    const forked = await adapter.start({
      cwd: root,
      resume: { vendorSessionId: v1, fork: true },
    });
    expect(stub.calls[2]).toMatchObject({ resume: v1, forkSession: true });
    expect(forked.vendorSessionId).toBe(stub.calls[2]?.sessionId);
    expect(forked.vendorSessionId).not.toBe(v1);
  });

  it('removes the MCP file if the SDK fails to start', async () => {
    const adapter = new ClaudeSdkAdapter({
      query: (() => {
        throw new Error('spawn failed');
      }) as unknown as typeof query,
      baseEnv: { ANTHROPIC_API_KEY: FAKE_KEY },
      mcpConfigDir: join(root, 'mcp'),
      stateDir: join(root, 'state'),
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

  it('scrubs a Worker token the model echoes split across two deltas (#109)', async () => {
    const token = 'w0rkerT0ken-abcdef123456';
    for (const cut of [1, 7, 12, token.length - 1]) {
      const stub = stubQuery();
      const { adapter, h, tap } = await session(stub, {
        mcpServers: [
          {
            name: 'tacet',
            url: 'http://127.0.0.1:1/mcp',
            headers: { authorization: `Bearer ${token}` },
          },
        ],
      });
      const text = (t: string) =>
        stub.out.push({
          type: 'stream_event',
          parent_tool_use_id: null,
          event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } },
        });
      text(`my token is ${token.slice(0, cut)}`);
      text(`${token.slice(cut)} ok`);
      stub.out.push(result(0));
      // The turn's usage comes after its text, and flushes the held-back tail first.
      await usages(tap, 1);
      const deltas = tap.events.flatMap((e) => (e.t === 'message.delta' ? [e.text] : []));
      expect(JSON.stringify(tap.events)).not.toContain(token);
      expect(deltas.join('')).toBe('my token is [redacted] ok');
      await adapter.close(h);
    }
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
