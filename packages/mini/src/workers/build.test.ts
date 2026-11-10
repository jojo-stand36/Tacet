import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TacetConfig } from '@tacet/core';
import { type EventStore, loadConfig, openEventStore } from '@tacet/core/node';
import { EventTap } from '@tacet/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MiniConductor } from '../daemon/daemon.js';
import { SingleStepPlanner } from '../daemon/planner.js';
import type { WorkerMcp } from '../daemon/ports.js';
import { TempWorkspaces } from '../daemon/testing.js';
import { buildWorkerAdapters, WorkerConfigError } from './build.js';

/** The ACP adapter's fake agent: logs its environment's names, replies with the prompt's text. */
const FAKE_AGENT = join(
  import.meta.dirname,
  '../../../adapters/acp/src/testing/fake-acp-agent.mjs',
);
const SECRET = 'agent-secret-value-1234';
/** The PTY adapter's fake line-based CLI: `PRINT_SECRET` prints the value of FAKE_SECRET. */
const FAKE_CLI = join(import.meta.dirname, '../../../adapters/pty/src/testing/fake-cli.mjs');

const mcp: WorkerMcp = {
  workerConfig: () => ({
    config: { name: 'tacet', url: 'http://127.0.0.1:1/mcp' },
    revoke: () => {},
  }),
};

