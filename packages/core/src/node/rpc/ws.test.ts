import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { randomToken, Secret } from '../auth/secret.js';
import { connectRpc, RpcClientError } from './ws-client.js';
import { RpcError, type RpcServer, startRpcServer } from './ws-server.js';

const servers: RpcServer[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function serve(token = randomToken(), extra: { maxPayload?: number } = {}) {
  const errors: string[] = [];
  const server = await startRpcServer({
    token,
    serverInfo: { name: 'test', version: '0' },
    handlers: {
      echo: (params) => params,
      boom: () => {
        throw new Error('/secret/path/in/a/message');
      },
      refuse: () => {
        throw new RpcError(-32001, 'task not found');
      },
    },
    onError: (m) => errors.push(m),
    ...extra,
  });
  servers.push(server);
  return { server, token, errors };
}

const client = (port: number, token: Secret) =>
  connectRpc({ port, token, clientInfo: { name: 'test', version: '0' }, timeoutMs: 5000 });

/** A raw upgrade request with exactly these headers: its HTTP status, or 101 if upgraded. */
function upgrade(port: number, headers: Record<string, string>, path = '/'): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': randomBytes(16).toString('base64'),
        ...headers,
      },
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.on('error', reject);
    req.end();
  });
}

/** A raw socket after a good upgrade, to send frames the client would never send. */
function rawSocket(port: number, token: Secret): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`, {
    headers: { authorization: `Bearer ${token.reveal()}` },
  });
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

const closed = (ws: WebSocket) =>
  new Promise<{ code: number; messages: unknown[] }>((resolve) => {
    const messages: unknown[] = [];
    ws.on('message', (d) => messages.push(JSON.parse(d.toString())));
    ws.once('close', (code) => resolve({ code, messages }));
  });

const hello = (role = 'cli', versions = [1]) =>
  JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tacet/hello',
    params: {
      protocolVersions: versions,
      role,
      clientInfo: { name: 't', version: '0' },
      capabilities: {},
    },
  });

describe('Tacet RPC server security (#201, ADR-003 §3)', () => {
  it('listens on loopback addresses only, never a wildcard', async () => {
    const { server } = await serve();
    expect(server.addresses().length).toBeGreaterThan(0);
    for (const a of server.addresses()) expect(['127.0.0.1', '::1']).toContain(a);
  });

  it('refuses an upgrade without the bearer token, or with a wrong one of the same length', async () => {
    const { server, token } = await serve();
    const host = `127.0.0.1:${server.port}`;
    expect(await upgrade(server.port, { host })).toBe(401);
    const wrong = 'x'.repeat(token.reveal().length);
    expect(await upgrade(server.port, { host, authorization: `Bearer ${wrong}` })).toBe(401);
    expect(await upgrade(server.port, { host, authorization: `Bearer ${token.reveal()}` })).toBe(
      101,
    );
  });

  it('compares the token in constant time (through Secret.equals)', async () => {
    const { server, token } = await serve();
    const equals = vi.spyOn(Secret.prototype, 'equals');
    const auth = `Bearer ${'y'.repeat(token.reveal().length)}`;
    expect(
      await upgrade(server.port, { host: `127.0.0.1:${server.port}`, authorization: auth }),
    ).toBe(401);
    expect(equals).toHaveBeenCalledWith('y'.repeat(token.reveal().length));
  });

  it('refuses a non-loopback Host or a wrong port, before checking the token', async () => {
    const { server, token } = await serve();
    const authorization = `Bearer ${token.reveal()}`;
    for (const host of [
      `evil.test:${server.port}`,
      `127.0.0.1:${server.port + 1}`,
      '127.0.0.1',
      `127.0.0.2:${server.port}`,
    ]) {
      expect(await upgrade(server.port, { host, authorization }), host).toBe(403);
    }
    for (const host of [`localhost:${server.port}`, `[::1]:${server.port}`]) {
      expect(await upgrade(server.port, { host, authorization }), host).toBe(101);
    }
  });

  it("refuses a present Origin that is not this daemon's own", async () => {
    const { server, token } = await serve();
    const base = { host: `127.0.0.1:${server.port}`, authorization: `Bearer ${token.reveal()}` };
    for (const origin of ['http://evil.test', `http://127.0.0.1:${server.port + 1}`, 'null']) {
      expect(await upgrade(server.port, { ...base, origin }), origin).toBe(403);
    }
    expect(await upgrade(server.port, { ...base, origin: `http://127.0.0.1:${server.port}` })).toBe(
      101,
    );
  });

  it('serves only the root path, and plain HTTP gets no content', async () => {
    const { server, token } = await serve();
    const base = { host: `127.0.0.1:${server.port}`, authorization: `Bearer ${token.reveal()}` };
    expect(await upgrade(server.port, base, '/pty/x')).toBe(404);
    const status = await new Promise<number>((resolve) => {
      request({ host: '127.0.0.1', port: server.port, headers: { host: base.host } }, (res) =>
        resolve(res.statusCode ?? 0),
      ).end();
    });
    expect(status).toBe(426);
  });

  it('closes a socket whose first frame is not tacet/hello, or whose versions do not match', async () => {
    const { server, token } = await serve();
    const a = await rawSocket(server.port, token);
    const aClosed = closed(a);
    a.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'echo', params: {} }));
    const first = await aClosed;
    expect(first.code).toBe(1008);
    expect(first.messages[0]).toMatchObject({ error: { code: -32600 } });

    const b = await rawSocket(server.port, token);
    const bClosed = closed(b);
    b.send(hello('cli', [99]));
    expect((await bClosed).code).toBe(4406);
  });

  it('refuses a ui hello: browser sessions are not served here', async () => {
    const { server, token } = await serve();
    const ws = await rawSocket(server.port, token);
    const done = closed(ws);
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tacet/hello',
        params: {
          protocolVersions: [1],
          role: 'ui',
          sessionToken: 'anything',
          clientInfo: { name: 't', version: '0' },
          capabilities: {},
        },
      }),
    );
    expect((await done).code).toBe(4401);
  });

  it('closes a socket that sends a frame over the size limit', async () => {
    const { server, token } = await serve(randomToken(), { maxPayload: 1024 });
    const ws = await rawSocket(server.port, token);
    const done = closed(ws);
    ws.send(hello());
    ws.send('x'.repeat(4096));
    expect((await done).code).toBe(1009);
  });

  it('never puts the token in a reply, an error or a client error message', async () => {
    const { server, token, errors } = await serve();
    const c = await client(server.port, token);
    const replies = JSON.stringify([
      c.hello,
      await c.call('echo', { x: 1 }),
      await c.call('boom').catch((e: Error) => e.message),
      await c.call('nope').catch((e: Error) => e.message),
    ]);
    expect(replies).not.toContain(token.reveal());
    const bad = await client(server.port, randomToken()).catch((e: Error) => e);
    expect(bad).toBeInstanceOf(RpcClientError);
    expect(String((bad as Error).message)).toContain('401');
    expect(String((bad as Error).message)).not.toContain(token.reveal());
    expect(errors.join('\n')).not.toContain(token.reveal());
    await c.close();
  });
});

