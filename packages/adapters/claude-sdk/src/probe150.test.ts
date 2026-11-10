import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventTap } from '@tacet/core/testing';
import { it } from 'vitest';
import { ClaudeSdkAdapter } from './adapter.js';
import { startMockMessagesApi } from './testing/mock-messages-api.js';

for (const scrub of [undefined, '1']) {
  it(`probe scrub=${scrub}`, { timeout: 120_000 }, async () => {
    const api = await startMockMessagesApi();
    const root = mkdtempSync(join(tmpdir(), 'probe150-'));
    const wt = join(root, 'wt');
    mkdirSync(wt);
    const home = join(root, 'home');
    mkdirSync(home);
    const adapter = new ClaudeSdkAdapter({
      authRoute: 'api_key',
      baseEnv: {
        PATH: process.env.PATH,
        HOME: home,
        CLAUDE_CONFIG_DIR: join(home, '.claude'),
        ANTHROPIC_BASE_URL: api.url,
        ANTHROPIC_API_KEY: 'sk-ant-probe-placeholder-key-0000000000',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_AUTOUPDATER: '1',
        ...(scrub ? { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: scrub } : {}),
      },
      mcpConfigDir: join(root, 'run'),
      sdkOptions: { settingSources: [] },
    });
    const h = await adapter.start({ cwd: wt });
    const tap = new EventTap(adapter.events(h));
    await adapter.send(h, { text: 'ENV_TOOL' });
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const req = tap.events.find((e) => e.t === 'approval.request');
      if (req && req.t === 'approval.request') {
        await adapter.respond(h, req.id, { kind: 'allow_once', persist: false });
        break;
      }
      const end = tap.events.find(
        (e) => e.t === 'status' && e.state !== 'running' && e.state !== 'idle',
      );
      if (end) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await tap.waitFor(
      (e) => e.t === 'status' && (e.state === 'idle' || e.state === 'error'),
      60_000,
      2,
    );
    const f = join(wt, 'tool-env.txt');
    const out = existsSync(f) ? readFileSync(f, 'utf8') : '(no file)';
    const names = out
      .split('\n')
      .map((l) => l.split('=')[0])
      .filter(Boolean)
      .sort();
    appendFileSync(
      '/tmp/claude-0/-home-user-Tacet/7fe4e068-3684-5c8a-baba-a57946c496d2/scratchpad/probe150/claude.txt',
      '\n' + `SCRUB=${scrub} names: ${names.join(',')}`,
    );
    appendFileSync(
      '/tmp/claude-0/-home-user-Tacet/7fe4e068-3684-5c8a-baba-a57946c496d2/scratchpad/probe150/claude.txt',
      '\n' + `SCRUB=${scrub} key present: ${out.includes('sk-ant-probe')}`,
    );
    appendFileSync(
      '/tmp/claude-0/-home-user-Tacet/7fe4e068-3684-5c8a-baba-a57946c496d2/scratchpad/probe150/claude.txt',
      '\n' +
        `SCRUB=${scrub} events: ${JSON.stringify(tap.events.filter((e) => e.t !== 'message.delta')).slice(0, 1500)}`,
    );
    await adapter.close(h);
    await api.close();
    rmSync(root, { recursive: true, force: true });
  });
}
