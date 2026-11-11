import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ConductorLink,
  type ConductorLinkState,
  conductorRuntimePath,
  dialConductor,
  repoStatePaths,
} from '@tacet/core/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Conductor, startConductor } from './conductor.js';

/** A Mini-conductor's link to the Conductor (#23): dial, redial, back off. */
describe('dialConductor', () => {
  let root: string;
  let runDir: string;
  let repo: string;
  const conductors: Conductor[] = [];
  const links: ConductorLink[] = [];

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tacet-dial-')));
    runDir = join(root, 'run');
    repo = join(root, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q', repo]);
  });
  afterEach(async () => {
    await Promise.all(links.splice(0).map((l) => l.close()));
    await Promise.all(conductors.splice(0).map((c) => c.close()));
    rmSync(root, { recursive: true, force: true });
  });

  const conductor = async () => {
    const c = await startConductor({ stateDir: join(root, 'state'), runDir });
    conductors.push(c);
    return c;
  };
  const link = (states: ConductorLinkState[] = []) => {
    const l = dialConductor({
      card: {
        repoId: repoStatePaths(repo).repoId,
        repoPath: repo,
        adapters: [],
        miniVersion: '0',
      },
      clientInfo: { name: 'test-mini', version: '0' },
      runDir,
      minDelayMs: 20,
      maxDelayMs: 100,
      settleMs: 50,
      onState: (s) => states.push(s),
    });
    links.push(l);
    return l;
  };
  const connected = (c: Conductor) => Object.keys(c.registry().connected).length;

  it('finds a Conductor that starts later, and the next one after it stops', async () => {
    const states: ConductorLinkState[] = [];
    const l = link(states);
    // Nothing running: quiet.
    await new Promise((r) => setTimeout(r, 100));
    expect(states).toEqual([]);
    expect(l.current()).toBeUndefined();
    const first = await conductor();
    await vi.waitFor(() => expect(connected(first)).toBe(1));
    await vi.waitFor(() =>
      expect(states).toContainEqual(expect.objectContaining({ state: 'connected' })),
    );
    await first.close();
    conductors.length = 0;
    // A new start: a new port and a new token, read again from the runtime file.
    const second = await conductor();
    await vi.waitFor(() => expect(connected(second)).toBe(1), { timeout: 5000 });
    expect(states).toContainEqual(expect.objectContaining({ state: 'disconnected' }));
  });

  it('backs off when the repo already has a live Mini-conductor (4409)', async () => {
    const c = await conductor();
    link();
    await vi.waitFor(() => expect(connected(c)).toBe(1));
    const states: ConductorLinkState[] = [];
    const second = link(states);
    await vi.waitFor(() => expect(states).toContainEqual({ state: 'refused', code: 4409 }), {
      timeout: 5000,
    });
    expect(second.current()).toBeUndefined();
    expect(connected(c)).toBe(1);
  });

  it("does not dial a crashed Conductor's runtime file", async () => {
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    // A pid that is not running, as a Conductor killed with SIGKILL leaves.
    writeFileSync(
      conductorRuntimePath(runDir),
      JSON.stringify({
        pid: 2 ** 22 - 3,
        port: 1,
        token: 'x'.repeat(43),
        protocolVersions: [1],
        startedAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    const states: ConductorLinkState[] = [];
    link(states);
    await new Promise((r) => setTimeout(r, 150));
    expect(states).toEqual([]);
  });

  const runtimeFile = (port: number, pid: number) => {
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      conductorRuntimePath(runDir),
      JSON.stringify({
        pid,
        port,
        token: 'x'.repeat(43),
        protocolVersions: [1],
        startedAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
  };

  it('stops promptly while a connection hangs, and survives a listener that throws', async () => {
    // A port that takes the TCP connection and never answers the upgrade.
    const sockets: Socket[] = [];
    const hung = createServer((s) => sockets.push(s));
    await new Promise<void>((r) => hung.listen(0, '127.0.0.1', r));
    try {
      const port = (hung.address() as { port: number }).port;
      runtimeFile(port, process.pid);
      let calls = 0;
      const l = dialConductor({
        card: {
          repoId: repoStatePaths(repo).repoId,
          repoPath: repo,
          adapters: [],
          miniVersion: '0',
        },
        clientInfo: { name: 'test-mini', version: '0' },
        runDir,
        minDelayMs: 10,
        maxDelayMs: 30_000,
        connectTimeoutMs: 200,
        onState: () => {
          calls += 1;
          throw new Error('the log cannot be written');
        },
      });
      await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(2), { timeout: 5000 });
      await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(calls));
      const t = Date.now();
      await l.close();
      // At most the connect timeout, never a backoff of up to maxDelayMs.
      expect(Date.now() - t).toBeLessThan(1000);
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => hung.close(() => r()));
    }
  });
});