describe('Tacet RPC server limits (#201)', () => {
  it('refuses a hello role it does not serve', async () => {
    const token = randomToken();
    const server = await startRpcServer({
      token,
      serverInfo: { name: 'test', version: '0' },
      handlers: {},
      roles: ['cli'],
    });
    servers.push(server);
    const ws = await rawSocket(server.port, token);
    const done = closed(ws);
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tacet/hello',
        params: {
          protocolVersions: [1],
          role: 'mini',
          clientInfo: { name: 't', version: '0' },
          capabilities: {},
          repoId: 'r',
          repoPath: '/r',
          adapters: [],
          miniVersion: '0',
        },
      }),
    );
    const r = await done;
    expect(r.code).toBe(1008);
    expect(r.messages[0]).toMatchObject({ error: { message: 'hello rejected' } });
    expect((await client(server.port, token)).hello.protocolVersion).toBe(1);
  });

  it('closes a socket that never says hello', async () => {
    const token = randomToken();
    const server = await startRpcServer({
      token,
      serverInfo: { name: 'test', version: '0' },
      handlers: {},
      helloTimeoutMs: 200,
    });
    servers.push(server);
    const ws = await rawSocket(server.port, token);
    expect((await closed(ws)).code).toBe(1008);
  });

  it('answers -32000 beyond the requests one socket may have in flight', async () => {
    const token = randomToken();
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const server = await startRpcServer({
      token,
      serverInfo: { name: 'test', version: '0' },
      handlers: { wait: () => gate.then(() => 'done') },
      maxInFlight: 2,
    });
    servers.push(server);
    const c = await client(server.port, token);
    const a = c.call('wait');
    const b = c.call('wait');
    const ws = await rawSocket(server.port, token);
    // Per socket: a second socket has its own allowance.
    const other = await client(server.port, token);
    const third = c.call('wait', undefined, { timeoutMs: 500 });
    await expect(third).rejects.toMatchObject({ code: -32000, message: 'too many requests' });
    const fine = other.call('wait');
    release();
    expect(await Promise.all([a, b, fine])).toEqual(['done', 'done', 'done']);
    ws.close();
    await c.close();
    await other.close();
  });
});

describe('Tacet RPC server and client', () => {
  it('says hello, then answers calls with results and JSON-RPC errors', async () => {
    const { server, token, errors } = await serve();
    const c = await client(server.port, token);
    expect(c.hello).toMatchObject({ protocolVersion: 1, serverInfo: { name: 'test' } });
    expect(await c.call('echo', { a: [1, 2] })).toEqual({ a: [1, 2] });
    await expect(c.call('refuse')).rejects.toMatchObject({
      code: -32001,
      message: 'task not found',
    });
    await expect(c.call('nope')).rejects.toMatchObject({ code: -32601 });
    await expect(c.call('tacet/hello')).rejects.toMatchObject({ code: -32600 });
    // An internal error reaches the client generic; its message goes to onError only.
    await expect(c.call('boom')).rejects.toMatchObject({ code: -32603, message: 'internal error' });
    expect(errors).toEqual(['/secret/path/in/a/message']);
    await c.close();
  });

  it('fails a client cleanly when the server goes away, and refuses a closed port', async () => {
    const { server, token } = await serve();
    const c = await client(server.port, token);
    const port = server.port;
    await server.close();
    await expect(c.call('echo', {})).rejects.toBeInstanceOf(RpcClientError);
    await expect(client(port, token)).rejects.toBeInstanceOf(RpcClientError);
  });
});
