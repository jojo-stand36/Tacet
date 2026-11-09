import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import http, { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BrowserSessions,
  CLOSE_NO_COMMON_VERSION,
  CLOSE_POLICY_VIOLATION,
  checkBearer,
  checkHostAndOrigin,
  exchangeCode,
  HelloGate,
  listenLoopback,
  mcpAuthHeaders,
  miniRuntimePath,
  OneTimeCodes,
  openUrl,
  readRuntimeFile,
  readSessionCookie,
  removeRuntimeFile,
  Secret,
  sessionCookieName,
  WorkerTokens,
  writeRuntimeFile,
} from '../index.js';

describe('Secret', () => {
  it('never prints its value through String, JSON, inspect or console', () => {
    const s = new Secret('super-secret-value');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    console.log(s, { s }, `${s}`);
    const printed = JSON.stringify(log.mock.calls.map((c) => c.map((x) => inspect(x))));
    log.mockRestore();
    for (const out of [String(s), JSON.stringify({ s }), inspect(s), inspect({ s }), printed]) {
      expect(out).not.toContain('super-secret-value');
    }
    expect(s.reveal()).toBe('super-secret-value');
  });

  it('compares bearer headers in constant time and rejects malformed ones', () => {
    const s = new Secret('abc123');
    expect(checkBearer('Bearer abc123', s)).toBe(true);
    expect(checkBearer('bearer abc123', s)).toBe(true);
    expect(checkBearer('Bearer abc124', s)).toBe(false);
    expect(checkBearer('Basic abc123', s)).toBe(false);
    expect(checkBearer('Bearer abc123 extra', s)).toBe(false);
    expect(checkBearer(undefined, s)).toBe(false);
  });
});

describe('runtime file', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tacet-auth-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes a 0600 file in a 0700 dir with a 256-bit token, and rotates it on every start', () => {
    const path = join(dir, 'run', 'conductor.json');
    const a = writeRuntimeFile({ path, port: 4100, protocolVersions: [1] });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'run')).mode & 0o777).toBe(0o700);
    expect(Buffer.from(a.token.reveal(), 'base64url')).toHaveLength(32);
    const read = readRuntimeFile(path);
    expect(read.token.equals(a.token.reveal())).toBe(true);
    expect([read.port, read.protocolVersions, read.pid]).toEqual([4100, [1], process.pid]);

    const b = writeRuntimeFile({ path, port: 4101, protocolVersions: [1] });
    expect(b.token.equals(a.token.reveal())).toBe(false);
    expect(readRuntimeFile(path).token.equals(b.token.reveal())).toBe(true);
    expect(readdirSync(join(dir, 'run'))).toEqual(['conductor.json']);
  });

  it('tightens an existing run dir to 0700', () => {
    mkdirSync(join(dir, 'run'), { mode: 0o755 });
    chmodSync(join(dir, 'run'), 0o755);
    writeRuntimeFile({ path: join(dir, 'run', 'c.json'), port: 1, protocolVersions: [1] });
    expect(statSync(join(dir, 'run')).mode & 0o777).toBe(0o700);
  });

  it('refuses a run dir that is a symlink', () => {
    mkdirSync(join(dir, 'elsewhere'));
    symlinkSync(join(dir, 'elsewhere'), join(dir, 'run'));
    expect(() =>
      writeRuntimeFile({ path: join(dir, 'run', 'c.json'), port: 1, protocolVersions: [1] }),
    ).toThrow(/not a directory/);
  });

  it('refuses to read a file others can read', () => {
    const path = join(dir, 'conductor.json');
    writeRuntimeFile({ path, port: 4100, protocolVersions: [1] });
    chmodSync(path, 0o644);
    expect(() => readRuntimeFile(path)).toThrow(/mode 644/);
  });

  it('refuses to follow a symlink at the runtime file path', () => {
    const real = join(dir, 'real.json');
    writeRuntimeFile({ path: real, port: 4100, protocolVersions: [1] });
    symlinkSync(real, join(dir, 'link.json'));
    expect(() => readRuntimeFile(join(dir, 'link.json'))).toThrow(/cannot open runtime file/);
  });

  it('does not leak the token in errors for a corrupt or malformed file', () => {
    const token = 'SECRETTOKENVALUE0123456789abcdef';
    for (const [name, body] of [
      ['corrupt.json', `{"token":${token}}`],
      ['shape.json', JSON.stringify({ token, port: 'x' })],
    ] as const) {
      const path = join(dir, name);
      writeFileSync(path, body, { mode: 0o600 });
      let message = '';
      try {
        readRuntimeFile(path);
      } catch (err) {
        message = `${String(err)} ${inspect(err)}`;
      }
      expect(message).toMatch(/runtime file/);
      expect(message).not.toContain('SECRETTOKEN');
    }
  });

  it('removes the file only while it still holds our token', () => {
    const path = join(dir, 'conductor.json');
    const old = writeRuntimeFile({ path, port: 1, protocolVersions: [1] });
    const current = writeRuntimeFile({ path, port: 2, protocolVersions: [1] });
    expect(removeRuntimeFile(path, old.token)).toBe(false);
    expect(removeRuntimeFile(path, current.token)).toBe(true);
    expect(removeRuntimeFile(path, current.token)).toBe(false);
  });

  it('keys mini files by repo path, outside the repo', () => {
    const p = miniRuntimePath('/src/api', dir);
    expect(p).toBe(miniRuntimePath('/src/api/', dir));
    expect(p).not.toBe(miniRuntimePath('/src/web', dir));
    expect(p.startsWith(join(dir, 'minis'))).toBe(true);
  });

  it('does not put the token in the returned object when logged', () => {
    const info = writeRuntimeFile({ path: join(dir, 'c.json'), port: 1, protocolVersions: [1] });
    expect(inspect(info)).not.toContain(info.token.reveal());
    expect(JSON.stringify(info)).not.toContain(info.token.reveal());
    expect(readFileSync(join(dir, 'c.json'), 'utf8')).toContain(info.token.reveal());
  });
});

