// Spike for #175 (see README.md): what a thread/fork runs on, with and without model and effort.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { it } from 'vitest';
import { codexLaunch } from './auth.js';
import { JsonRpcPeer } from './jsonrpc.js';
import { startMockResponsesApi } from './testing/mock-responses-api.js';

const OUT = process.env.SPIKE_OUT ?? 'spike.out';
const log = (...a: unknown[]) => appendFileSync(OUT, `${a.map(String).join(' ')}\n`);
type Obj = Record<string, any>;
const pick = (x: Obj | undefined) =>
  JSON.stringify({ model: x?.model, reasoningEffort: x?.reasoningEffort });

it('fork model and effort', { timeout: 120_000 }, async () => {
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
  const open = async () => {
    const proc = spawn(
      process.execPath,
      [join(pkg, 'bin', 'codex.js'), 'app-server', '-c', 'features.plugins=false', ...launch.args],
      { cwd: root, env: launch.env, stdio: ['pipe', 'pipe', 'ignore'] },
    );
    const done = new Map<string, () => void>();
    const rpc = new JsonRpcPeer(proc.stdout!, proc.stdin!, {
      onRequest: () => Promise.reject(new Error('no')),
      onNotification: (method, params) => {
        if (method === 'turn/completed') done.get((params as Obj).threadId)?.();
      },
    });
    await rpc.request('initialize', {
      clientInfo: { name: 'spike', title: 'spike', version: '0' },
      capabilities: null,
    });
    rpc.notify('initialized');
    const turn = async (threadId: string, text: string, extra: Obj = {}) => {
      const finished = new Promise<void>((r) => done.set(threadId, r));
      await rpc.request('turn/start', {
        threadId,
        input: [{ type: 'text', text, text_elements: [] }],
        ...extra,
      });
      await Promise.race([finished, new Promise((r) => setTimeout(r, 15_000))]);
    };
    return { proc, rpc, turn };
  };
  const last = () => {
    const r = api.requests.at(-1);
    return JSON.stringify({ model: r?.model, effort: r?.effort });
  };

  // Source: a thread on gpt-5.5 whose turn ran at low.
  const a = await open();
  const src = await a.rpc.request<Obj>('thread/start', { cwd: root, model: 'gpt-5.5' });
  const id = src.thread.id as string;
  await a.turn(id, 'SAY a', { effort: 'low' });
  log('SOURCE turn sent', last());
  a.proc.kill();
  await new Promise((r) => setTimeout(r, 500));

  // A fresh process, as a Worker restart would be.
  const b = await open();
  const read = await b.rpc
    .request<Obj>('thread/read', { threadId: id })
    .catch((e) => ({ err: String(e) }) as Obj);
  log('READ', pick(read.thread), read.err ?? '');

  const plain = await b.rpc.request<Obj>('thread/fork', { threadId: id, cwd: root });
  log('FORK plain response', pick(plain), 'thread:', pick(plain.thread));
  await b.turn(plain.thread.id, 'SAY b');
  log('FORK plain turn sent', last());

  const withModel = await b.rpc.request<Obj>('thread/fork', {
    threadId: id,
    cwd: root,
    model: 'gpt-5.5',
    config: { model_reasoning_effort: 'low' },
  });
  log('FORK model+config effort response', pick(withModel), 'thread:', pick(withModel.thread));
  await b.turn(withModel.thread.id, 'SAY c');
  log('FORK model+config effort turn sent', last());

  const other = await b.rpc.request<Obj>('thread/fork', {
    threadId: id,
    cwd: root,
    model: 'gpt-6-luna',
    config: { model_reasoning_effort: 'high' },
  });
  log('FORK other model+effort response', pick(other));
  await b.turn(other.thread.id, 'SAY d');
  log('FORK other model+effort turn sent', last());

  const resumed = await b.rpc.request<Obj>('thread/resume', { threadId: id, cwd: root });
  log('RESUME response', pick(resumed));

  b.proc.kill();
  await api.close();
  rmSync(root, { recursive: true, force: true });
});