describe('buildWorkerAdapters', () => {
  const config = (over: Partial<TacetConfig>): TacetConfig => ({
    tiers: { worker: { adapter: 'claude-sdk', model: 'm' } },
    ...over,
  });

  it('builds one adapter per Worker tier id, on the api_key route', () => {
    const built = buildWorkerAdapters(
      config({
        tiers: {
          mini: { adapter: 'acp:not-a-worker-tier' },
          worker: { adapter: 'claude-sdk', model: 'm' },
          review: { adapter: 'codex-app-server', model: 'm', effort: 'high' },
        },
      }),
      { baseEnv: {} },
    );
    expect(Object.keys(built).sort()).toEqual(['claude-sdk', 'codex-app-server']);
    expect(built['claude-sdk']?.authRoute).toBe('api_key');
    expect(built['claude-sdk']?.adapter.id).toBe('claude-sdk');
    expect(built['codex-app-server']?.adapter.id).toBe('codex-app-server');
    const acp = buildWorkerAdapters(config({ tiers: { worker: { adapter: 'acp:gemini' } } }), {
      baseEnv: {},
    });
    expect(acp['acp:gemini']?.adapter.id).toBe('gemini');
    const pty = buildWorkerAdapters(
      config({
        tiers: { worker: { adapter: 'pty:claude', model: 'm' }, review: { adapter: 'pty:aider' } },
        agents: { aider: { kind: 'pty', command: ['aider'], ready_prompt: '> ' } },
      }),
      { baseEnv: {} },
    );
    expect(pty['pty:claude']?.adapter.id).toBe('pty:claude');
    expect(pty['pty:aider']?.adapter.id).toBe('pty:aider');
  });

  it('names the tier or config path for everything it cannot build', () => {
    const cases: [Partial<TacetConfig>, RegExp][] = [
      [{ tiers: {} }, /no tiers\.worker/],
      [
        { tiers: { worker: { adapter: 'codex-app-server' } } },
        /tiers\.worker\.model: codex-app-server needs a model/,
      ],
      [
        { tiers: { worker: { adapter: 'opencode' } } },
        /tiers\.worker\.adapter: no Worker adapter "opencode" yet/,
      ],
      [
        { tiers: { worker: { adapter: 'acp' } } },
        /tiers\.worker\.adapter: no Worker adapter "acp" yet/,
      ],
      [
        { tiers: { worker: { adapter: 'acp:nope' } } },
        /tiers\.worker\.adapter: no ACP agent "nope"/,
      ],
      [
        {
          tiers: { worker: { adapter: 'acp:aider' } },
          agents: { aider: { kind: 'pty', command: ['aider'] } },
        },
        /agents\.aider is of kind pty; use pty:aider/,
      ],
      [
        {
          tiers: { worker: { adapter: 'acp:gemini' } },
          agents: { gemini: { kind: 'acp', command: ['my-gemini'] } },
        },
        /agents\.gemini: "gemini" is a built-in ACP agent/,
      ],
      [
        { tiers: { worker: { adapter: 'acp:gemini', effort: 'high' } } },
        /tiers\.worker\.effort: acp:gemini does not set a reasoning effort/,
      ],
      [
        {
          tiers: { worker: { adapter: 'acp:goose' } },
          agents: { goose: { kind: 'acp', command: ['goose'], env: { K: { env: 'GOOSE_KEY' } } } },
        },
        /agents\.goose\.env\.K: environment variable GOOSE_KEY is not set/,
      ],
      [
        {
          tiers: { worker: { adapter: 'acp:goose' } },
          agents: { goose: { kind: 'acp', command: ['goose'], env: { K: { keychain: 'a/b' } } } },
        },
        /agents\.goose\.env\.K: keychain references are not supported yet/,
      ],
      [
        { tiers: { worker: { adapter: 'pty:nope' } } },
        /tiers\.worker\.adapter: no PTY preset "nope"/,
      ],
      [
        {
          tiers: { worker: { adapter: 'pty:goose' } },
          agents: { goose: { kind: 'acp', command: ['goose'] } },
        },
        /agents\.goose is of kind acp; use acp:goose/,
      ],
      [
        {
          tiers: { worker: { adapter: 'pty:claude' } },
          agents: { claude: { kind: 'pty', command: ['my-claude'] } },
        },
        /agents\.claude: "claude" is a built-in PTY preset/,
      ],
      [
        {
          tiers: { worker: { adapter: 'pty:aider', model: 'gpt' } },
          agents: { aider: { kind: 'pty', command: ['aider'] } },
        },
        /tiers\.worker\.model: pty:aider cannot choose a model/,
      ],
      [
        { workers: { per_adapter: { 'pty:typo': 1 } } },
        /workers\.per_adapter\.pty:typo: no PTY preset "typo"/,
      ],
      [
        { workers: { per_adapter: { 'acp:typo': 1 } } },
        /workers\.per_adapter\.acp:typo: no ACP agent "typo"/,
      ],
    ];
    for (const [over, error] of cases) {
      expect(() => buildWorkerAdapters(config(over), { baseEnv: {} })).toThrow(WorkerConfigError);
      expect(() => buildWorkerAdapters(config(over), { baseEnv: {} })).toThrow(error);
    }
  });

  it('resolves only the secret references of agents a Worker tier uses', () => {
    const built = buildWorkerAdapters(
      config({
        agents: { unused: { kind: 'acp', command: ['x'], env: { K: { keychain: 'a/b' } } } },
        workers: { per_adapter: { 'acp:unused': 1, 'acp:gemini': 2 } },
      }),
      { baseEnv: {} },
    );
    expect(Object.keys(built)).toEqual(['claude-sdk']);
  });
});

