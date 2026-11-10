import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatExplain, mergeConfig } from '../../config/index.js';
import { ConfigError, loadConfig } from './load.js';

let root: string;
let userDir: string;
let repoRoot: string;
const write = (path: string, text: string) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tacet-config-'));
  userDir = join(root, 'home', '.tacet');
  repoRoot = join(root, 'repo');
  mkdirSync(repoRoot, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const USER = `
tiers:
  worker: { adapter: codex-app-server, model: gpt-codex-mini, effort: low }
escalation:
  autonomy: high
  always_ask: ["dependency upgrades"]
budget:
  per_day_usd: 25
policies:
  - { tool: Bash, match: "rm -rf *", decision: deny, reason: never }
`;
const REPO = `
tiers:
  worker: { adapter: claude-sdk, model: sonnet }
escalation:
  autonomy: medium
  always_ask: ["schema migrations"]
verify: [pnpm test, pnpm lint]
policies:
  - { tool: Bash, match: "pnpm *", decision: allow }
`;
const LOCAL = `
verify: [pnpm test]
budget:
  per_task_usd: 1.5
`;

describe('loadConfig', () => {
  it('applies precedence task > local > repo > user > defaults', () => {
    write(join(userDir, 'config.yaml'), USER);
    write(join(repoRoot, '.tacet', 'tacet.yaml'), REPO);
    write(join(repoRoot, '.tacet', 'local.yaml'), LOCAL);
    const { config } = loadConfig({ userDir, repoRoot, task: { budget: { per_task_usd: 0.5 } } });
    expect(config.tiers?.worker).toEqual({ adapter: 'claude-sdk', model: 'sonnet', effort: 'low' });
    expect(config.escalation?.autonomy).toBe('medium');
    expect(config.verify).toEqual(['pnpm test']);
    expect(config.budget).toEqual({
      api_key_per_month_usd: 200,
      per_day_usd: 25,
      per_task_usd: 0.5,
    });
    expect(config.handoff).toEqual({ warn: 0.55, handoff: 0.7, hard: 0.85 });
    expect(config.auth).toEqual({ unattended: 'api_key', interactive: 'subscription' });
  });

  it('unions safety lists instead of letting a higher layer drop them', () => {
    write(join(userDir, 'config.yaml'), USER);
    write(join(repoRoot, '.tacet', 'tacet.yaml'), REPO);
    const { config } = loadConfig({ userDir, repoRoot });
    expect(config.escalation?.always_ask).toEqual(['dependency upgrades', 'schema migrations']);
    expect(config.policies?.map((p) => p.decision)).toEqual(['deny', 'allow']);
  });

  it('explains every value with the layer and file that set it', () => {
    write(join(userDir, 'config.yaml'), USER);
    write(join(repoRoot, '.tacet', 'tacet.yaml'), REPO);
    write(join(repoRoot, '.tacet', 'local.yaml'), LOCAL);
    const eff = loadConfig({ userDir, repoRoot });
    const src = (path: string) =>
      eff.explain.find((e) => e.path === path)?.sources.map((s) => s.layer);
    expect(src('tiers.worker.adapter')).toEqual(['repo']);
    expect(src('tiers.worker.effort')).toEqual(['user']);
    expect(src('verify')).toEqual(['local']);
    expect(src('budget.api_key_per_month_usd')).toEqual(['default']);
    expect(src('escalation.always_ask')).toEqual(['default', 'user', 'repo']);
    const text = formatExplain(eff);
    expect(text).toContain(
      `verify = ["pnpm test"]    # local (${join(repoRoot, '.tacet', 'local.yaml')})`,
    );
    expect(text).toContain('budget.api_key_per_month_usd = 200    # default');
  });

  it('is deterministic: the same files give the same output, whatever the key order', () => {
    write(join(userDir, 'config.yaml'), USER);
    write(join(repoRoot, '.tacet', 'tacet.yaml'), REPO);
    const a = loadConfig({ userDir, repoRoot });
    // Same content as REPO, with top-level and nested keys in a different order.
    const reordered = [
      'policies:',
      '  - { decision: allow, match: "pnpm *", tool: Bash }',
      'verify: [pnpm test, pnpm lint]',
      'escalation:',
      '  always_ask: ["schema migrations"]',
      '  autonomy: medium',
      'tiers:',
      '  worker: { model: sonnet, adapter: claude-sdk }',
      '',
    ].join('\n');
    write(join(repoRoot, '.tacet', 'tacet.yaml'), reordered);
    const b = loadConfig({ userDir, repoRoot });
    expect(formatExplain(b)).toBe(formatExplain(a));
    const shuffled = mergeConfig([
      { name: 'repo', origin: 'r', data: { verify: ['b'] } },
      { name: 'user', origin: 'u', data: { verify: ['a'] } },
    ]);
    expect(shuffled.config.verify).toEqual(['b']);
  });

  it('works with no files at all (defaults only)', () => {
    const { config } = loadConfig({ userDir, repoRoot });
    expect(config.budget?.api_key_per_month_usd).toBe(200);
    expect(config.events?.retention?.transcript_days).toBe(30);
  });

  it('defaults the Worker pool and rejects unknown or invalid worker keys', () => {
    const { config } = loadConfig({ userDir, repoRoot });
    expect(config.workers).toEqual({
      max: 4,
      stuck_after_s: 300,
      nudge_grace_s: 900,
      max_attempts: 3,
    });
    write(
      join(repoRoot, '.tacet', 'tacet.yaml'),
      'workers: { max: 2, per_adapter: { codex-app-server: 1 } }\n',
    );
    expect(loadConfig({ userDir, repoRoot }).config.workers).toMatchObject({
      max: 2,
      per_adapter: { 'codex-app-server': 1 },
      max_attempts: 3,
    });
    write(join(repoRoot, '.tacet', 'tacet.yaml'), 'workers: { max: 0, maximum: 3 }\n');
    expect(() => loadConfig({ userDir, repoRoot })).toThrow(ConfigError);
    // A typo in an adapter id is an error, not a silent no-op.
    write(
      join(repoRoot, '.tacet', 'tacet.yaml'),
      'workers: { per_adapter: { codex-app-sever: 1 } }\n',
    );
    expect(() => loadConfig({ userDir, repoRoot })).toThrow(/per_adapter/);
    write(join(repoRoot, '.tacet', 'tacet.yaml'), 'workers: { max: 2, per_adapter: { pty: 3 } }\n');
    expect(() => loadConfig({ userDir, repoRoot })).toThrow(/more than workers.max/);
  });

  it('lets a task lower the Worker pool limits but never raise them', () => {
    write(
      join(repoRoot, '.tacet', 'tacet.yaml'),
      'workers: { max: 3, per_adapter: { claude-sdk: 2 } }\n',
    );
    const lowered = loadConfig({
      userDir,
      repoRoot,
      task: { workers: { max: 1, per_adapter: { 'claude-sdk': 1, pty: 1 }, stuck_after_s: 60 } },
    }).config.workers;
    expect(lowered).toMatchObject({
      max: 1,
      per_adapter: { 'claude-sdk': 1, pty: 1 },
      stuck_after_s: 60,
    });
    for (const task of [
      { workers: { max: 8 } },
      { workers: { per_adapter: { 'claude-sdk': 3 } } },
      // A cap the repo does not set is compared with workers.max.
      { workers: { per_adapter: { pty: 4 } } },
      { workers: { max_attempts: 9 } },
    ]) {
      expect(() => loadConfig({ userDir, repoRoot, task })).toThrow(/may only lower it/);
    }
  });

  it('merges workers.per_adapter key by key across layers', () => {
    write(
      join(userDir, 'config.yaml'),
      'workers: { per_adapter: { claude-sdk: 2, acp:goose: 1 } }\n',
    );
    write(join(repoRoot, '.tacet', 'tacet.yaml'), 'workers: { per_adapter: { claude-sdk: 1 } }\n');
    expect(loadConfig({ userDir, repoRoot }).config.workers?.per_adapter).toEqual({
      'claude-sdk': 1,
      'acp:goose': 1,
    });
  });

  it('unions workers.env.pass across layers; the repo layer may not pass a secret by name', () => {
    write(join(userDir, 'config.yaml'), 'workers: { env: { pass: [NPM_TOKEN, JDK_*] } }\n');
    write(join(repoRoot, '.tacet', 'tacet.yaml'), 'workers: { env: { pass: [MYAPP_*, JDK_*] } }\n');
    write(join(repoRoot, '.tacet', 'local.yaml'), 'workers: { env: { pass: [ROLLUP_CACHE] } }\n');
    expect(loadConfig({ userDir, repoRoot }).config.workers?.env?.pass).toEqual([
      'NPM_TOKEN',
      'JDK_*',
      'MYAPP_*',
      'ROLLUP_CACHE',
    ]);
    // Each value shows every layer that added to it.
    expect(formatExplain(loadConfig({ userDir, repoRoot }))).toMatch(
      /^workers\.env\.pass = .*# user \(.*\) \+ repo \(.*\) \+ local \(.*\)$/m,
    );
    // The local layer, which is the user's own, may name a secret.
    write(join(repoRoot, '.tacet', 'local.yaml'), 'workers: { env: { pass: [GITHUB_TOKEN] } }\n');
    expect(loadConfig({ userDir, repoRoot }).config.workers?.env?.pass).toContain('GITHUB_TOKEN');
    write(join(repoRoot, '.tacet', 'local.yaml'), 'workers: { env: { pass: [ROLLUP_CACHE] } }\n');
    // A prefix is fine in the repo layer: it never lets a secret-looking name through.
    write(join(repoRoot, '.tacet', 'tacet.yaml'), 'workers: { env: { pass: [AWS_*] } }\n');
    expect(() => loadConfig({ userDir, repoRoot })).not.toThrow();
    write(join(repoRoot, '.tacet', 'tacet.yaml'), 'workers: { env: { pass: [GITHUB_TOKEN] } }\n');
    expect(() => loadConfig({ userDir, repoRoot })).toThrow(/GITHUB_TOKEN looks like a secret/);
    for (const bad of ['"*"', '"A-B"', '"*_X"']) {
      write(join(repoRoot, '.tacet', 'tacet.yaml'), `workers: { env: { pass: [${bad}] } }\n`);
      expect(() => loadConfig({ userDir, repoRoot })).toThrow(/workers.env.pass/);
    }
  });

  it('never lets a task change the Worker environment', () => {
    expect(() =>
      loadConfig({ userDir, repoRoot, task: { workers: { env: { pass: ['MYAPP_*'] } } } }),
    ).toThrow(/task layer .* may not change a Worker's environment/);
  });

  it('reports every problem with file, line and column', () => {
    write(
      join(repoRoot, '.tacet', 'tacet.yaml'),
      'escalation:\n  autonomy: maybe\nbudgte:\n  per_day_usd: 3\nhandoff:\n  warn: 2\n',
    );
    write(join(repoRoot, '.tacet', 'local.yaml'), 'verify: [unclosed\n');
    let issues: string[] = [];
    try {
      loadConfig({ userDir, repoRoot });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      issues = (err as ConfigError).issues;
    }
    const repoFile = join(repoRoot, '.tacet', 'tacet.yaml');
    expect(issues.some((i) => i.startsWith(`${repoFile}:2:13: escalation.autonomy:`))).toBe(true);
    expect(issues.some((i) => i.includes('unknown key(s): budgte'))).toBe(true);
    expect(issues.some((i) => i.startsWith(`${repoFile}:6:9: handoff.warn:`))).toBe(true);
    expect(issues.some((i) => i.startsWith(join(repoRoot, '.tacet', 'local.yaml')))).toBe(true);
  });

  it('rejects inconsistent handoff bands after merging', () => {
    write(join(repoRoot, '.tacet', 'tacet.yaml'), 'handoff: { warn: 0.8 }\n');
    expect(() => loadConfig({ userDir, repoRoot })).toThrow(/warn < handoff < hard/);
  });

  it('refuses literal secrets and never echoes them', () => {
    const key = `sk-ant-api03-${'x'.repeat(40)}`;
    write(
      join(repoRoot, '.tacet', 'tacet.yaml'),
      `agents:\n  goose:\n    kind: acp\n    command: [goose, acp, --key, "${key}"]\n`,
    );
    let message = '';
    try {
      loadConfig({ userDir, repoRoot });
    } catch (err) {
      message = String(err);
    }
    expect(message).toMatch(/agents\.goose\.command\[3\] looks like a Anthropic API key/);
    expect(message).toContain('{ env: "NAME" }');
    expect(message).not.toContain(key);
  });

  it('accepts secret references and agent presets', () => {
    write(
      join(userDir, 'config.yaml'),
      `agents:\n  goose:\n    kind: acp\n    command: [goose, acp]\n    env: { GOOSE_API_KEY: { env: GOOSE_API_KEY } }\n  aider:\n    kind: pty\n    command: [aider]\n    ready_prompt: "> "\n    resume_flag: --restore-chat-history\nsecrets:\n  webhook: { keychain: tacet/webhook }\n`,
    );
    const { config } = loadConfig({ userDir });
    expect(config.agents?.goose?.env).toEqual({ GOOSE_API_KEY: { env: 'GOOSE_API_KEY' } });
    expect(config.agents?.aider?.kind).toBe('pty');
    expect(config.secrets?.webhook).toEqual({ keychain: 'tacet/webhook' });
  });

  it('refuses empty resume arguments and the removed process_name (#157)', () => {
    for (const bad of ['resume_flag: []', 'resume_flag: ""', 'process_name: aider']) {
      write(
        join(userDir, 'config.yaml'),
        `agents:\n  aider:\n    kind: pty\n    command: [aider]\n    ${bad}\n`,
      );
      expect(() => loadConfig({ userDir }), bad).toThrow(ConfigError);
    }
  });

  it('replaces a secret reference whole when a higher layer switches its kind', () => {
    const layers = (lower: object, higher: object) =>
      mergeConfig([
        { name: 'user', origin: 'u', data: lower },
        { name: 'local', origin: 'l', data: higher },
      ]);
    const toKeychain = layers(
      { secrets: { webhook: { env: 'WEBHOOK_TOKEN' } } },
      { secrets: { webhook: { keychain: 'tacet/webhook' } } },
    );
    expect(toKeychain.config.secrets).toEqual({ webhook: { keychain: 'tacet/webhook' } });
    expect(toKeychain.errors).toEqual([]);
    expect(toKeychain.explain.find((e) => e.path === 'secrets.webhook')?.sources).toEqual([
      { layer: 'local', origin: 'l' },
    ]);
    const toEnv = layers(
      { secrets: { webhook: { keychain: 'tacet/webhook' } } },
      { secrets: { webhook: { env: 'WEBHOOK_TOKEN' } } },
    );
    expect(toEnv.config.secrets).toEqual({ webhook: { env: 'WEBHOOK_TOKEN' } });

    const agent = (env: object) => ({
      agents: { goose: { kind: 'acp', command: ['goose'], env } },
    });
    const agentEnv = layers(
      agent({ KEY: { env: 'GOOSE_KEY' }, OTHER: { env: 'OTHER' } }),
      agent({ KEY: { keychain: 'tacet/goose' } }),
    );
    expect(agentEnv.config.agents?.goose?.env).toEqual({
      KEY: { keychain: 'tacet/goose' },
      OTHER: { env: 'OTHER' },
    });
    expect(agentEnv.errors).toEqual([]);
  });

  it('replaces references whole even when names contain dots or are empty', () => {
    const merged = mergeConfig([
      {
        name: 'user',
        origin: 'u',
        data: {
          secrets: { 'webhook.prod': { env: 'WEBHOOK_TOKEN' } },
          agents: {
            goose: {
              kind: 'acp',
              command: ['goose'],
              env: { 'A.B': { env: 'AB' }, '': { env: 'EMPTY' } },
            },
          },
        },
      },
      {
        name: 'local',
        origin: 'l',
        data: {
          secrets: { 'webhook.prod': { keychain: 'tacet/webhook' } },
          agents: {
            goose: {
              kind: 'acp',
              command: ['goose'],
              env: { 'A.B': { keychain: 'tacet/ab' }, '': { keychain: 'tacet/empty' } },
            },
          },
        },
      },
    ]);
    expect(merged.errors).toEqual([]);
    expect(merged.config.secrets?.['webhook.prod']).toEqual({ keychain: 'tacet/webhook' });
    expect(merged.config.agents?.['goose']?.env).toEqual({
      'A.B': { keychain: 'tacet/ab' },
      '': { keychain: 'tacet/empty' },
    });
  });

  it('checks tier bounds on the merged config, and keeps them from the task layer (#110)', () => {
    const user = {
      tiers: {
        worker: {
          adapter: 'claude-sdk',
          model: 'claude-sonnet-4-6',
          models: ['claude-sonnet-4-6', 'claude-opus-4-6'],
          effort: 'medium' as const,
          max_effort: 'high' as const,
        },
      },
    };
    const ok = mergeConfig([{ name: 'user', origin: 'u', data: user }]);
    expect(ok.errors).toEqual([]);
    // The task layer may pick within the bounds...
    const within = mergeConfig([
      { name: 'user', origin: 'u', data: user },
      {
        name: 'task',
        origin: 't',
        data: { tiers: { worker: { adapter: 'claude-sdk', effort: 'high' } } },
      },
    ]);
    expect(within.errors).toEqual([]);
    // ...but not outside them, and not move them.
    const outside = mergeConfig([
      { name: 'user', origin: 'u', data: user },
      {
        name: 'task',
        origin: 't',
        data: { tiers: { worker: { adapter: 'claude-sdk', model: 'gpt-5.5', effort: 'max' } } },
      },
    ]);
    expect(outside.errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/tiers\.worker\.model: gpt-5\.5 is not in tiers\.worker\.models/),
        expect.stringMatching(/tiers\.worker\.effort: max is above tiers\.worker\.max_effort/),
      ]),
    );
    const widened = mergeConfig([
      { name: 'user', origin: 'u', data: user },
      {
        name: 'task',
        origin: 't',
        data: {
          tiers: {
            worker: { adapter: 'claude-sdk', max_effort: 'max', max_context_window: 1_000_000 },
          },
        },
      },
    ]);
    expect(widened.errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/tiers\.worker\.max_effort: the task layer .* may not set it/),
        expect.stringMatching(
          /tiers\.worker\.max_context_window: the task layer .* may not set it/,
        ),
      ]),
    );
    // Effort names outside the known levels are a config error, as for any enum in config.
    const typo = mergeConfig([
      {
        name: 'user',
        origin: 'u',
        data: { tiers: { worker: { adapter: 'x', effort: 'hgih' } } } as never,
      },
    ]);
    expect(typo.errors.some((e) => e.startsWith('tiers.worker.effort'))).toBe(true);
  });

  it('reports a merged config that no longer matches the schema', () => {
    const bad = mergeConfig([
      { name: 'user', origin: 'u', data: { secrets: { x: { env: 'A', keychain: 'b' } } } as never },
    ]);
    expect(bad.errors.some((e) => e.startsWith('secrets.x'))).toBe(true);
  });

  it('refuses a subscription login for unattended Workers, allows it for interactive ones', () => {
    write(join(userDir, 'config.yaml'), 'auth:\n  unattended: subscription\n');
    expect(() => loadConfig({ userDir, repoRoot })).toThrow(
      /auth\.unattended must be "api_key".*#65/s,
    );
    write(
      join(userDir, 'config.yaml'),
      'auth:\n  unattended: api_key\n  interactive: subscription\n',
    );
    expect(loadConfig({ userDir, repoRoot }).config.auth).toEqual({
      unattended: 'api_key',
      interactive: 'subscription',
    });
  });

  it('validates task overrides like any other layer', () => {
    expect(() => loadConfig({ userDir, task: { budget: { per_task_usd: -1 } } })).toThrow(
      /task overrides/,
    );
  });
});