describe('Host and Origin checks', () => {
  const port = 4100;
  const host = '127.0.0.1:4100';

  it.each(['127.0.0.1:4100', '[::1]:4100', 'localhost:4100', 'LOCALHOST:4100'])(
    'accepts Host %s',
    (h) => {
      expect(checkHostAndOrigin({ host: h }, port, 'bearer').ok).toBe(true);
    },
  );

  it.each([
    ['DNS rebinding name', 'attacker.example:4100'],
    ['loopback lookalike', '127.0.0.1.attacker.example:4100'],
    ['trailing dot', 'localhost.:4100'],
    ['expanded IPv6 loopback', '[0:0:0:0:0:0:0:1]:4100'],
    ['wrong port', '127.0.0.1:4101'],
    ['no port', '127.0.0.1'],
    ['missing', undefined],
    ['wildcard', '0.0.0.0:4100'],
  ])('rejects Host: %s', (_label, h) => {
    expect(checkHostAndOrigin({ host: h }, port, 'bearer')).toMatchObject({
      ok: false,
      httpStatus: 403,
      wsCloseCode: 4401,
    });
  });

  it.each([
    ['foreign site', 'http://attacker.example'],
    ['null origin', 'null'],
    ['trailing dot', 'http://localhost.:4100'],
    ['path suffix', 'http://127.0.0.1:4100/'],
    ['https scheme', 'https://127.0.0.1:4100'],
    ['other loopback port', 'http://127.0.0.1:4101'],
  ])('rejects Origin: %s', (_label, origin) => {
    expect(checkHostAndOrigin({ host, origin }, port, 'bearer').ok).toBe(false);
    expect(checkHostAndOrigin({ host, origin }, port, 'cookie').ok).toBe(false);
  });

  it.each(['http://127.0.0.1:4100', 'http://[::1]:4100', 'HTTP://LOCALHOST:4100'])(
    'accepts Origin %s',
    (origin) => {
      expect(checkHostAndOrigin({ host, origin }, port, 'cookie').ok).toBe(true);
    },
  );

  it('requires an Origin on cookie requests, not on bearer requests', () => {
    expect(checkHostAndOrigin({ host }, port, 'cookie').ok).toBe(false);
    expect(checkHostAndOrigin({ host, origin: '' }, port, 'cookie').ok).toBe(false);
    expect(checkHostAndOrigin({ host }, port, 'bearer').ok).toBe(true);
  });

  it('rejects a DNS-rebinding request against a real loopback server', async () => {
    const listener = await listenLoopback(() =>
      http.createServer((req, res) => {
        const check = checkHostAndOrigin(
          { host: req.headers.host, origin: req.headers.origin },
          listener.port,
          'bearer',
        );
        res.writeHead(check.ok ? 200 : check.httpStatus).end();
      }),
    );
    const get = (h: string) =>
      new Promise<number>((resolve, reject) => {
        const req = request(
          { host: '127.0.0.1', port: listener.port, path: '/', headers: { host: h } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.end();
      });
    try {
      expect(await get(`127.0.0.1:${listener.port}`)).toBe(200);
      expect(await get(`attacker.example:${listener.port}`)).toBe(403);
    } finally {
      await listener.close();
    }
  });
});

describe('loopback binding', () => {
  it('listens only on loopback addresses, never a wildcard', async () => {
    const listener = await listenLoopback(() => http.createServer());
    try {
      for (const a of listener.servers.map((s) => s.address())) {
        if (a === null || typeof a === 'string') throw new Error('expected an inet address');
        expect(['127.0.0.1', '::1']).toContain(a.address);
        expect(a.port).toBe(listener.port);
      }
    } finally {
      await listener.close();
    }
  });

  /** A server whose `listen` on ::1 fails with `code` the first `times` times. */
  const failingV6 = (code: string, times: number) => {
    let failures = 0;
    return () => {
      const server = http.createServer();
      const listen = server.listen.bind(server);
      server.listen = ((opts: { host?: string }) => {
        if (opts.host === '::1' && failures < times) {
          failures++;
          queueMicrotask(() => server.emit('error', Object.assign(new Error(code), { code })));
          return server;
        }
        return listen(opts);
      }) as unknown as typeof server.listen;
      return server;
    };
  };

  it('falls back to IPv4 only when the IPv6 loopback is unavailable', async () => {
    const listener = await listenLoopback(failingV6('EADDRNOTAVAIL', 1));
    try {
      expect(listener.servers).toHaveLength(1);
      const a = listener.servers[0]?.address();
      expect(typeof a === 'object' && a?.address).toBe('127.0.0.1');
    } finally {
      await listener.close();
    }
  });

  it('retries with a new port when the IPv6 side of a port is taken', async () => {
    const listener = await listenLoopback(failingV6('EADDRINUSE', 2));
    try {
      expect(listener.port).toBeGreaterThan(0);
    } finally {
      await listener.close();
    }
  });
});

describe('tacet/hello gate', () => {
  const gate = () =>
    new HelloGate({
      versions: [1],
      serverInfo: { name: 'conductor', version: '0' },
      newSessionId: () => 's1',
    });
  const hello = (versions: number[], extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tacet/hello',
      params: {
        role: 'cli',
        protocolVersions: versions,
        clientInfo: { name: 'tacet', version: '0' },
        ...extra,
      },
    });

  it('closes a socket whose first frame is not tacet/hello', () => {
    const g = gate();
    const action = g.handle(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'GetTask' }));
    expect(action).toMatchObject({
      kind: 'close',
      code: CLOSE_POLICY_VIOLATION,
      message: { id: 7, error: { code: -32600 } },
    });
    expect(g.open).toBe(false);
  });

  it.each([
    ['a notification', JSON.stringify({ jsonrpc: '2.0', method: 'tacet/hello', params: {} })],
    ['invalid JSON', '{nope'],
    ['a batch', `[${hello([1])}]`],
    ['a missing jsonrpc version', hello([1]).replace('"jsonrpc":"2.0",', '')],
    [
      'bad params',
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tacet/hello', params: { role: 'x' } }),
    ],
    ['a mini hello without its Agent Card', hello([1], { role: 'mini' })],
  ])('closes on %s', (_label, frame) => {
    expect(gate().handle(frame)).toMatchObject({ kind: 'close', code: CLOSE_POLICY_VIOLATION });
  });

  it('closes on a binary first frame', () => {
    expect(gate().handleBinary()).toMatchObject({ kind: 'close', code: CLOSE_POLICY_VIOLATION });
  });

  it('closes with 4406 when no protocol version matches, without leaking anything sensitive', () => {
    const action = gate().handle(hello([2, 3]));
    expect(action).toMatchObject({ kind: 'close', code: CLOSE_NO_COMMON_VERSION });
    expect(JSON.stringify(action)).toContain('supported protocol versions: 1');
  });

  it('stays closed after a failure, even if a valid hello follows', () => {
    const g = gate();
    g.handle('{nope');
    expect(g.handle(hello([1]))).toMatchObject({ kind: 'close' });
    expect(g.handleBinary()).toMatchObject({ kind: 'close' });
    expect(g.open).toBe(false);

    const v = gate();
    v.handle(hello([9]));
    expect(v.handle(hello([1]))).toMatchObject({ kind: 'close' });
  });

  it('does not open when onHello throws', () => {
    const g = new HelloGate({
      versions: [1],
      serverInfo: { name: 'c', version: '0' },
      newSessionId: () => 's',
      onHello: () => {
        throw new Error('unknown repo');
      },
    });
    expect(g.handle(hello([1]))).toMatchObject({ kind: 'close' });
    expect(g.open).toBe(false);
    expect(g.handle(hello([1]))).toMatchObject({ kind: 'close' });
  });

  it('answers a valid hello with the highest common version, then passes frames through', () => {
    const g = new HelloGate({
      versions: [1, 2],
      serverInfo: { name: 'c', version: '0' },
      newSessionId: () => 's9',
    });
    expect(g.handle(hello([1, 2, 3]))).toMatchObject({
      kind: 'reply',
      message: { id: 1, result: { protocolVersion: 2, sessionId: 's9' } },
    });
    expect(g.open).toBe(true);
    expect(g.handle('{"jsonrpc":"2.0","id":2,"method":"GetTask"}')).toEqual({ kind: 'pass' });
    expect(g.handleBinary()).toEqual({ kind: 'pass' });
  });
});

