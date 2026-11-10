import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_ACP_AGENT, claudeAcpWorkerSpec } from '@tacet/adapter-acp';
import { startMockResponsesApi } from '@tacet/adapter-codex-app-server/testing';
import { PtyCliAdapter } from '@tacet/adapter-pty';
import { gatedTitle, ptyGate } from '@tacet/adapter-pty/testing';
import type { TacetConfig } from '@tacet/core';
import {
  defaultStateDir,
  type EventStore,
  loadConfig,
  openEventStore,
  repoStateDir,
} from '@tacet/core/node';
import { EventTap } from '@tacet/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MiniConductor } from '../daemon/daemon.js';
import { SingleStepPlanner } from '../daemon/planner.js';
import type { WorkerMcp } from '../daemon/ports.js';
import { TempWorkspaces } from '../daemon/testing.js';
import { buildWorkerAdapters, commandWords, runs, runsGemini, WorkerConfigError } from './build.js';

// node-pty must load in CI; locally a machine that could not build it skips these (#189).
const gate = await ptyGate();

/** The ACP adapter's fake agent: logs its environment's names, replies with the prompt's text. */
const FAKE_AGENT = join(
  import.meta.dirname,
  '../../../adapters/acp/src/testing/fake-acp-agent.mjs',
);
const SECRET = 'agent-secret-value-1234';
/** The PTY adapter's fake line-based CLI: `PRINT_VAR <NAME>` prints a variable's value. */
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
    // Resumable only with resume arguments, one or several (#157).
    expect(pty['pty:aider']?.adapter.capabilities().resume).toBe(false);
    for (const resume_flag of ['--restore-chat-history', ['resume', '--last']]) {
      const resumable = buildWorkerAdapters(
        config({
          tiers: { worker: { adapter: 'pty:codex' } },
          agents: { codex: { kind: 'pty', command: ['codex'], resume_flag } },
        }),
        { baseEnv: {} },
      );
      expect(resumable['pty:codex']?.adapter.capabilities().resume).toBe(true);
    }
  });

  it('also builds the planner tier when asked, with the same checks (#21)', () => {
    const tiers = {
      mini: { adapter: 'codex-app-server', model: 'm' },
      worker: { adapter: 'claude-sdk', model: 'm' },
    };
    const built = buildWorkerAdapters(config({ tiers }), { baseEnv: {}, withPlanner: true });
    expect(Object.keys(built).sort()).toEqual(['claude-sdk', 'codex-app-server']);
    expect(() =>
      buildWorkerAdapters(config({ tiers: { ...tiers, mini: { adapter: 'codex-app-server' } } }), {
        baseEnv: {},
        withPlanner: true,
      }),
    ).toThrow(/tiers\.mini\.model/);
  });

  it('builds Claude SDK Workers with file tools only and no shell (#206)', async () => {
    let seen: Record<string, unknown> | undefined;
    const query = ((args: { options?: Record<string, unknown> }) => {
      seen = args.options;
      return {
        async *[Symbol.asyncIterator]() {},
        close() {},
      };
    }) as never;
    const built = buildWorkerAdapters(config({}), {
      baseEnv: { ANTHROPIC_API_KEY: 'placeholder-not-a-key' },
      claude: { query },
    });
    const dir = mkdtempSync(join(tmpdir(), 'tacet-build-206-'));
    try {
      const adapter = built['claude-sdk']?.adapter;
      const h = await adapter?.start({ cwd: dir, model: 'm' });
      expect(seen?.tools).toEqual(['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep']);
      expect(seen?.disallowedTools).toEqual(['Bash', 'PowerShell', 'Monitor']);
      if (h) await adapter?.close(h);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recognises a PTY preset running Gemini CLI, whose prompts get every @ escaped (#245)', () => {
    for (const w of [
      'gemini',
      '/usr/local/bin/gemini',
      '@google/gemini-cli',
      '@google/gemini-cli@0.67.0',
      '/x/node_modules/@google/gemini-cli/bundle/gemini.js',
    ]) {
      expect(runsGemini(w), w).toBe(true);
    }
    for (const w of ['gemini-helper', 'my-gemini', 'codex', 'aider', '@google/genai']) {
      expect(runsGemini(w), w).toBe(false);
    }
    // The Worker build sets it for a preset that runs Gemini, and only then.
    const escapes = (command: string[]) => {
      const { adapter } =
        buildWorkerAdapters(
          {
            tiers: { worker: { adapter: 'pty:mine' } },
            agents: { mine: { kind: 'pty', command } },
          },
          { baseEnv: {} },
        )['pty:mine'] ?? {};
      if (!(adapter instanceof PtyCliAdapter)) throw new Error('not a PTY CLI adapter');
      return adapter.preset.escapeAt === true;
    };
    expect(escapes(['gemini'])).toBe(true);
    expect(escapes(['npx', '-y', '@google/gemini-cli@0.67.0'])).toBe(true);
    expect(escapes(['env', 'X=1', 'gemini', '-m', 'm'])).toBe(true);
    expect(escapes(['sh', '-c', 'cd x && exec gemini'])).toBe(true);
    expect(escapes(['aider'])).toBe(false);
    expect(escapes(['aider', '--model', 'gemini'])).toBe(false);
  });

  it('catches a CLI behind launchers it does not model, failing closed (#245 review)', () => {
    const claude = (w: string) => w.split('/').pop() === 'claude';
    for (const command of [
      ['bash', '-lc', 'claude'],
      ['sh', '-ec', 'exec claude'],
      ['sh', '-c', 'FOO=1 claude'],
      ['bash', '-c', 'if true; then claude; fi'],
      ['sh', '-c', 'echo `claude`'],
      ['env', '-u', 'FOO', 'claude'],
      ['env', '-C', '/w', 'claude'],
      ['timeout', '3600', 'claude'],
      ['nice', '-n', '5', 'claude'],
      ['direnv', 'exec', '.', 'claude'],
      ['mise', 'exec', '--', 'claude'],
      ['pnpm', 'claude'],
      ['caffeinate', '-i', 'claude'],
      ['sudo', '-E', 'claude'],
      ['xvfb-run', '-a', 'claude'],
      ['stdbuf', '-oL', 'claude'],
      ['firejail', '--quiet', 'claude'],
      ['systemd-run', '--user', '--pty', 'claude'],
      ['script', '-qc', 'claude', '/dev/null'],
      ['sh', '-c', 'stdbuf -oL claude'],
      // A false positive, refused loudly: the safe direction.
      ['sh', '-c', 'cd ~/claude && aider'],
    ]) {
      expect(runs(command, claude), command.join(' ')).toBe(true);
    }
    for (const command of [
      ['aider', '--model', 'claude'],
      ['opencode', '--config', '/home/me/.config/claude'],
      ['aider', '--model=claude'],
      ['aider', '-m', 'claude'],
      ['aider'],
    ]) {
      expect(runs(command, claude), command.join(' ')).toBe(false);
    }
  });

  it('reads only the words of a command that name what it runs (#245 review)', () => {
    expect(commandWords(['aider', '--model', 'claude'])).toEqual(['aider']);
    expect(commandWords(['opencode', '--config', '/home/me/.config/claude'])).toEqual(['opencode']);
    expect(commandWords(['sh', '-c', 'cd ~/claude && aider'])).toEqual(['sh', 'cd', 'aider']);
    expect(commandWords(['env', '-i', 'A=1', 'npx', '-y', 'pkg', '--flag'])).toEqual([
      'env',
      'npx',
      'pkg',
    ]);
    expect(commandWords(['pnpm', 'dlx', '@google/gemini-cli'])).toEqual([
      'pnpm',
      '@google/gemini-cli',
    ]);
    expect(commandWords(['pnpm', 'run', 'gemini'])).toEqual(['pnpm']);
  });

  it('refuses a custom PTY preset running Claude Code for Workers: pty:claude is hardened (#245)', () => {
    for (const command of [
      ['claude'],
      ['/usr/local/bin/claude', '--model', 'x'],
      ['npx', '-y', '@anthropic-ai/claude-code@2.1.319'],
      ['sh', '-c', 'exec claude'],
      ['sh', '-c', 'claude;'],
      ['/x/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude'],
      ['node', '/x/node_modules/@anthropic-ai/claude-code/cli.js'],
    ]) {
      const config = {
        tiers: { worker: { adapter: 'pty:mine' } },
        agents: { mine: { kind: 'pty' as const, command } },
      };
      expect(() => buildWorkerAdapters(config, { baseEnv: {} }), command.join(' ')).toThrow(
        /agents\.mine runs Claude Code; use pty:claude/,
      );
    }
    // Other CLIs, names that only contain the word, and the word as an argument, still build.
    for (const command of [
      ['aider'],
      ['codex'],
      ['claude-helper'],
      ['my-claude'],
      ['gemini'],
      ['aider', '--model', 'claude'],
      ['opencode', '--config', '/home/me/.config/claude'],
    ]) {
      const built = buildWorkerAdapters(
        { tiers: { worker: { adapter: 'pty:mine' } }, agents: { mine: { kind: 'pty', command } } },
        { baseEnv: {} },
      );
      expect(Object.keys(built)).toEqual(['pty:mine']);
    }
  });

  it('refuses a custom preset running claude-agent-acp for Workers: the built-in is hardened (#214)', () => {
    for (const command of [
      ['claude-agent-acp'],
      ['/opt/bin/claude-agent-acp', '--x'],
      ['npx', '-y', '@agentclientprotocol/claude-agent-acp@0.101.0'],
      ['sh', '-c', 'exec claude-agent-acp'],
      ['node', '/x/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js'],
      ['npx', '@zed-industries/claude-code-acp'],
      ['claude-code-acp'],
      ['sh', '-c', 'claude-agent-acp;'],
      ['sh', '-c', '"claude-agent-acp"'],
    ]) {
      expect(() =>
        buildWorkerAdapters(
          {
            tiers: { worker: { adapter: 'acp:mine' } },
            agents: { mine: { kind: 'acp', command } },
          },
          { baseEnv: {} },
        ),
      ).toThrow(/agents\.mine runs claude-agent-acp; use acp:claude-acp/);
    }
    // The built-in builds, with the Worker options: file tools, no shell, reads asked about.
    const ok = buildWorkerAdapters(
      { tiers: { worker: { adapter: 'acp:claude-acp' } } },
      { baseEnv: {} },
    );
    expect(Object.keys(ok)).toEqual(['acp:claude-acp']);
    const options = (
      claudeAcpWorkerSpec(CLAUDE_ACP_AGENT).sessionMeta as {
        claudeCode: { options: Record<string, unknown> };
      }
    ).claudeCode.options;
    expect(options).toMatchObject({
      settingSources: [],
      settings: { permissions: { ask: ['Read', 'Glob', 'Grep'] } },
      verbatimPrompts: true,
      disallowedTools: ['Bash', 'PowerShell', 'Monitor'],
    });
    // A command that only mentions the name in passing is not refused.
    expect(() =>
      buildWorkerAdapters(
        {
          tiers: { worker: { adapter: 'acp:other' } },
          agents: { other: { kind: 'acp', command: ['my-agent', '--note=claude-agent-acp-like'] } },
        },
        { baseEnv: {} },
      ),
    ).not.toThrow(/claude-agent-acp/);
  });

  it('refuses acp:codex-acp for Workers until #183 is decided (interim default)', () => {
    for (const tiers of [
      { worker: { adapter: 'acp:codex-acp' } },
      { worker: { adapter: 'claude-sdk', model: 'm' }, review: { adapter: 'acp:codex-acp' } },
    ]) {
      expect(() => buildWorkerAdapters({ tiers }, { baseEnv: {} })).toThrow(
        expect.objectContaining({
          name: 'WorkerConfigError',
          message: expect.stringMatching(
            /tiers\.(worker|review)\.adapter: acp:codex-acp is refused for Workers: .*#183/,
          ),
        }),
      );
    }
    // Nor as a cap, nor as a custom agent whose command runs it (by name, path or npm package).
    const refusedFor = (cfg: TacetConfig) =>
      expect(() => buildWorkerAdapters(cfg, { baseEnv: {} })).toThrow(
        /is refused for Workers: .*#183/,
      );
    refusedFor({
      tiers: { worker: { adapter: 'claude-sdk', model: 'm' } },
      workers: { per_adapter: { 'acp:codex-acp': 1 } },
    });
    for (const command of [
      ['codex-acp'],
      ['/usr/local/bin/codex-acp', '--flag'],
      ['npx', '-y', '@agentclientprotocol/codex-acp@2.6.0'],
      ['sh', '-c', 'exec codex-acp --x'],
    ]) {
      refusedFor({
        tiers: { worker: { adapter: 'acp:cx' } },
        agents: { cx: { kind: 'acp', command } },
      });
    }
    // The other built-in ACP agents still build.
    const ok = buildWorkerAdapters(
      { tiers: { worker: { adapter: 'acp:gemini' } } },
      { baseEnv: { GEMINI_API_KEY: 'placeholder' } },
    );
    expect(Object.keys(ok)).toEqual(['acp:gemini']);
  });

  it('names the tier or config path for everything it cannot build', () => {
    const cases: [Partial<TacetConfig>, RegExp][] = [
      [{ tiers: {} }, /no tiers\.worker/],
      [
        {
          review: { enabled: true },
          tiers: {
            worker: { adapter: 'claude-sdk', model: 'm' },
            review: { adapter: 'acp:claude-acp' },
          },
        },
        /tiers\.review: the reviewer runs anthropic models like the Worker/,
      ],
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

  it('reads keychain references through the platform tool, and names the path when it cannot (#160)', () => {
    const over = {
      tiers: { worker: { adapter: 'acp:goose' as const } },
      agents: {
        goose: {
          kind: 'acp' as const,
          command: ['goose'],
          env: { K: { keychain: 'tacet/goose' } },
        },
      },
    };
    const calls: string[][] = [];
    const built = buildWorkerAdapters(config(over), {
      baseEnv: {},
      keychain: {
        platform: 'linux',
        run: (_file, args) => {
          calls.push(args);
          return { status: 0, stdout: 'keychain-value-1234', stderr: '' };
        },
      },
    });
    expect(built['acp:goose']?.adapter.id).toBe('acp:goose');
    expect(calls).toEqual([['lookup', 'service', 'tacet', 'account', 'goose']]);
    // The same item for two agents is read once.
    calls.length = 0;
    buildWorkerAdapters(
      config({
        tiers: { worker: { adapter: 'acp:goose' }, review: { adapter: 'acp:moose' } },
        agents: {
          goose: { kind: 'acp', command: ['goose'], env: { K: { keychain: 'tacet/goose' } } },
          moose: { kind: 'acp', command: ['moose'], env: { K: { keychain: 'tacet/goose' } } },
        },
      }),
      {
        baseEnv: {},
        keychain: {
          platform: 'linux',
          run: (_file, args) => {
            calls.push(args);
            return { status: 0, stdout: 'keychain-value-1234', stderr: '' };
          },
        },
      },
    );
    expect(calls).toHaveLength(1);
    expect(() =>
      buildWorkerAdapters(config(over), {
        baseEnv: {},
        keychain: { platform: 'linux', run: () => ({ status: 1, stdout: '', stderr: '' }) },
      }),
    ).toThrow(/agents\.goose\.env\.K: no keyring item for service "tacet" and account "goose"/);
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

describe('a Codex Worker built from config (#186)', () => {
  it('starts in a linked worktree of the repo, with a CODEX_HOME keyed by the repo root', {
    timeout: 120_000,
  }, async () => {
    const api = await startMockResponsesApi();
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'tacet-build-codex-')));
    // Closed in `finally` too, so a failure part-way never leaves Codex running.
    let close = async () => {};
    try {
      const home = join(root, 'home');
      const repo = join(root, 'repo');
      const wt = join(root, 'worktrees', 'task-1');
      mkdirSync(home);
      mkdirSync(repo);
      const gitEnv = {
        PATH: process.env.PATH ?? '',
        HOME: home,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Tacet Test',
        GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'Tacet Test',
        GIT_COMMITTER_EMAIL: 'test@example.invalid',
      };
      const git = (...args: string[]) =>
        execFileSync('git', ['-C', repo, ...args], { env: gitEnv, stdio: 'ignore' });
      git('init', '-q', '-b', 'main');
      git('commit', '-q', '--allow-empty', '-m', 'init');
      git('worktree', 'add', '-q', wt, '-b', 'tacet/task-1');
      const built = buildWorkerAdapters(
        { tiers: { worker: { adapter: 'codex-app-server', model: 'gpt-5.5' } } },
        {
          repoRoot: repo,
          baseEnv: { ...gitEnv, OPENAI_API_KEY: 'placeholder-not-a-real-key' },
          codex: { apiBaseUrl: api.url },
        },
      );
      const adapter = built['codex-app-server']?.adapter;
      if (!adapter) throw new Error('no codex adapter');
      const h = await adapter.start({ cwd: wt });
      close = () => adapter.close(h).catch(() => {});
      const tap = new EventTap(adapter.events(h));
      await adapter.send(h, { text: 'SAY built' });
      const end = await tap.waitFor(
        (e) => e.t === 'status' && (e.state === 'idle' || e.state === 'error'),
        60_000,
        1,
      );
      await close();
      expect(end.event).toMatchObject({ state: 'idle' });
      expect(api.requests.some((r) => r.text === 'SAY built')).toBe(true);
      expect(existsSync(join(repoStateDir(repo, defaultStateDir(home)), 'codex'))).toBe(true);
      // It ran in the worktree as an unattended Worker: the adapter detached its HEAD (#116).
      expect(() =>
        execFileSync('git', ['-C', wt, 'symbolic-ref', '-q', 'HEAD'], {
          env: gitEnv,
          stdio: 'ignore',
        }),
      ).toThrow();
    } finally {
      await close();
      await api.close();
      rmSync(root, { recursive: true, force: true });
    }
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

describe.skipIf(!gate.ok)(gatedTitle('a PTY preset built from config (#149)', gate), () => {
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
              // A name that does not look secret: only the resolved reference marks it as one.
              env: { CLI_ENDPOINT: { env: 'MY_CLI_SECRET' } },
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
      await adapter.send(h, { text: 'PRINT_VAR CLI_ENDPOINT' });
      await tap.waitFor((e) => e.t === 'message.delta', 30_000);
      await adapter.close(h);
      expect(tap.events).toContainEqual({ t: 'message.delta', text: 'value: [redacted]' });
      expect(JSON.stringify(tap.events)).not.toContain(SECRET);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
