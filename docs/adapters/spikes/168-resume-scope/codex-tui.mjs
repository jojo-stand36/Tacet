// #168: the interactive TUI's `codex resume --last`, through the real PtyCliAdapter (node-pty).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const [repo, codex] = process.argv.slice(2);
const { startMockResponsesApi } = await import(`${repo}/packages/adapters/codex-app-server/dist/testing/mock-responses-api.js`);
const { codexAcpConfig } = await import(`${repo}/packages/adapters/acp/dist/agents.js`);
const { PtyCliAdapter, PTY_LAST_SESSION } = await import(`${repo}/packages/adapters/pty/dist/index.js`);
const api = await startMockResponsesApi();
const root = mkdtempSync(join(tmpdir(), 's168-tui-'));
const home = join(root, 'codexhome'); mkdirSync(home);
const main = join(root, 'repo'); mkdirSync(main);
const git = (a, c) => execFileSync('git', a, { cwd: c, stdio: 'pipe' });
git(['init', '-q', '-b', 'main'], main); writeFileSync(join(main, 'R'), 'x');
git(['add', '.'], main); git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'r'], main);
const wts = ['wt1', 'wt2', 'wt3'].map((n) => { const p = join(root, n); git(['worktree', 'add', '-q', '-b', n, p], main); return p; });
// Trust each checkout, so no trust prompt blocks the TUI.
writeFileSync(join(home, 'config.toml'), codexAcpConfig(`${api.url}/v1`) + wts.map((w) => `\n[projects."${w}"]\ntrust_level = "trusted"\n`).join(''));
const adapter = new PtyCliAdapter({
  slug: 'codex',
  preset: { command: [codex], resumeArgs: ['resume', '--last'] },
  baseEnv: { PATH: process.env.PATH, HOME: root, CODEX_HOME: home, OPENAI_API_KEY: 'sk-test-0000000000000000' },
  envPolicy: { pass: ['CODEX_HOME', 'OPENAI_API_KEY'] },
  quietMs: 2500, startTimeoutMs: 30000, killTimeoutMs: 3000,
});
const sessions = () => { const out = {}; const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : (out[p] = readFileSync(p, 'utf8')); } }; try { walk(join(home, 'sessions')); } catch {} return out; };
const cwdOf = (t) => /"cwd":"([^"]+)"/.exec(t)?.[1]?.split('/').at(-1);
async function turn(cwd, text, resume) {
  const before = sessions();
  const n = api.requests.length;
  const h = await adapter.start({ cwd, ...(resume ? { resume: { vendorSessionId: PTY_LAST_SESSION } } : {}) });
  const events = [];
  (async () => { for await (const e of adapter.events(h)) events.push(e); })();
  await new Promise((r) => setTimeout(r, 3000));
  await adapter.send(h, { text });
  const t0 = Date.now();
  while (api.requests.length === n && Date.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 300));
  await new Promise((r) => setTimeout(r, 3000));
  const screen = adapter.terminal?.(h)?.snapshot?.() ?? '';
  await adapter.close(h);
  const changed = Object.entries(sessions()).filter(([p, t]) => (before[p] ?? '') !== t).map(([p, t]) => `${p.split('/').at(-1).slice(0, 40)} (cwd ${cwdOf(t)})`);
  const req = api.requests.slice(n).map((r) => [r.text, r.inputs]);
  console.log(`${cwd.split('/').at(-1)} ${resume ? 'resume' : 'new   '} ${text}: requests ${JSON.stringify(req)}; session files changed: ${changed.join(', ') || 'none'}`);
  if (req.length === 0) console.log('  last events:', JSON.stringify(events.slice(-4)).slice(0, 600));
}
await turn(wts[0], 'SAY alpha', false);
await new Promise((r) => setTimeout(r, 1100));
await turn(wts[1], 'SAY beta', false);
await turn(wts[0], 'SAY gamma', true);
await turn(wts[2], 'SAY delta', true);
await api.close();
rmSync(root, { recursive: true, force: true });
process.exit(0);
