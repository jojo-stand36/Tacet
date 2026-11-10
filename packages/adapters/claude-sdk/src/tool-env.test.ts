import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { EventTap } from '@tacet/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeSdkAdapter } from './adapter.js';
import { type MockMessagesApi, startMockMessagesApi } from './testing/mock-messages-api.js';

const KEY = 'sk-ant-tool-env-placeholder-000000000000';
const hasBwrap = (process.env.PATH ?? '').split(delimiter).some((d) => {
  try {
    accessSync(join(d, 'bwrap'), constants.X_OK);
    return true;
  } catch {
    return false;
  }
});

/**
 * #150: the commands a Claude Worker runs (its Bash tool) never see its API key. Real Claude Code
 * against the mock Messages API. Where the scrub can work (macOS; Linux with bubblewrap, as on CI)
 * the Bash tool's environment is checked; on Linux without bubblewrap the Worker must refuse to
 * start (owner decision: fail closed).
 */
describe('Claude Worker tool environment', () => {
  let api: MockMessagesApi;
  let root: string;

  beforeAll(async () => {
    api = await startMockMessagesApi();
    root = mkdtempSync(join(tmpdir(), 'tacet-claude-toolenv-'));
  });
  afterAll(async () => {
    await api?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('keeps the API key away from the Bash tool, or refuses to start', {
    timeout: 120_000,
  }, async () => {
    const home = join(root, 'home');
    const cwd = join(root, 'wt');
    mkdirSync(home);
    mkdirSync(cwd);
    const adapter = new ClaudeSdkAdapter({
      authRoute: 'api_key',
      baseEnv: {
        PATH: process.env.PATH,
        HOME: home,
        CLAUDE_CONFIG_DIR: join(home, '.claude'),
        ANTHROPIC_BASE_URL: api.url,
        ANTHROPIC_API_KEY: KEY,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_AUTOUPDATER: '1',
        MYAPP_SETTING: 'kept',
      },
      envPolicy: { pass: ['MYAPP_SETTING'] },
      mcpConfigDir: join(root, 'run'),
      sdkOptions: { settingSources: [] },
    });
    if (process.platform === 'linux' && !hasBwrap) {
      // CI installs bubblewrap: there, the scrub itself must be what this test checks.
      expect(process.env.CI, 'CI must run this test with bubblewrap').toBeFalsy();
      await expect(adapter.start({ cwd })).rejects.toThrow(/bubblewrap/);
      return;
    }
    const h = await adapter.start({ cwd });
    try {
      const tap = new EventTap(adapter.events(h));
      await adapter.send(h, { text: 'ENV_TOOL' });
      const req = await tap.waitFor(
        (e) => e.t === 'approval.request' || (e.t === 'status' && e.state === 'error'),
        60_000,
      );
      if (req.event.t !== 'approval.request') throw new Error(JSON.stringify(req.event));
      await adapter.respond(h, req.event.id, { kind: 'allow_once', persist: false });
      const end = await tap.waitFor(
        (e) => e.t === 'status' && (e.state === 'idle' || e.state === 'error'),
        60_000,
        req.index + 1,
      );
      expect(end.event).toMatchObject({ state: 'idle' });
    } finally {
      await adapter.close(h);
    }
    const file = join(cwd, 'tool-env.txt');
    // If the command did not run, what the Bash tool reported says why.
    const reported = api.requests.flatMap((r) => (r.toolOutput ? [r.toolOutput] : []));
    expect(existsSync(file), `tool output: ${JSON.stringify(reported)}`).toBe(true);
    const out = readFileSync(file, 'utf8');
    expect(out).toContain('MYAPP_SETTING=kept');
    expect(out).not.toContain(KEY);
    expect(out).not.toMatch(/^ANTHROPIC_API_KEY=/m);
  });
});
