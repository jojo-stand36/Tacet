import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventTap } from '@tacet/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CodexAppServerAdapter } from './adapter.js';
import { type MockResponsesApi, startMockResponsesApi } from './testing/mock-responses-api.js';

const KEY = 'sk-tool-env-placeholder-0000000000';

/**
 * #150: the commands a Codex Worker runs (its shell tool) get the Worker's environment without
 * the API key. Real `codex app-server` against the mock Responses API, which records what the
 * shell tool returned.
 */
describe('Codex Worker tool environment', () => {
  let api: MockResponsesApi;
  let root: string;

  beforeAll(async () => {
    api = await startMockResponsesApi();
    // Outside the temp dirs, as in the isolation test (the sandbox makes those writable).
    const cache = fileURLToPath(new URL('../node_modules/.cache/', import.meta.url));
    mkdirSync(cache, { recursive: true });
    root = realpathSync(mkdtempSync(join(cache, 'tacet-codex-toolenv-')));
  });
  afterAll(async () => {
    await api?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('gives tool commands the Worker environment without the API key', {
    timeout: 120_000,
  }, async () => {
    const home = join(root, 'home');
    const cwd = join(root, 'cwd');
    mkdirSync(home);
    mkdirSync(cwd);
    const a = new CodexAppServerAdapter({
      authRoute: 'api_key',
      apiBaseUrl: api.url,
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      baseEnv: { PATH: process.env.PATH, HOME: home, OPENAI_API_KEY: KEY, MYAPP_SETTING: 'kept' },
      envPolicy: { pass: ['MYAPP_SETTING'] },
    });
    // A new thread, then the same thread resumed: both get the policy (#150).
    let resume: string | undefined;
    for (const round of ['start', 'resume']) {
      const h = await a.start({ cwd, ...(resume ? { resume: { vendorSessionId: resume } } : {}) });
      try {
        const tap = new EventTap(a.events(h));
        await tap.waitFor((e) => e.t === 'status' && e.state === 'idle', 30_000);
        const from = api.requests.length;
        await a.send(h, { text: 'RUN_CMD env' });
        const end = await tap.waitFor(
          (e) => e.t === 'status' && (e.state === 'idle' || e.state === 'error'),
          60_000,
          2,
        );
        expect(end.event, round).toMatchObject({ state: 'idle' });
        const out = api.requests.slice(from).find((r) => r.toolOutput)?.toolOutput ?? '';
        expect(out, round).toContain('MYAPP_SETTING=kept');
        expect(out, round).not.toContain(KEY);
        expect(out, round).not.toMatch(/^(OPENAI|CODEX)_API_KEY=/m);
        resume = h.vendorSessionId;
      } finally {
        await a.close(h);
      }
    }
  });
});
