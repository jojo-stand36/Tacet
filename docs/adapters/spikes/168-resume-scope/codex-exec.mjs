// #168: which session does `codex exec resume --last` continue, across sibling worktrees?
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const repo = process.argv[2];
const { startMockResponsesApi } = await import(`${repo}/packages/adapters/codex-app-server/dist/testing/mock-responses-api.js`);
const { codexAcpConfig } = await import(`${repo}/packages/adapters/acp/dist/agents.js`);
const codex = process.argv[3];
const api = await startMockResponsesApi();
const root = mkdtempSync(join(tmpdir(), 's168-codex-'));
const home = join(root, 'codexhome'); mkdirSync(home);
writeFileSync(join(home, 'config.toml'), codexAcpConfig(`${api.url}/v1`));
const main = join(root, 'repo'); mkdirSync(main);
const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
git(['init', '-q', '-b', 'main'], main);
writeFileSync(join(main, 'README'), 'x\n');
git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'init', '--allow-empty'], main);
git(['add', '.'], main); git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'r'], main);
const wt1 = join(root, 'wt1'), wt2 = join(root, 'wt2');
git(['worktree', 'add', '-q', '-b', 'w1', wt1], main);
git(['worktree', 'add', '-q', '-b', 'w2', wt2], main);
const env = { PATH: process.env.PATH, HOME: root, CODEX_HOME: home, OPENAI_API_KEY: 'sk-test-0000000000000000' };
// Async: the mock API runs in this process, so a synchronous child would block its replies.
const run = (cwd, args) =>
  new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(codex, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => p.kill(), 90000);
    p.on('exit', (code, signal) => {
      clearTimeout(timer);
      const sid = /session id: (\S+)/.exec(out)?.[1];
      const reply = out.trim().split('\n').at(-1);
      resolve(`exit ${code ?? signal} in ${Date.now() - t0} ms, session ${sid}, reply ${JSON.stringify(reply)}`);
    });
  });
const sessions = () => {
  const out = {};
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : (out[p] = readFileSync(p, 'utf8')); } };
  try { walk(join(home, 'sessions')); } catch {}
  return out;
};
const cwdOf = (text) => /"cwd":"([^"]+)"/.exec(text)?.[1];
console.log('wt1 new:', await run(wt1, ['exec', 'SAY alpha']));
await new Promise((r) => setTimeout(r, 1100));
console.log('wt2 new:', await run(wt2, ['exec', 'SAY beta']));
const before = sessions();
for (const [p, t] of Object.entries(before)) console.log('session', p.slice(home.length), 'cwd', cwdOf(t), 'lines', t.split('\n').length);
console.log('resume in wt1:', await run(wt1, ['exec', 'resume', '--last', 'SAY gamma']));
const after = sessions();
for (const [p, t] of Object.entries(after)) {
  const grew = (before[p] ?? '').length !== t.length;
  console.log(grew ? 'CHANGED' : 'same   ', p.slice(home.length), 'cwd', cwdOf(t));
}
// Nothing to resume: a third worktree with no sessions of its own.
const wt3 = join(root, 'wt3'); git(['worktree', 'add', '-q', '-b', 'w3', wt3], main);
const before3 = sessions();
console.log('resume in wt3 (none saved there):', await run(wt3, ['exec', 'resume', '--last', 'SAY delta']));
for (const [p, t] of Object.entries(sessions())) if ((before3[p] ?? '').length !== t.length) console.log('CHANGED', p.slice(home.length), 'cwd', cwdOf(t));
console.log('requests', api.requests.map((r) => [r.text, r.inputs]));
await api.close();
rmSync(root, { recursive: true, force: true });
