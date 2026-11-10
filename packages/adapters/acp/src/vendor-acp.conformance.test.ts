import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { startMockMessagesApi } from '@tacet/adapter-claude-sdk/testing';
import { startMockResponsesApi } from '@tacet/adapter-codex-app-server/testing';
import { assertConformance, EventTap, formatResults, runConformance } from '@tacet/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AcpAdapter } from './adapter.js';
import { type AcpAgentSpec, CLAUDE_ACP_AGENT, CODEX_ACP_AGENT, codexAcpConfig } from './agents.js';

const require = createRequire(import.meta.url);
const bin = (pkg: string) => join(dirname(require.resolve(`${pkg}/package.json`)), 'dist/index.js');

/** Every file under `dir`, by path, with a hash of its content. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[relative(dir, p)] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

interface Case {
  name: string;
  /** A login of the user's own, as the vendor stores it, which a Worker must never use or change. */
  login: (home: string) => void;
  start: (credentials: Record<string, string>) => Promise<{
    url: string;
    requests: { credential: string }[];
    close(): Promise<void>;
  }>;
  agent: (apiUrl: string) => AcpAgentSpec;
  bin: string;
  env: (apiUrl: string) => Record<string, string>;
  key: string;
  login_token: string;
  /** A prompt whose tool call the agent, in its production session mode, asks about. */
  approvalPrompt: string;
}

const CASES: Case[] = [
  {
    name: 'claude-agent-acp',
    bin: bin('@agentclientprotocol/claude-agent-acp'),
    key: 'sk-ant-api03-tacet-test-key-00000000000000000000',
    approvalPrompt: 'RUN_TOOL',
    login_token: 'sk-ant-oat01-tacet-test-subscription-0000000000000',
    // Where Claude Code keeps a subscription login (`claudeAiOauth` in `.credentials.json`, read
    // from the 2.1.318 binary).
    login(home) {
      mkdirSync(join(home, '.claude'), { recursive: true });
      writeFileSync(
        join(home, '.claude', '.credentials.json'),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: this.login_token,
            refreshToken: 'sk-ant-ort01-tacet-test',
            expiresAt: Date.now() + 86_400_000,
            scopes: ['user:inference'],
            subscriptionType: 'max',
          },
        }),
        { mode: 0o600 },
      );
      writeFileSync(join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }));
    },
    start: (credentials) => startMockMessagesApi({ credentials }),
    agent: () => CLAUDE_ACP_AGENT,
    env(url) {
      return {
        ANTHROPIC_API_KEY: this.key,
        ANTHROPIC_BASE_URL: url,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_AUTOUPDATER: '1',
      };
    },
  },
  {
    name: 'codex-acp',
    // Every codex-acp mode but full access is `on-request`: Codex asks before a command leaves the
    // sandbox, and runs the rest in it unasked (as the native adapter's default).
    approvalPrompt: 'RUN_ESCALATED',
    bin: bin('@agentclientprotocol/codex-acp'),
    key: 'sk-proj-tacet-test-key-0000000000000000000000',
    login_token: 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0In0.chatgpt-test-access',
    // A ChatGPT login in `~/.codex/auth.json`, and a config that would send it to the mock.
    login(home) {
      mkdirSync(join(home, '.codex'), { recursive: true });
      writeFileSync(
        join(home, '.codex', 'auth.json'),
        JSON.stringify({
          OPENAI_API_KEY: null,
          tokens: {
            id_token: this.login_token,
            access_token: this.login_token,
            refresh_token: 'rt',
            account_id: 'a',
          },
        }),
        { mode: 0o600 },
      );
    },
    start: (credentials) => startMockResponsesApi({ credentials }),
    // The production config, with the mock's base URL.
    agent: (url) => ({
      ...CODEX_ACP_AGENT,
      home: { env: 'CODEX_HOME', files: { 'config.toml': codexAcpConfig(`${url}/v1`) } },
    }),
    env() {
      return { OPENAI_API_KEY: this.key };
    },
  },
];

for (const c of CASES) {
  describe(`${c.name} over ACP (#145; mock API)`, () => {
    let api: Awaited<ReturnType<Case['start']>>;
    let root: string;
    let home: string;
    let state: string;
    let adapter: AcpAdapter;
    let before: Record<string, string>;

    beforeAll(async () => {
      api = await c.start({ apiKey: c.key, login: c.login_token });
      root = realpathSync(mkdtempSync(join(tmpdir(), `tacet-${c.name}-`)));
      home = join(root, 'home');
      state = join(root, 'state');
      mkdirSync(home);
      c.login(home);
      before = snapshot(home);
      adapter = new AcpAdapter({
        agent: c.agent(api.url),
        executable: [process.execPath, c.bin],
        killTimeoutMs: 2000,
        stateDir: state,
        baseEnv: { PATH: process.env.PATH, HOME: home, ...c.env(api.url) },
      });
    });
    afterAll(async () => {
      await api?.close();
      if (root) rmSync(root, { recursive: true, force: true });
    });

    it('passes the P0 probes', { timeout: 240_000 }, async () => {
      const cwd = join(root, 'wt');
      mkdirSync(cwd, { recursive: true });
      const results = await runConformance(adapter, {
        session: { cwd },
        replyPrompt: 'SAY hello',
        approvalPrompt: c.approvalPrompt,
        slowPrompt: 'SLOW',
        timeoutMs: 60_000,
      });
      console.log(formatResults(results));
      assertConformance(results);
    });

    it("uses the API key only, and never uses or changes the user's login", {
      timeout: 120_000,
    }, async () => {
      const cwd = join(root, 'wt2');
      mkdirSync(cwd, { recursive: true });
      const h = await adapter.start({ cwd });
      const tap = new EventTap(adapter.events(h));
      await adapter.send(h, { text: 'SAY hi' });
      await tap.waitFor((e) => e.t === 'status' && e.state === 'idle', 60_000, 1);
      await adapter.close(h);
      expect(api.requests.length).toBeGreaterThan(0);
      expect(new Set(api.requests.map((r) => r.credential))).toEqual(new Set(['apiKey']));
      // The user's home, login included, is exactly as it was.
      expect(snapshot(home)).toEqual(before);
      // The agent's own home holds no stored credential.
      const own = Object.keys(snapshot(state));
      expect(own.filter((p) => /(^|\/)(auth\.json|\.credentials\.json)$/.test(p))).toEqual([]);
      expect(own.some((p) => p.includes('/.tmp/plugins/'))).toBe(false);
    });

    it.runIf(c.name === 'codex-acp')(
      'keeps the key from the commands it runs (#150)',
      { timeout: 120_000 },
      async () => {
        const cwd = join(root, 'wt3');
        mkdirSync(cwd, { recursive: true });
        const h = await adapter.start({ cwd });
        const tap = new EventTap(adapter.events(h));
        await adapter.send(h, { text: 'RUN_CMD env > tool-env.txt' });
        await tap.waitFor((e) => e.t === 'status' && e.state === 'idle', 60_000, 1);
        await adapter.close(h);
        const env = readFileSync(join(cwd, 'tool-env.txt'), 'utf8');
        expect(env).toMatch(/^PATH=/m);
        expect(env).not.toMatch(/^(OPENAI|CODEX)_API_KEY=/m);
        expect(env).not.toContain(c.key);
      },
    );
  });
}
