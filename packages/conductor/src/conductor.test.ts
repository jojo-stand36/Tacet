import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newUlid, type RegistryDisconnected } from '@tacet/core';
import {
  conductorRuntimePath,
  conductorStatePaths,
  connectRpc,
  openEventStore,
  readRuntimeFile,
  repoStatePaths,
} from '@tacet/core/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { type Conductor, startConductor } from './conductor.js';

describe('the Conductor daemon (#23)', () => {
  let root: string;
  let stateDir: string;
  let runDir: string;
  const running: Conductor[] = [];

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tacet-conductor-')));
    stateDir = join(root, 'state');
    runDir = join(root, 'run');
  });
  afterEach(async () => {
    await Promise.all(running.splice(0).map((c) => c.close()));
    rmSync(root, { recursive: true, force: true });
  });

  const start = async (more: Partial<Parameters<typeof startConductor>[0]> = {}) => {
    const c = await startConductor({ stateDir, runDir, ...more });
    running.push(c);
    return c;
  };
  const repo = (name: string) => {
    const dir = join(root, name);
    mkdirSync(dir);
    execFileSync('git', ['init', '-q', dir]);
    return dir;
  };
  const card = (path: string) => ({
    repoId: repoStatePaths(path).repoId,
    repoPath: path,
    adapters: ['claude-sdk'],
    miniVersion: '0.0.0',
  });
  const dial = (c: Conductor, path: string, cardOver: Partial<ReturnType<typeof card>> = {}) =>
    connectRpc({
      port: c.port,
      token: readRuntimeFile(conductorRuntimePath(runDir)).token,
      clientInfo: { name: 'test-mini', version: '0' },
      role: 'mini',
      card: { ...card(path), ...cardOver },
      timeoutMs: 5000,
    });
  /** A Mini-conductor that never answers pings: a hung or suspended process. */
  const silentMini = (c: Conductor, path: string) =>
    new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${c.port}/`, {
        headers: {
          authorization: `Bearer ${readRuntimeFile(conductorRuntimePath(runDir)).token.reveal()}`,
        },
        autoPong: false,
      });
      ws.once('error', reject);
      ws.once('open', () =>
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tacet/hello',
            params: {
              protocolVersions: [1],
              role: 'mini',
              clientInfo: { name: 'silent', version: '0' },
              capabilities: {},
              ...card(path),
            },
          }),
        ),
      );
      ws.once('message', () => resolve(ws));
    });
  const ended = () => openStoreRead().map((d) => d as RegistryDisconnected);
  const openStoreRead = () => {
    const s = openEventStore(conductorStatePaths(stateDir).events);
    try {
      return s.query({ typePrefix: 'registry.disconnected' }).map((e) => e.envelope.data);
    } finally {
      s.close();
    }
  };

  it('runs alone, on loopback, with a fresh token in a 0600 runtime file it removes', async () => {
    const c = await start();
    const info = readRuntimeFile(conductorRuntimePath(runDir));
    expect(info.port).toBe(c.port);
    expect(info.pid).toBe(process.pid);
    expect(statSync(conductorRuntimePath(runDir)).mode & 0o777).toBe(0o600);
    await expect(startConductor({ stateDir, runDir })).rejects.toThrow(/already running/);
    // No token, no upgrade.
    const refused = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${c.port}/`);
      ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.once('error', () => {});
    });
    expect(refused).toBe(401);
    await c.close();
    running.length = 0;
    expect(() => readRuntimeFile(conductorRuntimePath(runDir))).toThrow();
    // Free again, with a new token.
    const again = await start();
    expect(readRuntimeFile(conductorRuntimePath(runDir)).token.equals(info.token.reveal())).toBe(
      false,
    );
    expect(again.port).toBeGreaterThan(0);
  });

  it('records a Mini-conductor that dials in, unregistered, and its going', async () => {
    const c = await start();
    const path = repo('api');
    const mini = await dial(c, path);
    await vi.waitFor(() => expect(Object.keys(c.registry().connected)).toHaveLength(1));
    const [connected] = Object.values(c.registry().connected);
    expect(connected).toMatchObject({
      repoId: card(path).repoId,
      repoPath: path,
      sessionId: mini.hello.sessionId,
      adapters: ['claude-sdk'],
    });
    // A hello registers nothing: that is the user's act.
    expect(c.registry().repos).toEqual({});
    await mini.close();
    await vi.waitFor(() => expect(c.registry().connected).toEqual({}));
    expect(ended()).toEqual([
      { repoId: card(path).repoId, sessionId: mini.hello.sessionId, reason: 'closed' },
    ]);
  });

  it('refuses a card whose id is not its path, or whose path is not a repo', async () => {
    const c = await start();
    const path = repo('api');
    const wrongId = await dial(c, path, { repoId: '0000000000000000' });
    expect((await wrongId.closed).code).toBe(1008);
    const notRepo = join(root, 'plain');
    mkdirSync(notRepo);
    const plain = await dial(c, notRepo);
    expect((await plain.closed).code).toBe(1008);
    expect(c.registry().connected).toEqual({});
  });

  it('refuses a second Mini-conductor for a repo whose first still answers (4409)', async () => {
    const c = await start();
    const path = repo('api');
    const first = await dial(c, path);
    await vi.waitFor(() => expect(Object.keys(c.registry().connected)).toHaveLength(1));
    const second = await dial(c, path);
    expect(await second.closed).toEqual({ code: 4409, reason: 'repo already connected' });
    expect(Object.values(c.registry().connected)[0]?.sessionId).toBe(first.hello.sessionId);
    await first.close();
  });

  it('lets a new Mini-conductor take over from one that no longer answers', async () => {
    const c = await start({ probeTimeoutMs: 200 });
    const path = repo('api');
    const hung = await silentMini(c, path);
    await vi.waitFor(() => expect(Object.keys(c.registry().connected)).toHaveLength(1));
    const fresh = await dial(c, path);
    await vi.waitFor(() =>
      expect(Object.values(c.registry().connected)[0]?.sessionId).toBe(fresh.hello.sessionId),
    );
    expect(ended()).toEqual([expect.objectContaining({ reason: 'replaced' })]);
    hung.terminate();
    await fresh.close();
  });

  it('drops a Mini-conductor that misses its pongs', async () => {
    const c = await start({ pingIntervalMs: 100, missedPongs: 2 });
    const path = repo('api');
    const hung = await silentMini(c, path);
    await vi.waitFor(() => expect(Object.keys(c.registry().connected)).toHaveLength(1));
    await vi.waitFor(() => expect(c.registry().connected).toEqual({}), { timeout: 3000 });
    expect(ended()).toEqual([expect.objectContaining({ reason: 'silent' })]);
    hung.terminate();
  });

  it('after a crash, records what was left connected as ended, and keeps the registration', async () => {
    const path = repo('api');
    const { repoId } = card(path);
    // What a Conductor killed with SIGKILL leaves: a registration and a connection never ended.
    mkdirSync(conductorStatePaths(stateDir).dir, { recursive: true });
    const s = openEventStore(conductorStatePaths(stateDir).events);
    const env = (type: string, data: unknown) => ({
      v: 1 as const,
      id: newUlid(),
      ts: new Date().toISOString(),
      source: { kind: 'conductor' as const, id: 'conductor' },
      repo: repoId,
      type,
      data,
    });
    s.append([
      env('registry.repo_added', { repoId, repoPath: path }),
      env('registry.connected', { ...card(path), sessionId: 'old-session' }),
    ]);
    s.close();
    const c = await start();
    expect(c.registry().connected).toEqual({});
    expect(c.registry().repos[repoId]).toMatchObject({ repoPath: path });
    expect(ended()).toEqual([{ repoId, sessionId: 'old-session', reason: 'conductor_restart' }]);
  });
});
