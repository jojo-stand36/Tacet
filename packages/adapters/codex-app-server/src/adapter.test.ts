import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { EventTap } from '@tacet/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodexAppServerAdapter, configArgs, grantSubset, toCodexDecision } from './adapter.js';
import { API_KEY_PROVIDER_ID, AuthRoutingError, chooseAuthRoute, codexLaunch } from './auth.js';
import { JsonRpcPeer, RpcError } from './jsonrpc.js';

// Fake values only.
const FAKE_KEY = 'fake-key-for-tests';
const FAKE = fileURLToPath(new URL('./testing/fake-app-server.mjs', import.meta.url));

describe('auth routing', () => {
  it('defaults to the API key unattended and the own login interactively', () => {
    expect(chooseAuthRoute({ interactive: false })).toBe('api_key');
    expect(chooseAuthRoute({ interactive: true })).toBe('subscription');
    expect(chooseAuthRoute({ interactive: true }, { interactive: 'api_key' })).toBe('api_key');
    const unchecked = { unattended: 'subscription' } as unknown as { unattended: 'api_key' };
    expect(chooseAuthRoute({ interactive: false }, unchecked)).toBe('api_key');
  });

  it('api_key names the key variable in a provider; the value never reaches argv', () => {
    const { env, args } = codexLaunch('api_key', { OPENAI_API_KEY: FAKE_KEY, PATH: '/bin' });
    expect(env).toEqual({ OPENAI_API_KEY: FAKE_KEY, PATH: '/bin' });
    expect(args.join(' ')).not.toContain(FAKE_KEY);
    expect(args).toContain(`model_provider="${API_KEY_PROVIDER_ID}"`);
    expect(args).toContain(`model_providers.${API_KEY_PROVIDER_ID}.env_key="OPENAI_API_KEY"`);
    expect(args).toContain(
      `model_providers.${API_KEY_PROVIDER_ID}.base_url="https://api.openai.com/v1"`,
    );
    const codexKey = codexLaunch('api_key', { CODEX_API_KEY: FAKE_KEY });
    expect(codexKey.args).toContain(
      `model_providers.${API_KEY_PROVIDER_ID}.env_key="CODEX_API_KEY"`,
    );
  });

  it('api_key refuses to fall back to the login, without echoing the environment', () => {
    expect(() => codexLaunch('api_key', { PATH: '/bin', OTHER: FAKE_KEY })).toThrow(
      expect.objectContaining({
        name: 'AuthRoutingError',
        message: expect.not.stringContaining(FAKE_KEY),
      }),
    );
    expect(() => codexLaunch('api_key', {})).toThrow(AuthRoutingError);
  });

  it('never passes Rust debug logging to a Worker', () => {
    const { env } = codexLaunch('api_key', {
      OPENAI_API_KEY: FAKE_KEY,
      RUST_LOG: 'trace',
      RUST_BACKTRACE: '1',
    });
    expect(env).toEqual({ OPENAI_API_KEY: FAKE_KEY });
  });

  it('subscription strips key variables and adds no provider', () => {
    expect(
      codexLaunch('subscription', {
        OPENAI_API_KEY: FAKE_KEY,
        CODEX_API_KEY: FAKE_KEY,
        PATH: '/bin',
      }),
    ).toEqual({ env: { PATH: '/bin' }, args: [] });
  });
});

describe('toCodexDecision', () => {
  const d = (kind: 'allow_once' | 'allow_always' | 'reject' | 'cancel', persist = false) => ({
    kind,
    persist,
  });
  it('maps command decisions, persisting a rule only on request', () => {
    const params = { proposedExecpolicyAmendment: ['touch'] };
    expect(toCodexDecision('command', params, d('allow_once'))).toEqual({ decision: 'accept' });
    expect(toCodexDecision('command', params, d('allow_always'))).toEqual({
      decision: 'acceptForSession',
    });
    expect(toCodexDecision('command', params, d('allow_always', true))).toEqual({
      decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['touch'] } },
    });
    expect(toCodexDecision('command', {}, d('allow_always', true))).toEqual({
      decision: 'acceptForSession',
    });
    expect(toCodexDecision('command', params, d('reject'))).toEqual({ decision: 'decline' });
    expect(toCodexDecision('command', params, d('cancel'))).toEqual({ decision: 'cancel' });
  });
  it('maps file changes, permissions grants and elicitations', () => {
    expect(toCodexDecision('fileChange', {}, d('allow_always'))).toEqual({
      decision: 'acceptForSession',
    });
    const permissions = { network: { enabled: true } };
    expect(toCodexDecision('permissions', { permissions }, d('allow_once'))).toEqual({
      permissions,
      scope: 'turn',
    });
    expect(
      toCodexDecision('permissions', { permissions }, { ...d('allow_always'), grant: {} }),
    ).toEqual({ permissions: {}, scope: 'session' });
    expect(toCodexDecision('permissions', { permissions }, d('reject'))).toEqual({
      permissions: {},
      scope: 'turn',
    });
    expect(toCodexDecision('elicitation', {}, d('cancel'))).toMatchObject({ action: 'cancel' });
    expect(toCodexDecision('elicitation', {}, d('allow_once'))).toMatchObject({ action: 'accept' });
  });
});

