// #171: interactive Codex's managed daemon outlives the PTY session and keeps the session's
// TACET_WORKER_MARKER, so the crash sweep (#127) ends it; with daemon_auto_start=false there is none.
//   node codex-daemon-marker.mjs "$PWD" <absolute path to the codex binary>
// Builds needed: packages/core, packages/adapters/pty, packages/adapters/acp, packages/adapters/codex-app-server.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [repo, codex] = process.argv.slice(2);
const { startMockResponsesApi } = await import(`${repo}/packages/adapters/codex-app-server/dist/testing/mock-responses-api.js`);
const { codexAcpConfig } = await import(`${repo}/packages/adapters/acp/dist/agents.js`);
const { PtyCliAdapter } = await import(`${repo}/packages/adapters/pty/dist/index.js`);
const { newWorkerMarker, markedProcesses, endMarkedProcesses, WORKER_MARKER_VAR } = await import(`${repo}/packages/core/dist/node/index.js`);

const root = mkdtempSync(join(tmpdir(), 's171-'));
const home = join(root, 'codexhome');
const daemons = () => {
  try {
    return execFileSync('ps', ['-eo', 'pid=,args=']).toString().split('\n').filter((l) => l.includes(home) && l.includes('app-server'));
  } catch {
    return [];
  }
};
let api;
let adapter;
let open;
let ok = true;
try {
  api = await startMockResponsesApi();
  mkdirSync(home);
  const cwd = join(root, 'wt');
  mkdirSync(cwd);
  writeFileSync(join(home, 'config.toml'), `${codexAcpConfig(`${api.url}/v1`)}\n[projects."${cwd}"]\ntrust_level = "trusted"\n`);
  for (const off of [false, true]) {
    adapter = new PtyCliAdapter({
      slug: 'codex',
      preset: { command: off ? [codex, '-c', 'features.daemon_auto_start=false'] : [codex] },
      baseEnv: { PATH: process.env.PATH, HOME: root, CODEX_HOME: home, OPENAI_API_KEY: 'sk-test-0000000000000000' },
      envPolicy: { pass: ['CODEX_HOME', 'OPENAI_API_KEY'] },
      quietMs: 2500,
      startTimeoutMs: 30000,
      killTimeoutMs: 3000,
    });
    const marker = newWorkerMarker();
    const n = api.requests.length;
    const h = await adapter.start({ cwd, env: { [WORKER_MARKER_VAR]: marker } });
    open = h;
    (async () => {
      for await (const _ of adapter.events(h));
    })().catch(() => {});
    await new Promise((r) => setTimeout(r, 3000));
    await adapter.send(h, { text: 'SAY alpha' });
    const t0 = Date.now();
    while (api.requests.length === n && Date.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 300));
    await new Promise((r) => setTimeout(r, 3000));
    await adapter.close(h);
    open = undefined;
    await new Promise((r) => setTimeout(r, 1000));
    const marked = markedProcesses([marker]).get(marker) ?? [];
    const left = daemons().length;
    console.log(`${off ? 'daemon_auto_start=false' : 'default'}: after close, app-server processes ${left}, carrying the marker ${marked.length}`);
    // Expected: by default the daemon outlives the session and carries its marker; with the flag there is none.
    if (off ? left !== 0 : left === 0 || marked.length !== left) ok = false;
    if (!off) {
      const r = await endMarkedProcesses([marker]);
      console.log(`  crash sweep: found ${r.found.length}, left ${r.left.length}; app-server processes now ${daemons().length}`);
      if (r.left.length > 0 || daemons().length > 0) ok = false;
    }
  }
} finally {
  if (open) await adapter?.close(open).catch(() => {});
  for (const l of daemons()) {
    try {
      process.kill(Number(l.trim().split(' ')[0]), 'SIGKILL');
    } catch {}
  }
  await api?.close();
  await new Promise((r) => setTimeout(r, 500));
  rmSync(root, { recursive: true, force: true });
}
console.log(ok ? 'as expected' : 'UNEXPECTED');
process.exit(ok ? 0 : 1);
