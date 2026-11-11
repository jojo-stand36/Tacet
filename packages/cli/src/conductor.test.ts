import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  conductorRuntimePath,
  connectRpc,
  readRuntimeFile,
  repoStatePaths,
} from '@tacet/core/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Io } from './io.js';
import { main } from './main.js';
import { repoRootFrom } from './state.js';

/** `tacet up` and `tacet conductor status` (#23). */
describe('tacet up: the Conductor', () => {
  let root: string;
  let home: string;
  let repo: string;

  const tacet = async (argv: string[], more: Partial<Io> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main([...argv, '--user-dir', join(root, 'user')], {
      out: (t) => out.push(t),
      err: (t) => err.push(t),
      cwd: repo,
      home,
      ...more,
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  const status = async () => JSON.parse((await tacet(['conductor', 'status', '--json'])).out);

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tacet-cli-up-')));
    home = join(root, 'home');
    repo = join(root, 'repo');
    mkdirSync(home);
    mkdirSync(join(root, 'user'));
    mkdirSync(repo);
    execFileSync('git', ['init', '-q', repo]);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('registers a repo, once, and unregisters it', async () => {
    const add = await tacet(['up', '--add', '.']);
    expect(add.code).toBe(0);
    expect(add.out).toContain(`${repo} is now registered`);
    expect((await tacet(['up', '--add', join(repo)])).out).toContain('was already registered');
    expect(await status()).toEqual({
      running: null,
      repos: [
        expect.objectContaining({
          repoId: repoStatePaths(repo).repoId,
          repoPath: repo,
          connected: false,
        }),
      ],
      unregistered: [],
    });
    expect((await tacet(['conductor', 'status'])).out).toContain('Conductor not running');
    expect((await tacet(['up', '--remove', repo])).out).toContain('is now not registered');
    expect((await status()).repos).toEqual([]);
  });

  it('refuses to register what is not a git repository', async () => {
    const plain = join(root, 'plain');
    mkdirSync(plain);
    const r = await tacet(['up', '--add', plain]);
    // The repo is found by walking up to a `.git`, so a stray one above the temp dir (a `/tmp/.git`)
    // makes `plain` part of it: then it is registered as that repo, which the output says.
    const around = repoRootFrom(plain);
    if (around === plain) {
      expect(r.code).toBe(1);
      expect(r.err).toContain('not a git repository');
    } else {
      expect(r.code).toBe(0);
      expect(r.out).toContain(`(the repo containing ${plain})`);
    }
  });

  it('refuses a mistyped path rather than register the repo around it, and both flags at once', async () => {
    const r = await tacet(['up', '--add', join(repo, 'tpyo')]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('no such path');
    expect((await status()).repos).toEqual([]);
    expect((await tacet(['up', '--add', repo, '--remove', repo])).code).toBe(2);
  });

  it('runs until interrupted, and shows who is connected', async () => {
    await tacet(['up', '--add', repo]);
    const stop = new AbortController();
    const running = tacet(['up'], { signal: stop.signal });
    const file = conductorRuntimePath(join(home, '.tacet', 'run'));
    await vi.waitFor(() => expect(existsSync(file)).toBe(true), { timeout: 5000 });
    const info = readRuntimeFile(file);
    const mini = await connectRpc({
      port: info.port,
      token: info.token,
      clientInfo: { name: 'test-mini', version: '0' },
      role: 'mini',
      card: {
        repoId: repoStatePaths(repo).repoId,
        repoPath: repo,
        adapters: [],
        miniVersion: '0',
      },
    });
    await vi.waitFor(async () =>
      expect((await status()).repos[0]).toMatchObject({ connected: true }),
    );
    expect((await status()).running).toBe(process.pid);
    expect((await tacet(['conductor', 'status'])).out).toMatch(/connected since/);
    // A Mini-conductor of a repo the user did not register is shown, and not registered.
    const other = join(root, 'other');
    mkdirSync(other);
    execFileSync('git', ['init', '-q', other]);
    const stranger = await connectRpc({
      port: info.port,
      token: info.token,
      clientInfo: { name: 'test-mini', version: '0' },
      role: 'mini',
      card: {
        repoId: repoStatePaths(other).repoId,
        repoPath: other,
        adapters: [],
        miniVersion: '0',
      },
    });
    await vi.waitFor(async () =>
      expect((await status()).unregistered).toEqual([expect.objectContaining({ repoPath: other })]),
    );
    expect((await tacet(['conductor', 'status'])).out).toContain(
      `${other}: connected, not registered`,
    );
    expect((await status()).repos).toHaveLength(1);
    await stranger.close();
    await mini.close();
    stop.abort();
    const r = await running;
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Conductor running on 127\.0\.0\.1:\d+/);
    expect(existsSync(file)).toBe(false);
    expect((await status()).running).toBeNull();
  });
});
