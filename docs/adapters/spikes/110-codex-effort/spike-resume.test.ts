// Spike for #110 slice 2 (see README.md): reasoningEffort on thread start, resume and fork.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';

const OUT =
  process.env.SPIKE_OUT ?? 'spike.out';
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
    {
      PATH: process.env.PATH,
      HOME: home,
      CODEX_HOME: join(home, '.codex'),
      OPENAI_API_KEY: 'placeholder-not-a-real-key',
    },
    { baseUrl: api.url },
  );
  const pkg = dirname(createRequire(import.meta.url).resolve('@openai/codex/package.json'));
  const proc = spawn(
    process.execPath,
    [join(pkg, 'bin', 'codex.js'), 'app-server', '-c', 'features.plugins=false', ...launch.args],
    {
      cwd: root,
      env: launch.env,
      stdio: ['pipe', 'pipe', 'ignore'],
    },
  );
  const rpc = new JsonRpcPeer(proc.stdout!, proc.stdin!, {
    onRequest: () => Promise.reject(new Error('no')),
    onNotification: () => {},
  });
  await rpc.request('initialize', {
    clientInfo: { name: 'spike', title: 'spike', version: '0' },
    capabilities: null,
  });
  rpc.notify('initialized');
  const re = (x: unknown) =>
    JSON.stringify({
      model: (x as Record<string, unknown>).model,
      reasoningEffort: (x as Record<string, unknown>).reasoningEffort,
    });
  const t1 = await rpc.request<Record<string, any>>('thread/start', {
    cwd: root,
    model: 'gpt-5.5',
  });
  log('START no effort', re(t1));
  const t2 = await rpc.request<Record<string, any>>('thread/start', {
    cwd: root,
    model: 'gpt-5.5',
    config: { model_reasoning_effort: 'high' },
  });
  log('START config high', re(t2));
  const t3 = await rpc.request<Record<string, any>>('thread/start', { cwd: root });
  log('START no model', re(t3));
  const id = t1.thread.id as string;
  await rpc.request('turn/start', {
    threadId: id,
    input: [{ type: 'text', text: 'SAY a', text_elements: [] }],
    effort: 'low',
  });
  await new Promise((r) => setTimeout(r, 3000));
  proc.kill();
  await new Promise((r) => setTimeout(r, 500));
  const proc2 = spawn(
    process.execPath,
    [join(pkg, 'bin', 'codex.js'), 'app-server', '-c', 'features.plugins=false', ...launch.args],
    { cwd: root, env: launch.env, stdio: ['pipe', 'pipe', 'ignore'] },
  );
  const rpc2 = new JsonRpcPeer(proc2.stdout!, proc2.stdin!, {
    onRequest: () => Promise.reject(new Error('no')),
    onNotification: () => {},
  });
  await rpc2.request('initialize', {
    clientInfo: { name: 'spike', title: 'spike', version: '0' },
    capabilities: null,
  });
  rpc2.notify('initialized');
  const r1 = await rpc2
    .request<Record<string, any>>('thread/resume', { threadId: id, cwd: root })
    .catch((e) => ({ err: String(e) }));
  log('RESUME after low turn', re(r1), JSON.stringify(r1).slice(0, 120));
  const r2 = await rpc2
    .request<Record<string, any>>('thread/fork', { threadId: id, cwd: root })
    .catch((e) => ({ err: String(e) }));
  log('FORK after low turn', re(r2));
  proc2.kill();
  proc.kill();
  await api.close();
  rmSync(root, { recursive: true, force: true });
});
