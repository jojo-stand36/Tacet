// #171: interactive Codex's managed daemon is shared by every session with the same CODEX_HOME.
// Session B connects to the daemon session A started (A's marker). Ending A's marked processes
// at A's clean close cuts B off; without that sweep, B keeps working.
//   node codex-shared-daemon.mjs "$PWD" <absolute path to the codex binary>          (sweeps A)
//   NOSWEEP=1 node codex-shared-daemon.mjs "$PWD" <absolute path to the codex binary> (control)
// Builds needed: packages/core, packages/adapters/pty, packages/adapters/acp, packages/adapters/codex-app-server.
// Exits 1 when the outcome is not the expected one (sweep: B cut off; control: B answered).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [repo, codex] = process.argv.slice(2);
const { startMockResponsesApi } = await import(`${repo}/packages/adapters/codex-app-server/dist/testing/mock-responses-api.js`);
const { codexAcpConfig } = await import(`${repo}/packages/adapters/acp/dist/agents.js`);
const { PtyCliAdapter } = await import(`${repo}/packages/adapters/pty/dist/index.js`);
const { newWorkerMarker, markedProcesses, endMarkedProcesses, WORKER_MARKER_VAR } = await import(`${repo}/packages/core/dist/node/index.js`);

const sweep = !process.env.NOSWEEP;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = mkdtempSync(join(tmpdir(), 's171sh-'));
const home = join(root, 'codexhome');
const daemons = () => {
  try {
    return execFileSync('ps', ['-eo', 'pid=,args=']).toString().split('\n').filter((l) => l.includes(home) && l.includes('app-server'));
  } catch {
    return [];
  }
};
const marks = (m) => (markedProcesses([m]).get(m) ?? []).length;
let api;
let adapter;
const open = [];
let ok = false;
try {
  api = await startMockResponsesApi();
  mkdirSync(home);
  const a = join(root, 'a');
  const b = join(root, 'b');
  mkdirSync(a);
  mkdirSync(b);
  writeFileSync(join(home, 'config.toml'), `${codexAcpConfig(`${api.url}/v1`)}\n[projects."${a}"]\ntrust_level = "trusted"\n[projects."${b}"]\ntrust_level = "trusted"\n`);
  adapter = new PtyCliAdapter({
    slug: 'codex',
    preset: { command: [codex] },
    baseEnv: { PATH: process.env.PATH, HOME: root, CODEX_HOME: home, OPENAI_API_KEY: 'sk-test-0000000000000000' },
    envPolicy: { pass: ['CODEX_HOME', 'OPENAI_API_KEY'] },
    quietMs: 2500,
    startTimeoutMs: 30000,
    killTimeoutMs: 3000,
  });
  const session = async (cwd, marker, text) => {
    const h = await adapter.start({ cwd, env: { [WORKER_MARKER_VAR]: marker } });
    open.push(h);
    (async () => {
      for await (const _ of adapter.events(h));
    })().catch(() => {});
    await sleep(3000);
    await adapter.send(h, { text });
    await sleep(6000);
    return h;
  };
  const mA = newWorkerMarker();
  const mB = newWorkerMarker();
  const hA = await session(a, mA, 'SAY alpha');
  const hB = await session(b, mB, 'SAY beta');
  console.log(`daemons ${daemons().length}; processes with A's marker ${marks(mA)}, with B's ${marks(mB)}`);
  await adapter.close(hA);
  open.splice(open.indexOf(hA), 1);
  const found = sweep ? (await endMarkedProcesses([mA])).found.length : 0;
  console.log(`closed A${sweep ? `, swept its marker: ended ${found}` : ' (no sweep)'}; daemons now ${daemons().length}`);
  await sleep(1000);
  const n = api.requests.length;
  await adapter.send(hB, { text: 'SAY gamma' }).catch((e) => console.log(`send to B failed: ${e.message}`));
  await sleep(8000);
  const reached = api.requests.length - n;
  console.log(`B's next turn reached the API ${reached} time(s)`);
  ok = sweep ? reached === 0 : reached > 0;
} finally {
  for (const h of open) await adapter?.close(h).catch(() => {});
  for (const l of daemons()) {
    try {
      process.kill(Number(l.trim().split(' ')[0]), 'SIGKILL');
    } catch {}
  }
  await api?.close();
  await sleep(500);
  rmSync(root, { recursive: true, force: true });
}
console.log(ok ? 'as expected' : 'UNEXPECTED');
process.exit(ok ? 0 : 1);