describe('configArgs', () => {
  it('turns plain settings into -c overrides', () => {
    expect(configArgs({ 'features.plugins': false, model_verbosity: 'low' })).toEqual([
      '-c',
      'features.plugins=false',
      '-c',
      'model_verbosity="low"',
    ]);
    expect(configArgs(undefined)).toEqual([]);
  });
  it('refuses anything that could change auth or carry a credential', () => {
    for (const key of [
      'model_provider',
      'model_providers.x.base_url',
      'mcp_servers.tacet.url',
      'openai_base_url',
      'something.api_key',
      'x.http_headers',
      'some_token',
    ]) {
      expect(() => configArgs({ [key]: 'v' }), key).toThrow(AuthRoutingError);
    }
    expect(() => configArgs({ note: `sk-ant-${'a'.repeat(24)}` })).toThrow(AuthRoutingError);
  });
});

describe('grantSubset', () => {
  const requested = { network: { enabled: true }, fileSystem: { write: ['/w', '/x'] } };
  it('narrows but never widens a permissions grant', () => {
    expect(grantSubset(requested, requested)).toEqual(requested);
    expect(grantSubset(requested, { fileSystem: { write: ['/x', '/etc'] } })).toEqual({
      fileSystem: { write: ['/x'] },
    });
    expect(grantSubset(requested, { network: { enabled: false } })).toEqual({
      network: { enabled: false },
    });
    expect(grantSubset(requested, { root: true, network: { enabled: true, all: true } })).toEqual({
      network: { enabled: true },
    });
  });
});

describe('JsonRpcPeer', () => {
  it('matches responses to requests, answers server requests and rejects on close', async () => {
    const toPeer = new PassThrough();
    const fromPeer = new PassThrough();
    const notes: string[] = [];
    const rpc = new JsonRpcPeer(toPeer, fromPeer, {
      onRequest: async (method) => {
        if (method === 'ok') return { fine: true };
        throw new RpcError(-32601, 'nope');
      },
      onNotification: (method) => notes.push(method),
    });
    const lines: string[] = [];
    fromPeer.setEncoding('utf8');
    fromPeer.on('data', (c: string) => lines.push(...c.trim().split('\n')));
    const pending = rpc.request('ping', { a: 1 });
    toPeer.write('not json\n');
    toPeer.write(`${JSON.stringify({ id: 1, result: { pong: true } })}\n`);
    await expect(pending).resolves.toEqual({ pong: true });
    toPeer.write(
      `${JSON.stringify({ id: 7, method: 'ok' })}\n${JSON.stringify({ id: 8, method: 'bad' })}\n`,
    );
    toPeer.write(`${JSON.stringify({ method: 'note/one', params: {} })}\n`);
    await new Promise((r) => setImmediate(r));
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { id: 1, method: 'ping', params: { a: 1 } },
      { id: 7, result: { fine: true } },
      { id: 8, error: { code: -32601, message: 'nope' } },
    ]);
    expect(notes).toEqual(['note/one']);
    const err = rpc.request('x');
    toPeer.write(
      `${JSON.stringify({ id: 2, error: { code: -32600, message: 'no active turn' } })}\n`,
    );
    await expect(err).rejects.toMatchObject({ code: -32600 });
    const hanging = rpc.request('y');
    toPeer.end();
    await expect(hanging).rejects.toThrow(/closed/);
  });
});

