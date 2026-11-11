import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { newUlid, type RegistryState, registryProjection } from '@tacet/core';
import {
  type ConductorLink,
  type ConductorLinkState,
  conductorRuntimePath,
  conductorStatePaths,
  dialConductor,
  openEventStore,
  readRuntimeFile,
  repoStatePaths,
} from '@tacet/core/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Conductor, startConductor } from './conductor.js';

const testing = join(import.meta.dirname, 'testing');

/** `node` running one of the test-only children from its TypeScript source, with no build. */
function child(script: string, args: string[]): ChildProcess & { lines: string[] } {
  const p = spawn(
    process.execPath,
    [
      // Node's type stripping (on by default and stable from 24.12; Node docs, typescript.html),
      // not `--experimental-transform-types`, which Node 26 removed: the children's imports must
      // keep to erasable syntax (no enums, parameter properties or runtime namespaces).
      '--conditions=@tacet/source',
      '--import',
      pathToFileURL(join(testing, 'ts-hooks.mjs')).href,
      join(testing, script),
      ...args,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  ) as ChildProcess & { lines: string[] };
  p.lines = [];
  let buf = '';
  p.stdout?.on('data', (d: Buffer) => {
    buf += d.toString();
    const parts = buf.split('\n');
    buf = parts.pop() ?? '';
    p.lines.push(...parts);
  });
  let err = '';
  p.stderr?.on('data', (d: Buffer) => {
    err += d.toString();
  });
  p.once('exit', (code) => {
    if (code !== 0 && code !== null) p.lines.push(`exit ${code}: ${err}`);
  });
  return p;
}

const exited = (p: ChildProcess) =>
  new Promise<void>((resolve) => {
    if (p.exitCode !== null || p.signalCode !== null) resolve();
    else p.once('exit', () => resolve());
  });

/**
 * #23's acceptance: killing either side recovers cleanly. Real processes, killed with SIGKILL,
 * so nothing gets to clean up after itself.
 */
describe('kill and restart (#23)', () => {
  let root: string;
  let stateDir: string;
  let runDir: string;
  let repo: string;
  const procs: ChildProcess[] = [];
  const links: ConductorLink[] = [];
  const conductors: Conductor[] = [];

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tacet-recovery-')));
    stateDir = join(root, 'state');
    runDir = join(root, 'run');
    repo = join(root, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q', repo]);
    // Registered by the user before anything runs.
    const { repoId } = repoStatePaths(repo);
    mkdirSync(conductorStatePaths(stateDir).dir, { recursive: true });
    const s = openEventStore(conductorStatePaths(stateDir).events);
    s.append({
      v: 1,
      id: newUlid(),
      ts: new Date().toISOString(),
      source: { kind: 'conductor', id: 'cli' },
      repo: repoId,
      type: 'registry.repo_added',
      data: { repoId, repoPath: repo },
    });
    s.close();
  });
  afterEach(async () => {
    await Promise.all(links.splice(0).map((l) => l.close()));
    await Promise.all(conductors.splice(0).map((c) => c.close()));
    for (const p of procs.splice(0)) {
      p.kill('SIGKILL');
      await exited(p);
    }
    rmSync(root, { recursive: true, force: true });
  });

  /** The registry as the Conductor's log has it, read as `tacet conductor status` does. */
  const registry = (): RegistryState => {
    const s = openEventStore(conductorStatePaths(stateDir).events, { readonly: true });
    try {
      return s.replay(registryProjection);
    } finally {
      s.close();
    }
  };
  const disconnects = () => {
    const s = openEventStore(conductorStatePaths(stateDir).events, { readonly: true });
    try {
      return s.query({ typePrefix: 'registry.disconnected' }).map((e) => e.envelope.data);
    } finally {
      s.close();
    }
  };
  const conductorProcess = async () => {
    const p = child('conductor-child.ts', [stateDir, runDir]);
    procs.push(p);
    await vi.waitFor(
      () =>
        expect(p.lines.find((l) => l.startsWith('ready') || l.startsWith('exit'))).toMatch(
          /^ready/,
        ),
      { timeout: 15_000 },
    );
    return p;
  };

  it('a Conductor killed with SIGKILL: the Mini-conductor waits, then finds the next one', async () => {
    const first = await conductorProcess();
    const oldPort = readRuntimeFile(conductorRuntimePath(runDir)).port;
    const states: ConductorLinkState[] = [];
    links.push(
      dialConductor({
        card: {
          repoId: repoStatePaths(repo).repoId,
          repoPath: repo,
          adapters: [],
          miniVersion: '0',
        },
        clientInfo: { name: 'test-mini', version: '0' },
        runDir,
        minDelayMs: 20,
        maxDelayMs: 200,
        settleMs: 50,
        onState: (s) => states.push(s),
      }),
    );
    await vi.waitFor(() => expect(Object.keys(registry().connected)).toHaveLength(1), {
      timeout: 5000,
    });
    await vi.waitFor(() =>
      expect(states).toContainEqual(expect.objectContaining({ state: 'connected' })),
    );
    const [before] = Object.values(registry().connected);

    first.kill('SIGKILL');
    await exited(first);
    await vi.waitFor(() =>
      expect(states).toContainEqual(expect.objectContaining({ state: 'disconnected' })),
    );
    // Its runtime file is left behind, naming a dead pid: never dialed, so no failures pile up.
    expect(readRuntimeFile(conductorRuntimePath(runDir)).port).toBe(oldPort);
    const failuresBefore = states.filter((s) => s.state === 'failed').length;
    await new Promise((r) => setTimeout(r, 300));
    expect(states.filter((s) => s.state === 'failed').length).toBe(failuresBefore);

    // The next Conductor takes over the dead one's locks and runtime file.
    await conductorProcess();
    // Its own runtime file now: the next process's, whatever port the OS gave it.
    expect(readRuntimeFile(conductorRuntimePath(runDir)).pid).not.toBe(first.pid);
    await vi.waitFor(
      () => {
        const now = Object.values(registry().connected);
        expect(now).toHaveLength(1);
        expect(now[0]?.sessionId).not.toBe(before?.sessionId);
      },
      { timeout: 5000 },
    );
    expect(Object.values(registry().repos).map((r) => r.repoPath)).toEqual([repo]);
    expect(disconnects()).toContainEqual({
      repoId: repoStatePaths(repo).repoId,
      sessionId: before?.sessionId,
      reason: 'conductor_restart',
    });
  }, 60_000);

  it('a Mini-conductor killed with SIGKILL: the Conductor sees it go and starts another', async () => {
    const minis: ChildProcess[] = [];
    const c = await startConductor({
      stateDir,
      runDir,
      autostart: {
        spawnMini: (path) => {
          const p = child('mini-child.ts', [runDir, path]);
          procs.push(p);
          minis.push(p);
          return { pid: p.pid ?? -1, exited: exited(p).then(() => p.exitCode ?? 'signal') };
        },
        isMiniLive: () => false,
        intervalMs: 50,
        backoffMs: 50,
      },
    });
    conductors.push(c);
    await vi.waitFor(() => expect(Object.keys(c.registry().connected)).toHaveLength(1), {
      timeout: 15_000,
    });
    const [first] = Object.values(c.registry().connected);
    expect(minis).toHaveLength(1);

    minis[0]?.kill('SIGKILL');
    await vi.waitFor(
      () => {
        const now = Object.values(c.registry().connected);
        expect(now).toHaveLength(1);
        expect(now[0]?.sessionId).not.toBe(first?.sessionId);
      },
      { timeout: 15_000 },
    );
    expect(minis).toHaveLength(2);
    expect(disconnects()).toContainEqual(
      expect.objectContaining({ sessionId: first?.sessionId, reason: 'closed' }),
    );
  }, 60_000);
});