describe('one-time code browser login', () => {
  const port = 4100;

  it('works once, then never again, and sets a per-port HttpOnly SameSite=Strict cookie', () => {
    const codes = new OneTimeCodes();
    const sessions = new BrowserSessions();
    const code = codes.issue();
    const first = exchangeCode(codes, sessions, code.reveal(), port);
    expect(first.ok).toBe(true);
    expect(exchangeCode(codes, sessions, code.reveal(), port)).toEqual({
      ok: false,
      httpStatus: 401,
    });
    if (!first.ok) throw new Error('unreachable');
    expect(first.setCookie.startsWith(`${sessionCookieName(port)}=`)).toBe(true);
    expect(first.setCookie).toMatch(/; HttpOnly; SameSite=Strict; Path=\/$/);
    const cookie = `other=1; ${first.setCookie.split(';')[0]}`;
    expect(sessions.validate(readSessionCookie(cookie, port))).toBe(true);
    expect(readSessionCookie(cookie, 4101)).toBeUndefined();
    expect(sessions.validate('forged')).toBe(false);
  });

  it('expires after 60 s', () => {
    let now = 1_000_000;
    const codes = new OneTimeCodes({ now: () => now });
    const fresh = codes.issue();
    const stale = codes.issue();
    now += 59_999;
    expect(codes.redeem(fresh.reveal())).toBe(true);
    now += 1;
    expect(codes.redeem(stale.reveal())).toBe(false);
  });

  it('rejects unknown and empty codes, and puts the code only in the URL fragment', () => {
    const codes = new OneTimeCodes();
    expect(codes.redeem('guess')).toBe(false);
    expect(codes.redeem('')).toBe(false);
    const code = codes.issue();
    const url = new URL(openUrl(port, code));
    expect(url.hash).toBe(`#code=${code.reveal()}`);
    expect(url.search).toBe('');
    expect(url.hostname).toBe('127.0.0.1');
    expect(inspect(codes)).not.toContain(code.reveal());
  });

  it('caps the number of sessions, evicting the oldest', () => {
    const sessions = new BrowserSessions({ max: 2 });
    const a = sessions.create();
    const b = sessions.create();
    const c = sessions.create();
    expect(sessions.validate(a.reveal())).toBe(false);
    expect(sessions.validate(b.reveal())).toBe(true);
    expect(sessions.validate(c.reveal())).toBe(true);
  });
});

