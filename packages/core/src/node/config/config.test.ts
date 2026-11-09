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
    expect(config.retention?.transcript_days).toBe(30);
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

  it('validates task overrides like any other layer', () => {
    expect(() => loadConfig({ userDir, task: { budget: { per_task_usd: -1 } } })).toThrow(
      /task overrides/,
    );
  });
});
