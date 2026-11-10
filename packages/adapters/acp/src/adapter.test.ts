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
import type { AgentEvent } from '@tacet/core';
import { ProfileRefusedError } from '@tacet/core';
import { mcpAuthHeaders, Secret } from '@tacet/core/node';
import { EventTap } from '@tacet/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AcpAdapter, AuthRoutingError } from './adapter.js';
import {
  type AcpAgentSpec,
  BUILTIN_ACP_AGENTS,
  CLAUDE_ACP_AGENT,
  CODEX_ACP_AGENT,
  customAcpAgent,
  GEMINI_AGENT,
} from './agents.js';

const FAKE = join(import.meta.dirname, 'testing', 'fake-acp-agent.mjs');
const TOKEN = 'worker-token-0123456789abcdef';

async function until(ok: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}
const ends = (e: AgentEvent) => e.t === 'status' && e.state !== 'running';
const text = (events: AgentEvent[]) =>
  events.map((e) => (e.t === 'message.delta' ? e.text : '')).join('');

/** The session modes the built-in specs put their sessions in (#145), as an agent offers them. */
const BUILTIN_MODES = {
  FAKE_SESSION: JSON.stringify({
    modes: {
      currentModeId: 'default',
      availableModes: [
        { id: 'default', name: 'Manual' },
        { id: 'workspace-write', name: 'Workspace access' },
      ],
    },
  }),
};

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
      baseEnv: { PATH: process.env.PATH, HOME: root, FAKE_LOG: logFile, ...BUILTIN_MODES, ...env },
      // The fake agent is steered by FAKE_* variables (#147: passed through on purpose).
      envPolicy: { pass: ['FAKE_*'] },
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

  it('exposes why an agent may not run Workers (#183)', () => {
    expect(make(CODEX_ACP_AGENT).workerRefused).toMatch(/#183/);
    expect(make(GEMINI_AGENT).workerRefused).toBeUndefined();
  });

  it('authenticates only with an API-key method, never a subscription login', async () => {
    const offered = [
      { id: 'oauth-personal', name: 'Log in with Google' },
      { id: 'gemini-api-key', name: 'Gemini API key' },
      { id: 'vertex-ai', name: 'Vertex AI' },
    ];
    const adapter = make(GEMINI_AGENT, {
      GEMINI_API_KEY: 'placeholder',
      FAKE_LOGIN_METHODS: JSON.stringify(offered),
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
      FAKE_LOGIN_METHODS: JSON.stringify(logins),
    });
    const h = await adapter.start({ cwd: join(root, 'wt') });
    await adapter.close(h);
    expect(methods().some((m) => m.method === 'authenticate')).toBe(false);
    // Launched with the subscription login hidden.
    expect(received()[0]?.argv).toContain('--hide-claude-auth');
  });

  it('gives the agent an allowlist of the environment, not other vendors keys (#147)', async () => {
    const dropped: string[][] = [];
    const adapter = make(
      GEMINI_AGENT,
      {
        GEMINI_API_KEY: 'placeholder',
        GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:9',
        GOOGLE_APPLICATION_CREDENTIALS: '/tmp/adc.json',
        ANTHROPIC_API_KEY: 'sk-ant-other-vendor',
        OPENAI_API_KEY: 'sk-other-vendor',
        GITHUB_SHA: 'abc',
      },
      { onEnvDropped: (n: string[]) => dropped.push(n) },
    );
    const h = await adapter.start({ cwd: join(root, 'wt'), env: { TACET_WORKER_MARKER: 'm-1' } });
    await adapter.close(h);
    const names = (received()[0] as { envNames?: string[] }).envNames ?? [];
    expect(names).toEqual(
      expect.arrayContaining(['GEMINI_API_KEY', 'GOOGLE_GEMINI_BASE_URL', 'TACET_WORKER_MARKER']),
    );
    for (const n of [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'GITHUB_SHA',
    ]) {
      expect(names).not.toContain(n);
    }
    expect(dropped).toEqual([
      ['ANTHROPIC_API_KEY', 'GITHUB_SHA', 'GOOGLE_APPLICATION_CREDENTIALS', 'OPENAI_API_KEY'],
    ]);
  });

  for (const [spec, own, other] of [
    [CLAUDE_ACP_AGENT, 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
    [CODEX_ACP_AGENT, 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
  ] as const) {
    it(`gives ${spec.id} its own key only`, async () => {
      const adapter = make(spec, {
        [own]: 'placeholder',
        [other]: 'other-vendor',
        GEMINI_API_KEY: 'x',
      });
      const h = await adapter.start({ cwd: join(root, 'wt') });
      await adapter.close(h);
      const names = (received()[0] as { envNames?: string[] }).envNames ?? [];
      expect(names).toContain(own);
      expect(names).not.toContain(other);
      expect(names).not.toContain('GEMINI_API_KEY');
    });
  }

  it('refuses to start without an API key, and when the agent wants a login', async () => {
    await expect(make(GEMINI_AGENT).start({ cwd: join(root, 'wt') })).rejects.toThrow(
      AuthRoutingError,
    );
    expect(existsSync(logFile)).toBe(false);
    const wantsLogin = make(GEMINI_AGENT, {
      GEMINI_API_KEY: 'placeholder',
      FAKE_NEEDS_LOGIN: '1',
      FAKE_LOGIN_METHODS: JSON.stringify([{ id: 'oauth-personal', name: 'Log in with Google' }]),
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
    // The fake writes the line in two chunks, split inside the token.
    await until(() => lines.join('').includes('\n'));
    await adapter.close(h);
    expect(lines.join('')).toContain('debug: token [redacted]');
    expect(lines.join('')).not.toContain(TOKEN);
  });

  describe('turns', () => {
    const gemini = (env: Record<string, string> = {}) =>
      make(GEMINI_AGENT, { GEMINI_API_KEY: 'placeholder', ...env });
    /** The client's answers to the agent's permission requests, and where `session/cancel` is. */
    const traffic = () => {
      const lines = received().flatMap((l) => (l.received ? [l.received] : []));
      const cancelAt = lines.findIndex((m) => m.method === 'session/cancel');
      const answers = lines.flatMap((m, i) => {
        const r = (m as { result?: { outcome?: { outcome?: string } } }).result;
        return m.method === undefined && r?.outcome ? [{ at: i, outcome: r.outcome.outcome }] : [];
      });
      return { cancelAt, answers };
    };

    for (const how of ['interrupt', 'respond cancel'] as const) {
      it(`${how}: session/cancel first, then every open permission answered cancelled`, async () => {
        const adapter = gemini();
        const h = await adapter.start({ cwd: join(root, 'wt') });
        const tap = new EventTap(adapter.events(h));
        await adapter.send(h, { text: 'PERMS' });
        await until(() => tap.events.filter((e) => e.t === 'approval.request').length === 2);
        const first = tap.events.find((e) => e.t === 'approval.request');
        if (first?.t !== 'approval.request') throw new Error('no approval request');
        expect(first.options).toEqual(['allow_once', 'reject', 'cancel']);
        if (how === 'interrupt') await adapter.interrupt(h);
        else await adapter.respond(h, first.id, { kind: 'cancel', persist: false });
        const end = await tap.waitFor(ends, 5000, 1);
        expect(end.event).toMatchObject({ state: 'cancelled' });
        const { cancelAt, answers } = traffic();
        expect(cancelAt).toBeGreaterThan(-1);
        expect(answers).toHaveLength(2);
        for (const a of answers) {
          expect(a.outcome).toBe('cancelled');
          expect(a.at).toBeGreaterThan(cancelAt);
        }
        // The session takes the next turn.
        await adapter.send(h, { text: 'next' });
        const next = await tap.waitFor(ends, 5000, end.index + 1);
        expect(next.event).toMatchObject({ state: 'idle' });
        await adapter.close(h);
      });
    }

    it('maps a prompt failed with -32800 after a cancel to a cancelled turn', async () => {
      const adapter = gemini();
      const h = await adapter.start({ cwd: join(root, 'wt') });
      const tap = new EventTap(adapter.events(h));
      await adapter.send(h, { text: 'ABORT' });
      await until(() => methods().some((m) => m.method === 'session/prompt'));
      await adapter.interrupt(h);
      const end = await tap.waitFor(ends, 5000, 1);
      expect(end.event).toEqual({ t: 'status', state: 'cancelled' });
      await adapter.close(h);
    });

    it('runs input sent during a turn as the next turn, in order', async () => {
      const adapter = gemini();
      const h = await adapter.start({ cwd: join(root, 'wt') });
      const tap = new EventTap(adapter.events(h));
      await adapter.send(h, { text: 'SLOW first' });
      await adapter.send(h, { text: 'second' });
      await tap.waitFor((e) => e.t === 'message.delta' && e.text === 'second', 5000);
      await tap.waitFor(ends, 5000, tap.events.length - 1);
      expect(text(tap.events)).toBe('firstsecond');
      expect(
        tap.events.filter((e) => e.t === 'status').map((e) => e.t === 'status' && e.state),
      ).toEqual(['idle', 'running', 'idle', 'running', 'idle']);
      await adapter.close(h);
    });

    it('reports a crash mid-turn as an error and ends the events', async () => {
      const adapter = gemini();
      const h = await adapter.start({ cwd: join(root, 'wt') });
      const events: AgentEvent[] = [];
      const done = (async () => {
        for await (const e of adapter.events(h)) events.push(e);
      })();
      await adapter.send(h, { text: 'CRASH' });
      await done;
      const statuses = events.filter((e) => e.t === 'status');
      expect(statuses.at(-1)).toMatchObject({
        state: 'error',
        message: expect.stringMatching(/exited \(3\)/),
      });
      expect(statuses.filter((e) => e.t === 'status' && e.state === 'error')).toHaveLength(1);
      expect(adapter.status(h)).toBe('error');
      await adapter.close(h);
    });

    it('resumes by session/load without replaying the history as new output', async () => {
      const adapter = gemini({ FAKE_CAPS: JSON.stringify({ loadSession: true }) });
      const h = await adapter.start({
        cwd: join(root, 'wt'),
        resume: { vendorSessionId: 'old-1' },
      });
      expect(h.vendorSessionId).toBe('old-1');
      const tap = new EventTap(adapter.events(h));
      await adapter.send(h, { text: 'hello' });
      await tap.waitFor(ends, 5000, 1);
      expect(text(tap.events)).toBe('hello');
      expect(methods().find((m) => m.method === 'session/load')?.params).toMatchObject({
        sessionId: 'old-1',
      });
      expect(methods().find((m) => m.method === 'session/prompt')?.params).toMatchObject({
        sessionId: 'old-1',
      });
      await adapter.close(h);
    });

    it('prefers session/resume when the agent offers it, and refuses a resume it cannot do', async () => {
      const caps = { loadSession: true, sessionCapabilities: { resume: {} } };
      const adapter = gemini({ FAKE_CAPS: JSON.stringify(caps) });
      const h = await adapter.start({
        cwd: join(root, 'wt'),
        resume: { vendorSessionId: 'old-2' },
      });
      await adapter.close(h);
      expect(methods().map((m) => m.method)).toContain('session/resume');
      expect(methods().map((m) => m.method)).not.toContain('session/load');
      await expect(
        gemini().start({ cwd: join(root, 'wt'), resume: { vendorSessionId: 'x' } }),
      ).rejects.toThrow(/neither session\/resume nor session\/load/);
    });
  });

  it("scrubs the agent's configured secrets and its API key from events and stderr", async () => {
    const lines: string[] = [];
    const spec = customAcpAgent('goose', {
      command: ['goose', 'acp'],
      env: { FAKE_STDERR: 'debug: preset-secret-1234 and key-of-the-user' },
      apiKeyEnv: ['GOOSE_KEY'],
    });
    const adapter = make(
      spec,
      { GOOSE_KEY: 'key-of-the-user' },
      { secrets: ['preset', 'preset-secret-1234'], stderr: (t: string) => lines.push(t) },
    );
    const h = await adapter.start({ cwd: join(root, 'wt') });
    const tap = new EventTap(adapter.events(h));
    // The fake replies with the prompt's text.
    await adapter.send(h, { text: 'echo preset-secret-1234 key-of-the-user' });
    await tap.waitFor((e) => e.t === 'status' && e.state === 'idle', 5000, 1);
    await until(() => lines.join('').includes('\n'));
    await adapter.close(h);
    const text = tap.events.flatMap((e) => (e.t === 'message.delta' ? [e.text] : [])).join('');
    expect(text).toBe('echo [redacted] [redacted]');
    expect(lines.join('')).toContain('debug: [redacted] and [redacted]');
  });

  describe('session mode (#145)', () => {
    const spec = (sessionMode: string): AcpAgentSpec => ({
      ...customAcpAgent('modes', { command: ['modes'] }),
      sessionMode,
    });
    const select = (currentValue: string) => ({
      configOptions: [
        {
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          type: 'select',
          currentValue,
          options: [
            { value: 'ask', name: 'Ask' },
            { value: 'auto', name: 'Auto' },
          ],
        },
      ],
    });
    const modes = {
      currentModeId: 'auto',
      availableModes: [
        { id: 'ask', name: 'Ask' },
        { id: 'auto', name: 'Auto' },
      ],
    };

    it('sets it by the mode config option right after the session opens', async () => {
      const adapter = make(spec('ask'), {
        FAKE_SESSION: JSON.stringify({ ...select('auto'), modes }),
      });
      const h = await adapter.start({ cwd: join(root, 'wt') });
      await adapter.close(h);
      const sent = methods().map((m) => m.method);
      expect(sent.indexOf('session/set_config_option')).toBe(sent.indexOf('session/new') + 1);
      expect(methods().find((m) => m.method === 'session/set_config_option')?.params).toEqual({
        sessionId: 'fake-session-1',
        configId: 'mode',
        value: 'ask',
      });
      expect(sent).not.toContain('session/set_mode');
    });

    it('uses session/set_mode when the agent has no mode config option', async () => {
      const adapter = make(spec('ask'), { FAKE_SESSION: JSON.stringify({ modes }) });
      const h = await adapter.start({ cwd: join(root, 'wt') });
      await adapter.close(h);
      expect(methods().find((m) => m.method === 'session/set_mode')?.params).toEqual({
        sessionId: 'fake-session-1',
        modeId: 'ask',
      });
    });

    it('sends nothing when the session is already in the mode', async () => {
      const adapter = make(spec('ask'), { FAKE_SESSION: JSON.stringify(select('ask')) });
      const h = await adapter.start({ cwd: join(root, 'wt') });
      await adapter.close(h);
      expect(methods().map((m) => m.method)).not.toContain('session/set_config_option');
    });

    it('fails to start when the agent does not offer the mode', async () => {
      for (const session of [{}, { modes }, select('auto')]) {
        const adapter = make(spec('manual'), { FAKE_SESSION: JSON.stringify(session) });
        await expect(adapter.start({ cwd: join(root, 'wt') })).rejects.toThrow(
          /offers no session mode "manual"/,
        );
      }
    });

    it('finds the mode among grouped select options', async () => {
      const grouped = select('auto');
      const [option] = grouped.configOptions;
      const opts = option?.options ?? [];
      Object.assign(option ?? {}, { options: [{ group: 'g', name: 'All', options: opts }] });
      const adapter = make(spec('ask'), { FAKE_SESSION: JSON.stringify(grouped) });
      const h = await adapter.start({ cwd: join(root, 'wt') });
      await adapter.close(h);
      expect(methods().map((m) => m.method)).toContain('session/set_config_option');
    });

    it('fails to start when the agent refuses or ignores the switch', async () => {
      for (const [how, session] of [
        ['fail', select('auto')],
        ['fail', { modes }],
        ['ignore', select('auto')],
      ] as const) {
        const adapter = make(spec('ask'), {
          FAKE_SESSION: JSON.stringify(session),
          FAKE_SET: how,
        });
        await expect(adapter.start({ cwd: join(root, 'wt') })).rejects.toThrow(
          how === 'fail' ? /cannot change that now/ : /did not switch to session mode "ask"/,
        );
      }
    });

    it('fails a resume whose answer does not offer the mode', async () => {
      // The fake's `session/load` answers `null`: no modes to set.
      const resumable = spec('ask');
      resumable.capabilities = { ...resumable.capabilities, resume: true };
      const adapter = make(resumable, {
        FAKE_SESSION: JSON.stringify({ modes }),
        FAKE_CAPS: JSON.stringify({ loadSession: true }),
      });
      await expect(
        adapter.start({ cwd: join(root, 'wt'), resume: { vendorSessionId: 'old' } }),
      ).rejects.toThrow(/offers no session mode "ask"/);
    });

    for (const [via, session] of [
      ['config option', select('auto')],
      ['session/set_mode', { modes }],
    ] as const) {
      it(`cancels the turn, then sets the mode back, when the agent leaves it (${via})`, async () => {
        const adapter = make(spec('ask'), { FAKE_SESSION: JSON.stringify(session) });
        const h = await adapter.start({ cwd: join(root, 'wt') });
        const tap = new EventTap(adapter.events(h));
        const isSetter = (m?: string) => /^session\/set_(config_option|mode)$/.test(m ?? '');
        const before = methods().filter((m) => isSetter(m.method)).length;
        await adapter.send(h, { text: 'DRIFT' });
        const end = await tap.waitFor(
          (e) => e.t === 'status' && (e.state === 'idle' || e.state === 'cancelled'),
          5000,
          1,
        );
        expect(end.event).toMatchObject({ state: 'cancelled' });
        await until(() => methods().filter((m) => isSetter(m.method)).length === before + 1);
        const sent = methods();
        const cancelAt = sent.findIndex((m) => m.method === 'session/cancel');
        const setAt = sent.findLastIndex((m) => isSetter(m.method));
        expect(cancelAt).toBeGreaterThan(-1);
        expect(cancelAt).toBeLessThan(setAt);
        expect(JSON.stringify(sent[setAt]?.params)).toContain('"ask"');
        await tap.waitFor(
          (e) =>
            e.t === 'status' &&
            /left session mode "ask" for "auto".*set back/.test(e.message ?? ''),
          5000,
        );
        await adapter.close(h);
      });
    }

    it('ends the session when the mode is not set back', async () => {
      const adapter = make(spec('ask'), {
        FAKE_SESSION: JSON.stringify(select('ask')),
        FAKE_SET: 'ignore',
      });
      const h = await adapter.start({ cwd: join(root, 'wt') });
      const tap = new EventTap(adapter.events(h));
      await adapter.send(h, { text: 'DRIFT' });
      const err = await tap.waitFor((e) => e.t === 'status' && e.state === 'error', 5000);
      expect(err.event).toMatchObject({ message: expect.stringMatching(/did not switch back/) });
      await expect(adapter.send(h, { text: 'more' })).rejects.toThrow();
    });

    it('ends the session when the agent keeps leaving the mode', async () => {
      const adapter = make(spec('ask'), { FAKE_SESSION: JSON.stringify(select('ask')) });
      const h = await adapter.start({ cwd: join(root, 'wt') });
      const tap = new EventTap(adapter.events(h));
      for (let i = 1; i <= 2; i++) {
        await adapter.send(h, { text: 'DRIFT' });
        await until(
          () =>
            tap.events.filter((e) => e.t === 'status' && /set back/.test(e.message ?? ''))
              .length === i,
        );
      }
      await adapter.send(h, { text: 'DRIFT' });
      const err = await tap.waitFor((e) => e.t === 'status' && e.state === 'error', 5000);
      expect(err.event).toMatchObject({ message: expect.stringMatching(/3 times/) });
    });

    it('answers an open permission cancelled when the agent leaves the mode', async () => {
      const adapter = make(spec('ask'), { FAKE_SESSION: JSON.stringify({ modes }) });
      const h = await adapter.start({ cwd: join(root, 'wt') });
      const tap = new EventTap(adapter.events(h));
      await adapter.send(h, { text: 'ASK_DRIFT' });
      await tap.waitFor((e) => e.t === 'approval.request', 5000);
      await until(() =>
        received().some((l) => JSON.stringify(l.received ?? {}).includes('"outcome":"cancelled"')),
      );
      await adapter.close(h);
    });

    it('answers "always" once when the mode is pinned', async () => {
      const adapter = make(spec('ask'), { FAKE_SESSION: JSON.stringify({ modes }) });
      const h = await adapter.start({ cwd: join(root, 'wt') });
      const tap = new EventTap(adapter.events(h));
      await adapter.send(h, { text: 'ASK_ALWAYS' });
      const req = await tap.waitFor((e) => e.t === 'approval.request', 5000);
      if (req.event.t !== 'approval.request') throw new Error('no approval request');
      // Not offered: it would be answered once.
      expect(req.event.options).not.toContain('allow_always');
      await adapter.respond(h, req.event.id, { kind: 'allow_always', persist: true });
      await tap.waitFor((e) => e.t === 'status' && e.state === 'idle', 5000, req.index);
      await adapter.close(h);
      const answer = received().find(
        (l) => l.received !== undefined && JSON.stringify(l.received).includes('"optionId"'),
      );
      expect(JSON.stringify(answer?.received)).toContain('"optionId":"once"');
    });
  });

  it('keeps the error type when a profile is refused at start', async () => {
    const adapter = make(customAcpAgent('plain', { command: ['plain'] }));
    await expect(adapter.start({ cwd: join(root, 'wt'), model: 'm' })).rejects.toThrow(
      ProfileRefusedError,
    );
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
    // Config can declare only what the adapter delivers for any agent.
    const claimed = customAcpAgent('x', {
      command: ['x'],
      capabilities: { resume: true, fork: 'native', liveInput: true } as never,
    });
    expect(claimed.capabilities).toMatchObject({ resume: true, fork: 'none', liveInput: false });
  });

  it('declares for Gemini what its recorded initialize offers', () => {
    const init = JSON.parse(
      readFileSync(
        join(import.meta.dirname, '..', 'test', 'fixtures', 'gemini-0.67.0-acp-initialize.json'),
        'utf8',
      ),
    ) as { agentCapabilities: { loadSession?: boolean; sessionCapabilities?: { fork?: unknown } } };
    // Resume by session/load; no fork offered, none declared.
    expect(GEMINI_AGENT.capabilities.resume).toBe(init.agentCapabilities.loadSession === true);
    expect(init.agentCapabilities.sessionCapabilities?.fork).toBeUndefined();
    expect(GEMINI_AGENT.capabilities.fork).toBe('none');
  });

  it('registers only agents whose API-key-only auth was verified live', () => {
    expect(Object.keys(BUILTIN_ACP_AGENTS)).toEqual(['gemini', 'claude-acp', 'codex-acp']);
    expect(GEMINI_AGENT.apiKeyEnv).toEqual(['GEMINI_API_KEY']);
    // Each has a home of its own, so the user's login is never used or changed (#145).
    for (const spec of Object.values(BUILTIN_ACP_AGENTS)) expect(spec.home).toBeDefined();
    // codex-acp never logs in: its api-key login overwrites the user's Codex login.
    expect(BUILTIN_ACP_AGENTS['codex-acp']?.apiKeyAuthMethods).toEqual([]);
    // Both start in a mode that runs tools unasked; Workers use one that asks (#145).
    expect(BUILTIN_ACP_AGENTS['claude-acp']?.sessionMode).toBe('default');
    expect(BUILTIN_ACP_AGENTS['codex-acp']?.sessionMode).toBe('workspace-write');
    // No subscription or second key route, whatever the user passes through.
    expect(BUILTIN_ACP_AGENTS['claude-acp']?.envDeny).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(BUILTIN_ACP_AGENTS['codex-acp']?.envDeny).toEqual(['CODEX_API_KEY']);
  });
});