describe('per-worker MCP tokens', () => {
  it('binds a token to one worker session and task', () => {
    const tokens = new WorkerTokens();
    const a = tokens.mint({ workerSessionId: 'w1', taskId: 'task-a' });
    const b = tokens.mint({ workerSessionId: 'w2', taskId: 'task-b' });
    expect(tokens.resolve(a.reveal())).toEqual({ workerSessionId: 'w1', taskId: 'task-a' });
    expect(tokens.resolveHeader(mcpAuthHeaders(b).Authorization)).toEqual({
      workerSessionId: 'w2',
      taskId: 'task-b',
    });
    expect(tokens.authorize(a.reveal(), { taskId: 'task-b' })).toBeUndefined();
    expect(tokens.authorize(a.reveal(), { workerSessionId: 'w2' })).toBeUndefined();
    expect(tokens.authorize(a.reveal(), { taskId: 'task-a' })).toEqual({
      workerSessionId: 'w1',
      taskId: 'task-a',
    });
  });

  it('rejects a token after revocation, and on re-mint for the same session', () => {
    const tokens = new WorkerTokens();
    const first = tokens.mint({ workerSessionId: 'w1', taskId: 't' });
    const other = tokens.mint({ workerSessionId: 'w2', taskId: 't' });
    const second = tokens.mint({ workerSessionId: 'w1', taskId: 't' });
    expect(tokens.resolve(first.reveal())).toBeUndefined();
    expect(tokens.revoke('w1')).toBe(true);
    expect(tokens.resolve(second.reveal())).toBeUndefined();
    expect(tokens.resolve(other.reveal())).toEqual({ workerSessionId: 'w2', taskId: 't' });
    tokens.revokeAll();
    expect(tokens.resolve(other.reveal())).toBeUndefined();
    expect(tokens.size).toBe(0);
  });

  it('never exposes token values when inspected', () => {
    const tokens = new WorkerTokens();
    const t = tokens.mint({ workerSessionId: 'w1', taskId: 't' });
    expect(inspect(tokens, { showHidden: true, depth: 5 })).not.toContain(t.reveal());
  });
});
