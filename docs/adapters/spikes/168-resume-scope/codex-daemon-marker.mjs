// Run as the other scripts here: node codex-daemon-marker.mjs "$PWD" <codex binary>, after building core, pty, acp and codex-app-server.
// #171: does Codex's managed daemon inherit TACET_WORKER_MARKER, and does the marker sweep end it?
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const [repo, codex] = process.argv.slice(2);
const { startMockResponsesApi } = await import(`${repo}/packages/adapters/codex-app-server/dist/testing/mock-responses-api.js`);
const { codexAcpConfig } = await import(`${repo}/packages/adapters/acp/dist/agents.js`);
const { PtyCliAdapter } = await import(`${repo}/packages/adapters/pty/dist/index.js`);
const { newWorkerMarker, markedProcesses, endMarkedProcesses, WORKER_MARKER_VAR } = await import(`${repo}/packages/core/dist/node/index.js`);
const api = await startMockResponsesApi();
const root = mkdtempSync(join(tmpdir(), 's171-'));
const home = join(root, 'codexhome'); mkdirSync(home);
const cwd = join(root, 'wt'); mkdirSync(cwd);
writeFileSync(join(home, 'config.toml'), codexAcpConfig(`${api.url}/v1`) + `\n[projects."${cwd}"]\ntrust_level = "trusted"\n`);
const adapter = new PtyCliAdapter({
  slug: 'codex', preset: { command: [codex] },
  baseEnv: { PATH: process.env.PATH, HOME: root, CODEX_HOME: home, OPENAI_API_KEY: 'sk-test-0000000000000000' },
  envPolicy: { pass: ['CODEX_HOME', 'OPENAI_API_KEY'] }, quietMs: 2500, startTimeoutMs: 30000, killTimeoutMs: 3000,
});
const marker = newWorkerMarker();
const h = await adapter.start({ cwd, env: { [WORKER_MARKER_VAR]: marker } });
(async () => { for await (const _ of adapter.events(h)); })();
await new Promise((r) => setTimeout(r, 3000));
await adapter.send(h, { text: 'SAY alpha' });
const t0 = Date.now();
while (api.requests.length === 0 && Date.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 300));
await new Promise((r) => setTimeout(r, 3000));
await adapter.close(h);
await new Promise((r) => setTimeout(r, 1000));
const marked = markedProcesses([marker]).get(marker) ?? [];
const all = (await import('node:child_process')).execFileSync('ps', ['-eo', 'pid=,args=']).toString().split('\n').filter((l) => l.includes(home) && l.includes('app-server'));
console.log(`after close: app-server processes ${all.length}; carrying the marker ${marked.length}`);
const r = await endMarkedProcesses([marker]);
const after = (await import('node:child_process')).execFileSync('ps', ['-eo', 'pid=,args=']).toString().split('\n').filter((l) => l.includes(home) && l.includes('app-server'));
console.log(`endMarkedProcesses: found ${r.found.length}, left ${r.left.length}; app-server processes now ${after.length}`);
for (const l of after) process.kill(Number(l.trim().split(' ')[0]));
await api.close(); rmSync(root, { recursive: true, force: true }); process.exit(0);
