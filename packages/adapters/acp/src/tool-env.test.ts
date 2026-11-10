import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { EventTap } from '@tacet/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AcpAdapter } from './adapter.js';
import { GEMINI_AGENT } from './agents.js';
import { type MockGeminiApi, startMockGeminiApi } from './testing/mock-gemini-api.js';

const require = createRequire(import.meta.url);
const GEMINI = join(
  dirname(require.resolve('@google/gemini-cli/package.json')),
  'bundle/gemini.js',
);
const KEY = 'gm-tool-env-placeholder-0000000000';

/**
 * #150: a shell command a Gemini Worker runs gets neither the API key nor what a `.env` file
 * holds (the checkout's, or `~/.env`). Real Gemini CLI over ACP against the mock Gemini API.
 */
describe('Gemini Worker tool environment', () => {
  let api: MockGeminiApi;
  let root: string;

  beforeAll(async () => {
    api = await startMockGeminiApi();
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tacet-gemini-toolenv-')));
  });
  afterAll(async () => {
    await api?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('keeps the API key and .env files away from tool commands', { timeout: 120_000 }, async () => {
    const home = join(root, 'home');
    const cwd = join(root, 'wt');
    mkdirSync(home);
    mkdirSync(cwd);
    // Gemini loads a `.env` it finds, but only one: so each run below has one of them.
    writeFileSync(join(home, '.env'), 'GOOGLE_CLOUD_LOCATION=from-home-dotenv\n');
    const a = new AcpAdapter({
      agent: GEMINI_AGENT,
      executable: [process.execPath, GEMINI],
      killTimeoutMs: 2000,
      stateDir: join(root, 'state'),
      baseEnv: {
        PATH: process.env.PATH,
        HOME: home,
        GEMINI_API_KEY: KEY,
        GOOGLE_GEMINI_BASE_URL: api.url,
        MYAPP_SETTING: 'kept',
      },
      envPolicy: { pass: ['MYAPP_SETTING'] },
    });
    for (const repoDotenv of [false, true]) {
      if (repoDotenv) writeFileSync(join(cwd, '.env'), 'GOOGLE_CLOUD_PROJECT=from-repo-dotenv\n');
      rmSync(join(cwd, 'tool-env.txt'), { force: true });
      const h = await a.start({ cwd });
      try {
        const tap = new EventTap(a.events(h));
        await a.send(h, { text: 'ENV_TOOL' });
        // The shell tool asks first: allow it, then wait for the turn to end.
        const req = await tap.waitFor((e) => e.t === 'approval.request', 60_000);
        if (req.event.t !== 'approval.request') throw new Error('no approval request');
        await a.respond(h, req.event.id, { kind: 'allow_once', persist: false });
        await tap.waitFor((e) => e.t === 'status' && e.state === 'idle', 60_000, req.index + 1);
      } finally {
        await a.close(h);
      }
      const file = join(cwd, 'tool-env.txt');
      expect(existsSync(file)).toBe(true);
      const out = readFileSync(file, 'utf8');
      expect(out).toContain('MYAPP_SETTING=kept');
      expect(out).not.toContain(KEY);
      expect(out).not.toMatch(/^GEMINI_API_KEY=/m);
      expect(out).not.toContain('from-home-dotenv');
      expect(out).not.toContain('from-repo-dotenv');
    }
    // The user's own Gemini settings are never written: only Tacet's home for the agent.
    expect(existsSync(join(home, '.gemini', 'settings.json'))).toBe(false);
  });
});
