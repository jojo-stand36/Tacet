import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { EventTap } from '@tacet/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodexAppServerAdapter, toCodexDecision } from './adapter.js';
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
    const adapter = make('normal', { authRoute: 'subscription' });
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
    await adapter.close(h);
  });
});
