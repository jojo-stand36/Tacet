import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { EventTap } from '@tacet/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeSdkAdapter } from './adapter.js';
import { type MockMessagesApi, startMockMessagesApi } from './testing/mock-messages-api.js';

const onPath = (name: string) =>
  (process.env.PATH ?? '').split(delimiter).some((d) => {
    try {
      accessSync(join(d, name), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
const sandbox = process.platform === 'darwin' || (onPath('bwrap') && onPath('socat'));

/**
 * #150: what Claude Code's sandbox (on with the scrub) does to a Worker's checkout. Real Claude
 * Code against the mock Messages API; runs where the sandbox can run (macOS; Linux with bubblewrap
 * and socat, as on CI). Records what a command sees and may write, and what is left afterwards.
 */
describe.runIf(sandbox || Boolean(process.env.CI))('Claude sandbox and the Worker checkout', () => {
  let api: MockMessagesApi;
  let root: string;
  beforeAll(async () => {
    api = await startMockMessagesApi();
    root = mkdtempSync(join(tmpdir(), 'tacet-claude-sandbox-'));
  });
  afterAll(async () => {
    await api?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('keeps existing files, and reports what it adds', { timeout: 120_000 }, async () => {
    const home = join(root, 'home');
    const cwd = join(root, 'wt');
    mkdirSync(home);
    mkdirSync(cwd);
    writeFileSync(join(cwd, '.env'), 'EXISTING=1\n');
    writeFileSync(join(cwd, 'package.json'), '{"name":"x"}\n');
    writeFileSync(join(cwd, 'src.txt'), 'source\n');
    const adapter = new ClaudeSdkAdapter({
      authRoute: 'api_key',
      baseEnv: {
        PATH: process.env.PATH,
        HOME: home,
        CLAUDE_CONFIG_DIR: join(home, '.claude'),
        ANTHROPIC_BASE_URL: api.url,
        ANTHROPIC_API_KEY: 'sk-ant-sandbox-placeholder-0000000000000',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_AUTOUPDATER: '1',
      },
      mcpConfigDir: join(root, 'run'),
      sdkOptions: { settingSources: [] },
    });
    const probe = [
      'cat .env package.json',
      'echo appended >> package.json; echo "append package.json: $?"',
      'echo NEW=1 > .npmrc; echo "write .npmrc: $?"',
      'mkdir -p node_modules/x && echo ok > node_modules/x/f; echo "write node_modules: $?"',
      'echo more >> src.txt; echo "append src.txt: $?"',
      'ls -la',
    ].join('; ');
    const h = await adapter.start({ cwd });
    let seen = '';
    try {
      const tap = new EventTap(adapter.events(h));
      const from = api.requests.length;
      await adapter.send(h, { text: `RUN_CMD ${probe}` });
      const req = await tap.waitFor((e) => e.t === 'approval.request', 60_000);
      if (req.event.t !== 'approval.request') throw new Error('no approval');
      await adapter.respond(h, req.event.id, { kind: 'allow_once', persist: false });
      await tap.waitFor((e) => e.t === 'status' && e.state === 'idle', 60_000, req.index + 1);
      seen = api.requests.slice(from).find((r) => r.toolOutput)?.toolOutput ?? '(no output)';
    } finally {
      await adapter.close(h);
    }
    const after = readdirSync(cwd)
      .sort()
      .map((n) => {
        const st = lstatSync(join(cwd, n));
        const kind = st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
        return `${n} ${kind} ${st.isFile() ? st.size : ''}`.trim();
      });
    console.log(
      `#150 sandbox on ${process.platform}\n--- the command saw:\n${seen}\n--- left in the checkout:\n${after.join('\n')}\n--- .env: ${JSON.stringify(readFileSync(join(cwd, '.env'), 'utf8'))}\n--- package.json: ${JSON.stringify(readFileSync(join(cwd, 'package.json'), 'utf8'))}`,
    );
    // Existing files are never replaced by the sandbox.
    expect(readFileSync(join(cwd, '.env'), 'utf8')).toBe('EXISTING=1\n');
    expect(readFileSync(join(cwd, 'package.json'), 'utf8')).toMatch(/^\{"name":"x"\}\n/);
  });
});
