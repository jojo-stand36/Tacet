// Spike for #110 slice 2 (see README.md): what effort reaches the API.
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventTap } from '@tacet/core/testing';
import { it } from 'vitest';
import { CodexAppServerAdapter } from './adapter.js';
import { startMockResponsesApi } from './testing/mock-responses-api.js';
const OUT = process.env.SPIKE_OUT ?? 'spike.out';
const log = (...a: unknown[]) => appendFileSync(OUT, `${a.map(String).join(' ')}\n`);

it('effort', { timeout: 240_000 }, async () => {
  const api = await startMockResponsesApi();
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'spike-')));
  const worktree = join(root, 'wt');
  const home = join(root, 'home');
  mkdirSync(worktree);
  mkdirSync(home);
  const adapter = new CodexAppServerAdapter({
    authRoute: 'api_key',
    apiBaseUrl: api.url,
    mode: 'interactive',
    config: { 'features.plugins': false },
    baseEnv: { PATH: process.env.PATH, HOME: home, CODEX_HOME: join(home, '.codex'), OPENAI_API_KEY: 'placeholder-not-a-real-key' },
  });
  const cases: [string, string | undefined, string | undefined][] = [
    ['gpt-5.5', undefined, undefined],
    ['gpt-5.5', 'ultra', undefined],
    ['gpt-5.5', 'bogus', undefined],
    ['gpt-5.5', undefined, 'ultra'],
    ['gpt-5.5', undefined, 'none'],
    ['gpt-5.5', undefined, 'minimal'],
    ['gpt-6-luna', undefined, 'ultra'],
    ['gpt-mock-1', 'bogus', undefined],
    ['gpt-mock-1', undefined, undefined],
  ];
  let i = 0;
  for (const [model, launch, turnEffort] of cases) {
    const text = `SAY case${++i}`;
    try {
      const h = await adapter.start({ cwd: worktree, model, ...(launch ? { effort: launch } : {}) });
      const tap = new EventTap(adapter.events(h));
      await adapter.send(h, { text }, turnEffort ? { effort: turnEffort } : undefined);
      const end = await tap.waitFor((e) => e.t === 'status' && ['idle', 'error', 'done'].includes(e.state), 60_000, 1);
      const r = api.requests.findLast((x) => x.text === text);
      log(model, launch, turnEffort, '->', JSON.stringify(end.event), 'sent', JSON.stringify(r?.effort), r ? '' : 'NO REQUEST');
      await adapter.close(h);
    } catch (e) {
      log(model, launch, turnEffort, '-> THREW', String(e).slice(0, 300));
    }
  }
  await api.close();
  rmSync(root, { recursive: true, force: true });
});
