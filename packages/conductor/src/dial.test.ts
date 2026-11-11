import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
    expect(second.port).not.toBe(first.port);
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
});