describe('a Mini-conductor started from a config file (#149)', () => {
  let dir: string;
  let store: EventStore;
  let ws: TempWorkspaces;
  let d: MiniConductor | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tacet-mini-workers-'));
    store = openEventStore(':memory:');
    ws = new TempWorkspaces();
  });
  afterEach(async () => {
    await d?.stop().catch(() => {});
    d = undefined;
    store.close();
    ws.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it('gives a Worker exactly the allowlisted environment plus workers.env.pass, and keeps its secrets out of events', async () => {
    const userDir = join(dir, 'user');
    const repo = join(dir, 'repo');
    mkdirSync(userDir, { recursive: true });
    mkdirSync(join(repo, '.tacet'), { recursive: true });
    writeFileSync(
      join(userDir, 'config.yaml'),
      'workers:\n  env:\n    pass: [FAKE_*, MY_TOOL_HOME]\n',
    );
    writeFileSync(
      join(repo, '.tacet', 'tacet.yaml'),
      [
        'tiers:',
        '  worker: { adapter: "acp:fake" }',
        'agents:',
        '  fake:',
        '    kind: acp',
        '    command: [fake-acp-agent]',
        '    env: { FAKE_AGENT_TOKEN: { env: MY_AGENT_TOKEN } }',
        'verify: []',
        '',
      ].join('\n'),
    );
    const config = loadConfig({ userDir, repoRoot: repo }).config;
    const log = join(dir, 'agent.log');
    const dropped: [string, string[]][] = [];
    const adapters = buildWorkerAdapters(config, {
      baseEnv: {
        PATH: process.env.PATH,
        HOME: dir,
        FAKE_LOG: log,
        MY_TOOL_HOME: '/opt/tool',
        MY_AGENT_TOKEN: SECRET,
        OPENAI_API_KEY: 'sk-not-for-this-agent',
        UNRELATED: 'x',
      },
      acp: { executable: [process.execPath, FAKE_AGENT], killTimeoutMs: 1000 },
      onEnvDropped: (id, names) => dropped.push([id, names]),
    });
    d = new MiniConductor({
      store,
      config,
      adapters,
      workspaces: ws,
      planner: new SingleStepPlanner(),
      mcp,
      lockPath: join(dir, 'mini.lock'),
      pollMs: 20,
    });
    await d.start();
    d.submit({ goal: `say ${SECRET}`, acceptanceCriteria: ['ok'] });
    await d.settled();

    expect(existsSync(log)).toBe(true);
    const first = JSON.parse(readFileSync(log, 'utf8').split('\n')[0] as string) as {
      envNames: string[];
    };
    // macOS adds its own variables to every process; they are not the Worker's environment.
    const names = first.envNames.filter((n) => !n.startsWith('__CF'));
    expect(names).toEqual([
      'FAKE_AGENT_TOKEN',
      'FAKE_LOG',
      'HOME',
      'MY_TOOL_HOME',
      'PATH',
      'TACET_WORKER_MARKER',
    ]);
    expect(dropped).toContainEqual([
      'acp:fake',
      expect.arrayContaining(['MY_AGENT_TOKEN', 'OPENAI_API_KEY', 'UNRELATED']),
    ]);
    // Only the Worker's own events: the task's goal (in task.* events) holds the value on purpose,
    // so the fake agent, which replies with its prompt, has the secret to print.
    const agentEvents = store
      .query({})
      .map((e) => e.envelope)
      .filter((e) => e.type.startsWith('agent.'));
    expect(agentEvents.length).toBeGreaterThan(0);
    expect(JSON.stringify(agentEvents)).not.toContain(SECRET);
    expect(JSON.stringify(agentEvents)).toContain('[redacted]');
  });
});

describe('a PTY preset built from config (#149)', () => {
  it('passes its resolved secret to the CLI and never into events', {
    timeout: 60_000,
  }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tacet-mini-pty-'));
    try {
      const adapters = buildWorkerAdapters(
        {
          tiers: { worker: { adapter: 'pty:fake' } },
          agents: {
            fake: {
              kind: 'pty',
              command: [process.execPath, FAKE_CLI],
              env: { FAKE_SECRET: { env: 'MY_CLI_SECRET' } },
              ready_prompt: 'fake>',
            },
          },
        },
        {
          baseEnv: { PATH: process.env.PATH, HOME: dir, MY_CLI_SECRET: SECRET },
          ptyCli: { quietMs: 300, killTimeoutMs: 1000 },
        },
      );
      const adapter = adapters['pty:fake']?.adapter;
      if (!adapter) throw new Error('not built');
      const h = await adapter.start({ cwd: dir });
      const tap = new EventTap(adapter.events(h));
      await adapter.send(h, { text: 'PRINT_SECRET' });
      await tap.waitFor((e) => e.t === 'message.delta', 30_000);
      await adapter.close(h);
      expect(tap.events).toContainEqual({ t: 'message.delta', text: 'value: [redacted]' });
      expect(JSON.stringify(tap.events)).not.toContain(SECRET);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
