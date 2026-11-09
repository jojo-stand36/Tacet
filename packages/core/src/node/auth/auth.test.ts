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
  removeRuntimeFile,
  SESSION_RESPONSE_HEADERS,
  Secret,
  sessionResponseBody,
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
    expect(checkHostAndOrigin({ host, origin }, port, 'browser').ok).toBe(false);
  });

  it.each(['http://127.0.0.1:4100', 'http://[::1]:4100', 'HTTP://LOCALHOST:4100'])(
    'accepts Origin %s',
    (origin) => {
      expect(checkHostAndOrigin({ host, origin }, port, 'browser').ok).toBe(true);
    },
  );

  it('requires an Origin on browser requests, not on bearer requests', () => {
    expect(checkHostAndOrigin({ host }, port, 'browser').ok).toBe(false);
    expect(checkHostAndOrigin({ host, origin: '' }, port, 'browser').ok).toBe(false);
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
      upgradeAuth: 'bearer',
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
      upgradeAuth: 'bearer',
      onHello: () => {
        throw new Error('unknown repo');
      },
    });
    expect(g.handle(hello([1]))).toMatchObject({ kind: 'close' });
    expect(g.open).toBe(false);
    expect(g.handle(hello([1]))).toMatchObject({ kind: 'close' });
  });

  it('opens a UI hello only with a valid browser session token, and hides the token', () => {
    const sessions = new BrowserSessions();
    const token = sessions.create().reveal();
    const seen: unknown[] = [];
    const uiGate = () =>
      new HelloGate({
        versions: [1],
        serverInfo: { name: 'c', version: '0' },
        newSessionId: () => 's',
        upgradeAuth: 'none',
        verifyBrowserSession: (t) => sessions.validate(t),
        onHello: (p) => seen.push(p),
      });
    const uiHello = (sessionToken?: string) =>
      hello([1], { role: 'ui', ...(sessionToken === undefined ? {} : { sessionToken }) });

    const ok = uiGate();
    expect(ok.handle(uiHello(token))).toMatchObject({ kind: 'reply' });
    expect(JSON.stringify(seen)).not.toContain(token);
    expect(seen[0]).toMatchObject({ role: 'ui' });

    for (const [label, frame] of [
      ['forged', uiHello('forged')],
      ['missing', uiHello()],
    ] as const) {
      const action = uiGate().handle(frame);
      expect(action.kind, label).toBe('close');
      expect(JSON.stringify(action), label).not.toContain(token);
    }
    expect(uiGate().handle(uiHello('forged'))).toMatchObject({ kind: 'close', code: 4401 });

    sessions.revoke(token);
    expect(uiGate().handle(uiHello(token))).toMatchObject({ kind: 'close', code: 4401 });
  });

  it('on an unauthenticated upgrade, refuses every role except ui (no cli/mini spoofing)', () => {
    const sessions = new BrowserSessions();
    const token = sessions.create().reveal();
    const noAuth = () =>
      new HelloGate({
        versions: [1],
        serverInfo: { name: 'c', version: '0' },
        newSessionId: () => 's',
        upgradeAuth: 'none',
        verifyBrowserSession: (t) => sessions.validate(t),
      });
    expect(noAuth().handle(hello([1]))).toMatchObject({ kind: 'close', code: 4401 });
    const miniHello = hello([1], {
      role: 'mini',
      repoId: 'r',
      repoPath: '/r',
      adapters: [],
      miniVersion: '0',
    });
    expect(noAuth().handle(miniHello)).toMatchObject({ kind: 'close', code: 4401 });
    expect(noAuth().handle(hello([1], { role: 'ui', sessionToken: token }))).toMatchObject({
      kind: 'reply',
    });
  });

  it('checks the browser session before the protocol version, and fails closed if the verifier throws', () => {
    const sessions = new BrowserSessions();
    const token = sessions.create().reveal();
    const make = (verify: (t: string) => boolean) =>
      new HelloGate({
        versions: [1],
        serverInfo: { name: 'c', version: '0' },
        newSessionId: () => 's',
        upgradeAuth: 'none',
        verifyBrowserSession: verify,
      });
    expect(make(() => false).handle(hello([9], { role: 'ui', sessionToken: token }))).toMatchObject(
      {
        code: 4401,
      },
    );
    const throwing = make(() => {
      throw new Error('db down');
    });
    expect(throwing.handle(hello([1], { role: 'ui', sessionToken: token }))).toMatchObject({
      kind: 'close',
      code: 4401,
    });
    expect(throwing.handle(hello([1], { role: 'ui', sessionToken: token }))).toMatchObject({
      kind: 'close',
    });
  });

  it('refuses every UI hello when no browser-session verifier is configured', () => {
    const sessions = new BrowserSessions();
    const token = sessions.create().reveal();
    expect(gate().handle(hello([1], { role: 'ui', sessionToken: token }))).toMatchObject({
      kind: 'close',
      code: 4401,
    });
  });

  it('answers a valid hello with the highest common version, then passes frames through', () => {
    const g = new HelloGate({
      versions: [1, 2],
      serverInfo: { name: 'c', version: '0' },
      newSessionId: () => 's9',
      upgradeAuth: 'bearer',
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

  it('works once, then never again, and returns a session token in the body, never a cookie', () => {
    const codes = new OneTimeCodes();
    const sessions = new BrowserSessions();
    const code = codes.issue();
    const first = exchangeCode(codes, sessions, code.reveal());
    expect(exchangeCode(codes, sessions, code.reveal())).toEqual({ ok: false, httpStatus: 401 });
    if (!first.ok) throw new Error('unreachable');
    expect(first).not.toHaveProperty('setCookie');
    expect(inspect(first)).not.toContain(first.token.reveal());
    expect(JSON.stringify(first)).not.toContain(first.token.reveal());
    const { sessionToken } = JSON.parse(sessionResponseBody(first.token)) as {
      sessionToken: string;
    };
    expect(first.token.equals(sessionToken)).toBe(true);
    expect(sessions.validate(sessionToken)).toBe(true);
    expect(sessions.validateHeader(`Bearer ${sessionToken}`)).toBe(true);
    expect(sessions.validateHeader(`Bearer forged`)).toBe(false);
    expect(sessions.validate('forged')).toBe(false);
    expect(Object.keys(SESSION_RESPONSE_HEADERS).map((h) => h.toLowerCase())).not.toContain(
      'set-cookie',
    );
    expect(SESSION_RESPONSE_HEADERS['cache-control']).toBe('no-store');
    expect(inspect(sessions)).not.toContain(sessionToken);
  });

  it('never sends Set-Cookie over HTTP, and the token authenticates hello and Bearer calls', async () => {
    const codes = new OneTimeCodes();
    const sessions = new BrowserSessions();
    const code = codes.issue();
    const listener = await listenLoopback(() =>
      http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/auth/session') {
          const r = exchangeCode(codes, sessions, req.headers['x-code'] as string | undefined);
          if (!r.ok) return void res.writeHead(r.httpStatus).end();
          return void res
            .writeHead(200, SESSION_RESPONSE_HEADERS)
            .end(sessionResponseBody(r.token));
        }
        res.writeHead(sessions.validateHeader(req.headers.authorization) ? 200 : 401).end();
      }),
    );
    const call = (method: string, path: string, headers: Record<string, string>) =>
      new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>(
        (resolve, reject) => {
          const req = request(
            { host: '127.0.0.1', port: listener.port, method, path, headers },
            (res) => {
              let body = '';
              res.on('data', (c) => {
                body += c;
              });
              res.on('end', () =>
                resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
              );
            },
          );
          req.on('error', reject);
          req.end();
        },
      );
    try {
      const login = await call('POST', '/auth/session', { 'x-code': code.reveal() });
      expect(login.status).toBe(200);
      expect(login.headers['set-cookie']).toBeUndefined();
      const { sessionToken } = JSON.parse(login.body) as { sessionToken: string };
      const replay = await call('POST', '/auth/session', { 'x-code': code.reveal() });
      expect(replay.status).toBe(401);
      expect(replay.headers['set-cookie']).toBeUndefined();
      expect((await call('GET', '/api', { authorization: `Bearer ${sessionToken}` })).status).toBe(
        200,
      );
      expect((await call('GET', '/api', {})).status).toBe(401);
      sessions.revoke(sessionToken);
      expect((await call('GET', '/api', { authorization: `Bearer ${sessionToken}` })).status).toBe(
        401,
      );
    } finally {
      await listener.close();
    }
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
