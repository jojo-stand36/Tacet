import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MINI_EXIT_UNFINISHED } from '@tacet/conductor';
import { newUlid } from '@tacet/core';
import {
  conductorRuntimePath,
  miniRuntimePath,
  openEventStore,
  repoStatePaths,
} from '@tacet/core/node';
import { ScriptedAdapter } from '@tacet/mini/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DetachedChild } from './commands/detach.js';
import { MINI_EXIT } from './commands/mini.js';
import { miniLogFor } from './commands/up.js';
import type { Io } from './io.js';
import { main } from './main.js';

/** `tacet mini` and auto-start from `tacet up` (#23). */
describe('tacet mini and conductor.autostart', () => {
  let root: string;
  let home: string;
  let repo: string;
  let state: string;
  const env = () => ({
    PATH: process.env.PATH ?? '',
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Tacet Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Tacet Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  });
  const userDir = () => join(root, 'user');

  const tacet = async (argv: string[], more: Partial<Io> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main([...argv, '--user-dir', userDir()], {
      out: (t) => out.push(t),
      err: (t) => err.push(t),
      cwd: repo,
      env: env(),
      home,
      pollMs: 20,
      standalone: {
        adapters: {
          'claude-sdk': {
            adapter: new ScriptedAdapter('claude-sdk', () => ({ do: 'reply', text: 'done' })),
            authRoute: 'api_key',
          },
        },
        conductor: { minDelayMs: 20, settleMs: 50 },
      },
      ...more,
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tacet-cli-mini-')));
    home = join(root, 'home');
    repo = join(root, 'repo');
    state = join(root, 'state');
    mkdirSync(home);
    mkdirSync(userDir());
    mkdirSync(join(repo, '.tacet'), { recursive: true });
    const git = (args: string[]) => execFileSync('git', ['-C', repo, ...args], { env: env() });
    git(['init', '-q', '-b', 'main']);
    writeFileSync(
      join(repo, '.tacet', 'tacet.yaml'),
      'tiers:\n  worker: { adapter: claude-sdk, model: cheap }\n',
    );
    // The state dir is the user's: the Conductor's and the repo's logs live under it.
    writeFileSync(
      join(userDir(), 'config.yaml'),
      `events: { state_dir: ${JSON.stringify(state)} }\n`,
    );
    git(['add', '.']);
    git(['commit', '-qm', 'init']);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('keeps its exit code for unfinished tasks in step with the Conductor', () => {
    expect(MINI_EXIT.unfinished).toBe(MINI_EXIT_UNFINISHED);
  });

  it('refuses to start while the repo has unfinished tasks, which only the user resumes', async () => {
    const paths = repoStatePaths(repo, state);
    mkdirSync(paths.dir, { recursive: true });
    const store = openEventStore(paths.events);
    store.append({
      v: 1,
      id: newUlid(),
      ts: new Date().toISOString(),
      source: { kind: 'mini', id: 'standalone' },
      taskId: 'left-over',
      type: 'task.created',
      data: {
        id: 'left-over',
        goal: 'g',
        acceptanceCriteria: ['ok'],
        priority: 'p2',
        createdAt: new Date().toISOString(),
      },
    });
    store.close();
    const r = await tacet(['mini']);
    expect(r.code).toBe(MINI_EXIT.unfinished);
    expect(r.err).toMatch(/unfinished tasks left-over: resume them with tacet run --resume/);
    // Nothing was started: no lock taken, no port opened.
    expect(existsSync(miniRuntimePath(repo, join(home, '.tacet', 'run')))).toBe(false);
  });

  it('runs with no task, dials the Conductor, and stops when interrupted', async () => {
    await tacet(['up', '--add', repo]);
    const stopUp = new AbortController();
    const up = tacet(['up'], { signal: stopUp.signal });
    await vi.waitFor(
      () => expect(existsSync(conductorRuntimePath(join(home, '.tacet', 'run')))).toBe(true),
      { timeout: 5000 },
    );
    const stopMini = new AbortController();
    const mini = tacet(['mini'], { signal: stopMini.signal });
    const status = async () => JSON.parse((await tacet(['conductor', 'status', '--json'])).out);
    await vi.waitFor(
      async () => expect((await status()).repos[0]).toMatchObject({ connected: true }),
      { timeout: 10_000 },
    );
    // It serves its control port, as a run does.
    expect(existsSync(miniRuntimePath(repo, join(home, '.tacet', 'run')))).toBe(true);
    // Past the link's settle time, so it has said so.
    await new Promise((r) => setTimeout(r, 200));
    stopMini.abort();
    const m = await mini;
    expect(m.code).toBe(MINI_EXIT.stopped);
    expect(m.err).toContain('Mini-conductor running for');
    expect(m.err).toContain('connected to the Conductor');
    await vi.waitFor(async () =>
      expect((await status()).repos[0]).toMatchObject({ connected: false }),
    );
    stopUp.abort();
    expect((await up).code).toBe(0);
  });

  it('starts nothing unless the user turned auto-start on', async () => {
    await tacet(['up', '--add', repo]);
    const spawned: string[][] = [];
    const spawnDetached = (argv: string[]): DetachedChild => {
      spawned.push(argv);
      return { pid: 99999999, exited: new Promise(() => {}), stop: () => {} };
    };
    const stop = new AbortController();
    const up = tacet(['up'], { signal: stop.signal, spawnDetached });
    await vi.waitFor(() =>
      expect(existsSync(conductorRuntimePath(join(home, '.tacet', 'run')))).toBe(true),
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(spawned).toEqual([]);
    stop.abort();
    await up;

    writeFileSync(
      join(userDir(), 'config.yaml'),
      `events: { state_dir: ${JSON.stringify(state)} }\nconductor: { autostart: true }\n`,
    );
    const again = new AbortController();
    const up2 = tacet(['up'], { signal: again.signal, spawnDetached });
    await vi.waitFor(() =>
      expect(spawned).toEqual([['mini', '--repo', repo, '--user-dir', userDir()]]),
    );
    const log = miniLogFor(repo, join(home, '.tacet', 'run'));
    expect(statSync(log).mode & 0o777).toBe(0o600);
    expect(readFileSync(log, 'utf8')).toBe('');
    again.abort();
    await up2;
  });
});
