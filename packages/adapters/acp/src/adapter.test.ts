import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mcpAuthHeaders, Secret } from '@tacet/core/node';
import { EventTap } from '@tacet/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AcpAdapter, AuthRoutingError } from './adapter.js';
import { type AcpAgentSpec, CLAUDE_ACP_AGENT, customAcpAgent, GEMINI_AGENT } from './agents.js';

const FAKE = join(import.meta.dirname, 'testing', 'fake-acp-agent.mjs');
const TOKEN = 'worker-token-0123456789abcdef';

describe('AcpAdapter (fake ACP agent)', () => {
  let root: string;
  let logFile: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tacet-acp-unit-')));
    logFile = join(root, 'agent.jsonl');
    mkdirSync(join(root, 'wt'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const make = (agent: AcpAgentSpec, env: Record<string, string> = {}, extra: object = {}) =>
    new AcpAdapter({
      agent,
      executable: [process.execPath, FAKE],
      killTimeoutMs: 1000,
      baseEnv: { PATH: process.env.PATH, HOME: root, FAKE_LOG: logFile, ...env },
      ...extra,
    });
  const received = () =>
    existsSync(logFile)
      ? readFileSync(logFile, 'utf8')
          .trim()
          .split('\n')
          .map(
            (l) =>
              JSON.parse(l) as {
                argv?: string[];
                received?: { method?: string; params?: unknown };
              },
          )
      : [];
  const methods = () => received().flatMap((l) => (l.received?.method ? [l.received] : []));

  it('authenticates only with an API-key method, never a subscription login', async () => {
    const offered = [
      { id: 'oauth-personal', name: 'Log in with Google' },
      { id: 'gemini-api-key', name: 'Gemini API key' },
      { id: 'vertex-ai', name: 'Vertex AI' },
    ];
    const adapter = make(GEMINI_AGENT, {
      GEMINI_API_KEY: 'placeholder',
      FAKE_AUTH_METHODS: JSON.stringify(offered),
    });
    const h = await adapter.start({ cwd: join(root, 'wt') });
    await adapter.close(h);
    expect(methods().filter((m) => m.method === 'authenticate')).toEqual([
      expect.objectContaining({ params: { methodId: 'gemini-api-key' } }),
    ]);
  });

  it('never calls authenticate when only login methods are offered', async () => {
    const logins = [
      { id: 'claude-ai-login', name: 'Claude Subscription' },
      { id: 'console-login', name: 'Anthropic Console' },
    ];
    const adapter = make(CLAUDE_ACP_AGENT, {
      ANTHROPIC_API_KEY: 'placeholder',
      FAKE_AUTH_METHODS: JSON.stringify(logins),
    });
    const h = await adapter.start({ cwd: join(root, 'wt') });
    await adapter.close(h);
    expect(methods().some((m) => m.method === 'authenticate')).toBe(false);
    // Launched with the subscription login hidden.
    expect(received()[0]?.argv).toContain('--hide-claude-auth');
  });

  it('refuses to start without an API key, and when the agent wants a login', async () => {
    await expect(make(GEMINI_AGENT).start({ cwd: join(root, 'wt') })).rejects.toThrow(
      AuthRoutingError,
    );
    expect(existsSync(logFile)).toBe(false);
    const wantsLogin = make(GEMINI_AGENT, {
      GEMINI_API_KEY: 'placeholder',
      FAKE_REQUIRE_AUTH: '1',
      FAKE_AUTH_METHODS: JSON.stringify([{ id: 'oauth-personal', name: 'Log in with Google' }]),
    });
    await expect(wantsLogin.start({ cwd: join(root, 'wt') })).rejects.toThrow(AuthRoutingError);
    expect(methods().some((m) => m.method === 'authenticate')).toBe(false);
  });

  it('passes the Worker MCP server in session/new only: never in argv or on disk', async () => {
    const adapter = make(GEMINI_AGENT, { GEMINI_API_KEY: 'placeholder' });
    const headers = mcpAuthHeaders(new Secret(TOKEN));
    const h = await adapter.start({
      cwd: join(root, 'wt'),
      mcpServers: [{ name: 'tacet', url: 'http://127.0.0.1:1/mcp', headers }],
    });
    const tap = new EventTap(adapter.events(h));
    await adapter.send(h, { text: 'hi' });
    await tap.waitFor((e) => e.t === 'status' && e.state === 'idle', 5000, 1);
    await adapter.close(h);
    const created = methods().find((m) => m.method === 'session/new');
    expect(created?.params).toMatchObject({
      mcpServers: [
        {
          type: 'http',
          name: 'tacet',
          url: 'http://127.0.0.1:1/mcp',
          headers: [{ name: 'Authorization', value: `Bearer ${TOKEN}` }],
        },
      ],
    });
    expect(JSON.stringify(received()[0]?.argv)).not.toContain(TOKEN);
    // Nothing but the agent's own log (outside the worktree) holds it; the worktree is untouched.
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        return statSync(p).isDirectory() ? files(p) : [p];
      });
    for (const f of files(root).filter((f) => f !== logFile)) {
      expect(readFileSync(f, 'utf8')).not.toContain(TOKEN);
    }
    expect(readdirSync(join(root, 'wt'))).toEqual([]);
    expect(JSON.stringify(tap.events)).not.toContain(TOKEN);
  });

  it('hands stderr to the Worker log, scrubbed', async () => {
    const lines: string[] = [];
    const adapter = make(
      GEMINI_AGENT,
      { GEMINI_API_KEY: 'placeholder', FAKE_STDERR: `debug: token ${TOKEN}` },
      { stderr: (text: string) => lines.push(text) },
    );
    const h = await adapter.start({
      cwd: join(root, 'wt'),
      mcpServers: [{ name: 'tacet', url: 'http://x', headers: mcpAuthHeaders(new Secret(TOKEN)) }],
    });
    await adapter.close(h);
    expect(lines.join('')).toContain('debug: token [redacted]');
    expect(lines.join('')).not.toContain(TOKEN);
  });

  it('refuses effort, context sizes and forks it does not support', async () => {
    const adapter = make(GEMINI_AGENT, { GEMINI_API_KEY: 'placeholder' });
    const cwd = join(root, 'wt');
    await expect(adapter.start({ cwd, effort: 'high' })).rejects.toThrow(/effort/);
    await expect(adapter.start({ cwd, contextWindow: 2_000_000 })).rejects.toThrow(/context/);
    await expect(
      adapter.start({ cwd, resume: { vendorSessionId: 'x', fork: true } }),
    ).rejects.toThrow(/fork/);
  });
});

describe('ACP agent registry', () => {
  it('adds any ACP agent as acp:<slug>, declaring only the baseline', () => {
    const spec = customAcpAgent('goose', { command: ['goose', 'acp'] });
    expect(spec.id).toBe('acp:goose');
    expect(spec.capabilities).toMatchObject({
      resume: false,
      fork: 'none',
      modelSwitch: 'launch-only',
    });
    expect(new AcpAdapter({ agent: spec }).id).toBe('acp:goose');
    expect(() => customAcpAgent('Bad Slug', { command: ['x'] })).toThrow(/slug/);
    expect(() => customAcpAgent('ok', { command: [] })).toThrow(/command/);
  });
});
