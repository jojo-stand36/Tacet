// Spike for #110 slice 2 (see README.md): what model/list returns offline.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
const OUT = process.env.SPIKE_OUT ?? 'spike.out';
const log = (...a: unknown[]) => appendFileSync(OUT, a.map(String).join(' ') + '\n');
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { it } from 'vitest';
import { codexLaunch } from './auth.js';
import { JsonRpcPeer } from './jsonrpc.js';
import { startMockResponsesApi } from './testing/mock-responses-api.js';

it('model/list', { timeout: 60_000 }, async () => {
  const api = await startMockResponsesApi();
  const root = mkdtempSync(join(tmpdir(), 'spike-'));
  const home = join(root, 'home');
  mkdirSync(join(home, '.codex'), { recursive: true });
  const launch = codexLaunch(
    'api_key',
    { PATH: process.env.PATH, HOME: home, CODEX_HOME: join(home, '.codex'), OPENAI_API_KEY: 'placeholder-not-a-real-key' },
    { baseUrl: api.url },
  );
  const pkg = dirname(createRequire(import.meta.url).resolve('@openai/codex/package.json'));
  const proc = spawn(process.execPath, [join(pkg, 'bin', 'codex.js'), 'app-server', '-c', 'features.plugins=false', ...launch.args], {
    cwd: root, env: launch.env, stdio: ['pipe', 'pipe', 'ignore'],
  });
  const rpc = new JsonRpcPeer(proc.stdout!, proc.stdin!, {
    onRequest: () => Promise.reject(new Error('no')),
    onNotification: () => {},
  });
  await rpc.request('initialize', { clientInfo: { name: 'spike', title: 'spike', version: '0' }, capabilities: null });
  rpc.notify('initialized');
  const r = await rpc.request<{ data: { id: string; model: string; hidden: boolean; isDefault: boolean; defaultReasoningEffort: string; supportedReasoningEfforts: { reasoningEffort: string }[] }[] }>('model/list', { includeHidden: true });
  for (const m of r.data) log('MODEL', m.id, m.model, m.hidden, m.isDefault, m.defaultReasoningEffort, JSON.stringify(m.supportedReasoningEfforts.map((e) => e.reasoningEffort)));
  log('KEYS', JSON.stringify(Object.keys(r)));
  const t = await rpc.request<Record<string, unknown>>('thread/start', { cwd: root, model: 'gpt-5.1-codex-mini', config: { model_reasoning_effort: 'bogus-level' } }).catch((e) => ({ err: String(e) }));
  log('BOGUS', JSON.stringify(t).slice(0, 400));
  proc.kill();
  await api.close();
  rmSync(root, { recursive: true, force: true });
});