describe('CodexAppServerAdapter with a fake app-server', () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tacet-codex-unit-')));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const make = (mode: string, extra: object = {}) =>
    new CodexAppServerAdapter({
      codexPath: FAKE,
      // The fake app-server is steered by FAKE_* variables (#147: passed through on purpose).
      envPolicy: { pass: ['FAKE_*'] },
      killTimeoutMs: 1000,
      baseEnv: {
        PATH: process.env.PATH,
        HOME: root,
        OPENAI_API_KEY: FAKE_KEY,
        FAKE_MODE: mode,
        FAKE_LOG: join(root, 'log.jsonl'),
      },
      ...extra,
    });
  const clientLog = () =>
    readFileSync(join(root, 'log.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));

  it('gives unattended Workers an allowlist of the environment, interactive ones all of it', async () => {
    const envLog = join(root, 'env.json');
    const user = {
      PATH: process.env.PATH,
      HOME: root,
      OPENAI_API_KEY: FAKE_KEY,
      OPENAI_ORGANIZATION: 'org-1',
      ANTHROPIC_API_KEY: 'sk-ant-other-vendor',
      GITHUB_TOKEN: 'ghp_x',
      RUST_LOG: 'trace',
      FAKE_ENV_LOG: envLog,
    };
    const dropped: string[][] = [];
    const run = async (extra: object) => {
      rmSync(envLog, { force: true });
      const adapter = make('normal', { baseEnv: user, ...extra });
      const h = await adapter.start({ cwd: root, env: { TACET_WORKER_MARKER: 'm-1' } });
      await adapter.close(h);
      return JSON.parse(readFileSync(envLog, 'utf8')) as string[];
    };
    const names = await run({ onEnvDropped: (n: string[]) => dropped.push(n) });
    expect(names).toEqual(
      expect.arrayContaining([
        'OPENAI_API_KEY',
        'OPENAI_ORGANIZATION',
        'CODEX_HOME',
        'TACET_WORKER_MARKER',
      ]),
    );
    for (const n of ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'RUST_LOG'])
      expect(names).not.toContain(n);
    expect(dropped).toEqual([['ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'RUST_LOG']]);
    const interactive = await run({
      mode: 'interactive',
      authRoute: 'subscription',
      envPolicy: undefined,
    });
    expect(interactive).toContain('GITHUB_TOKEN');
    // The key never reaches an interactive session on the login route, filter or not.
    expect(interactive).not.toContain('OPENAI_API_KEY');
  });

  it('reports a crash during a turn as error and refuses further input', async () => {
    const adapter = make('crash');
    const h = await adapter.start({ cwd: root });
    const tap = new EventTap(adapter.events(h));
    await adapter.send(h, { text: 'go' });
    await tap.done;
    expect(tap.events.at(-1)).toMatchObject({ t: 'status', state: 'error' });
    await expect(adapter.send(h, { text: 'again' })).rejects.toThrow(/has ended/);
    await adapter.close(h);
    expect(adapter.status(h)).toBe('done');
  });

  it('scrubs a Worker token split across two deltas (#109)', async () => {
    const token = 'w0rkerT0ken-abcdef123456';
    const adapter = new CodexAppServerAdapter({
      codexPath: FAKE,
      // The fake app-server is steered by FAKE_* variables (#147: passed through on purpose).
      envPolicy: { pass: ['FAKE_*'] },
      killTimeoutMs: 1000,
      baseEnv: {
        PATH: process.env.PATH,
        HOME: root,
        OPENAI_API_KEY: FAKE_KEY,
        FAKE_MODE: 'split-delta',
        FAKE_DELTAS: JSON.stringify([`echo ${token.slice(0, 9)}`, `${token.slice(9)} done`]),
        FAKE_LOG: join(root, 'log.jsonl'),
      },
    });
    const h = await adapter.start({
      cwd: root,
      mcpServers: [
        {
          name: 'tacet',
          url: 'http://127.0.0.1:1/mcp',
          headers: { authorization: `Bearer ${token}` },
        },
      ],
    });
    const tap = new EventTap(adapter.events(h));
    await adapter.send(h, { text: 'go' });
    await tap.waitFor((e) => e.t === 'status' && e.state === 'idle', 5000, 1);
    const deltas = tap.events.flatMap((e) => (e.t === 'message.delta' ? [e.text] : []));
    expect(JSON.stringify(tap.events)).not.toContain(token.slice(0, 9));
    expect(deltas.join('')).toBe('echo [redacted] done');
    await adapter.close(h);
  });

  it('maps a failed turn to error with its message', async () => {
    const adapter = make('normal');
    const h = await adapter.start({ cwd: root });
    const tap = new EventTap(adapter.events(h));
    await adapter.send(h, { text: 'go' });
    const end = await tap.waitFor((e) => e.t === 'status' && e.state === 'error', 5000);
    expect(end.event).toMatchObject({ message: 'model overloaded' });
    await adapter.close(h);
  });

  it('never answers a ChatGPT token refresh with tokens', async () => {
    const adapter = make('refresh');
    const h = await adapter.start({ cwd: root });
    await adapter.send(h, { text: 'go' });
    await expect
      .poll(() => clientLog().find((m) => m.id === 900))
      .toMatchObject({ error: { code: -32601 } });
    expect(clientLog().some((m) => m.method === 'account/login/start')).toBe(false);
    await adapter.close(h);
  });

  it('reports auth_required when the own-login route has no login', async () => {
    const adapter = make('normal', { authRoute: 'subscription', mode: 'interactive' });
    const h = await adapter.start({ cwd: root });
    expect(adapter.status(h)).toBe('auth_required');
    expect(clientLog().find((m) => m.method === 'thread/start')).toBeDefined();
    await adapter.close(h);
  });

  it('passes MCP servers as thread config and scrubs their tokens from events', async () => {
    const token = 'SECRETVALUE12345';
    const adapter = make('approval');
    const h = await adapter.start({
      cwd: root,
      mcpServers: [
        { name: 'tacet', url: 'http://127.0.0.1:1/mcp', headers: { 'x-tacet-token': token } },
      ],
    });
    const tap = new EventTap(adapter.events(h));
    await adapter.send(h, { text: 'go' });
    const req = await tap.waitFor((e) => e.t === 'approval.request', 5000);
    expect(JSON.stringify(req.event)).not.toContain(token);
    const start = clientLog().find((m) => m.method === 'thread/start');
    expect(start.params.config.mcp_servers.tacet).toEqual({
      url: 'http://127.0.0.1:1/mcp',
      http_headers: { 'x-tacet-token': token },
    });
    // close() with the approval pending denies it and does not hang.
    await adapter.close(h);
    expect(clientLog().find((m) => m.id === 901)).toMatchObject({ result: { decision: 'cancel' } });
  });

  it.runIf(process.platform !== 'win32')(
    'close() ends the process tree, not just app-server',
    async () => {
      const adapter = make('child');
      const h = await adapter.start({ cwd: root });
      const childPid = clientLog().find((m) => m.childPid)?.childPid as number;
      expect(childPid).toBeGreaterThan(0);
      await adapter.close(h);
      // A killed child can linger as a zombie until init reaps it; that counts as gone.
      const state = () => {
        try {
          process.kill(childPid, 0);
        } catch {
          return 'gone';
        }
        if (process.platform !== 'linux') return 'alive';
        try {
          const stat = readFileSync(`/proc/${childPid}/stat`, 'utf8');
          return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z') ? 'gone' : 'alive';
        } catch {
          return 'gone';
        }
      };
      await expect.poll(state, { timeout: 5000 }).toBe('gone');
    },
  );

  it('queues input sent during a turn and reports it in the interrupt receipt', async () => {
    const adapter = make('approval');
    const h = await adapter.start({ cwd: root });
    const tap = new EventTap(adapter.events(h));
    await adapter.send(h, { text: 'first' });
    await adapter.send(h, { text: 'second' });
    await tap.waitFor((e) => e.t === 'approval.request', 5000);
    expect(await adapter.interrupt(h)).toEqual({ stillQueued: ['second'] });
    expect(clientLog().find((m) => m.method === 'turn/interrupt')).toMatchObject({
      params: { threadId: 'thread-1', turnId: 'turn-1' },
    });
    // The first turn ends cancelled, then the queued input runs as its own turn.
    const states = () => tap.events.flatMap((e) => (e.t === 'status' ? [e.state] : []));
    await expect.poll(states).toEqual(['idle', 'running', 'cancelled', 'running', 'idle']);
    expect(
      clientLog()
        .filter((m) => m.method === 'turn/start')
        .map((m) => m.params.input[0].text),
    ).toEqual(['first', 'second']);
    await adapter.close(h);
  });

  it('interrupts a turn whose turn/start has not answered yet', async () => {
    const adapter = make('slow-start');
    const h = await adapter.start({ cwd: root });
    const tap = new EventTap(adapter.events(h));
    await adapter.send(h, { text: 'go' });
    expect(await adapter.interrupt(h)).toEqual({ stillQueued: [] });
    expect(clientLog().find((m) => m.method === 'turn/interrupt')).toMatchObject({
      params: { turnId: 'turn-1' },
    });
    await tap.waitFor((e) => e.t === 'status' && e.state === 'cancelled', 5000);
    await adapter.close(h);
  });

  it('survives Codex closing its input (EPIPE) and reports the session as failed', async () => {
    const adapter = make('close-stdin');
    const h = await adapter.start({ cwd: root });
    const tap = new EventTap(adapter.events(h));
    await new Promise((r) => setTimeout(r, 150));
    // These writes go to a closed pipe; they must not take down this process.
    await adapter.send(h, { text: 'one' }).catch(() => {});
    await adapter.send(h, { text: 'two' }).catch(() => {});
    await tap.done;
    expect(tap.events.at(-1)).toMatchObject({ t: 'status', state: 'error' });
    await adapter.close(h);
  });

  it('reports an output close during turn/start once, and starts nothing after it', async () => {
    const adapter = make('drop-stdout');
    const h = await adapter.start({ cwd: root });
    const tap = new EventTap(adapter.events(h));
    await adapter.send(h, { text: 'one' });
    await adapter.send(h, { text: 'two' });
    await tap.done;
    const states = tap.events.flatMap((e) => (e.t === 'status' ? [e.state] : []));
    expect(states).toEqual(['idle', 'running', 'error']);
    expect(clientLog().filter((m) => m.method === 'turn/start')).toHaveLength(1);
    await adapter.close(h);
  });

  it('reports an unexpected exit while idle as error, with the exit code', async () => {
    const adapter = make('exit-idle');
    const h = await adapter.start({ cwd: root });
    const tap = new EventTap(adapter.events(h));
    await tap.done;
    expect(tap.events.at(-1)).toMatchObject({
      t: 'status',
      state: 'error',
      message: expect.stringContaining('code 5'),
    });
    await adapter.close(h);
  });

  it('cancelling a permissions request denies it and interrupts the turn', async () => {
    const adapter = make('permissions');
    const h = await adapter.start({ cwd: root });
    const tap = new EventTap(adapter.events(h));
    await adapter.send(h, { text: 'go' });
    const req = await tap.waitFor((e) => e.t === 'approval.request', 5000);
    if (req.event.t !== 'approval.request') throw new Error('unreachable');
    await adapter.respond(h, req.event.id, { kind: 'cancel', persist: false });
    await tap.waitFor((e) => e.t === 'status' && e.state === 'cancelled', 5000);
    await expect
      .poll(() => clientLog().find((m) => m.id === 902))
      .toMatchObject({ result: { permissions: {}, scope: 'turn' } });
    // The denial reaches Codex before the interrupt.
    const order = clientLog().flatMap((m) =>
      m.id === 902 ? ['reply'] : m.method === 'turn/interrupt' ? ['interrupt'] : [],
    );
    expect(order).toEqual(['reply', 'interrupt']);
    await adapter.close(h);
  });

  it('a permissions grant wider than the request is cut down to it', async () => {
    const adapter = make('permissions');
    const h = await adapter.start({ cwd: root });
    const tap = new EventTap(adapter.events(h));
    await adapter.send(h, { text: 'go' });
    const req = await tap.waitFor((e) => e.t === 'approval.request', 5000);
    if (req.event.t !== 'approval.request') throw new Error('unreachable');
    await adapter.respond(h, req.event.id, {
      kind: 'allow_once',
      persist: false,
      grant: { network: { enabled: true }, fileSystem: { write: ['/w', '/etc'] }, root: true },
    });
    await expect
      .poll(() => clientLog().find((m) => m.id === 902))
      .toMatchObject({
        result: { permissions: { network: { enabled: true }, fileSystem: { write: ['/w'] } } },
      });
    expect(JSON.stringify(clientLog().find((m) => m.id === 902))).not.toContain('/etc');
    await adapter.close(h);
  });
});
