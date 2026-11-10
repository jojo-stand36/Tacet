// #168: which session does `gemini --resume latest` continue, across sibling git worktrees?
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const [repo, geminiBin] = process.argv.slice(2);
const { startMockGeminiApi } = await import(`${repo}/packages/adapters/acp/dist/testing/mock-gemini-api.js`);
const api = await startMockGeminiApi();
const root = mkdtempSync(join(tmpdir(), 's168-gemini-'));
const ghome = join(root, 'ghome'); mkdirSync(join(ghome, '.gemini'), { recursive: true });
writeFileSync(join(ghome, '.gemini', 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' }, folderTrust: { enabled: false } } }));
const main = join(root, 'repo'); mkdirSync(main);
const git = (a, c) => execFileSync('git', a, { cwd: c, stdio: 'pipe' });
git(['init', '-q', '-b', 'main'], main); writeFileSync(join(main, 'R'), 'x');
git(['add', '.'], main); git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'r'], main);
const wts = ['wt1', 'wt2', 'wt3'].map((n) => { const p = join(root, n); git(['worktree', 'add', '-q', '-b', n, p], main); return p; });
const env = { PATH: process.env.PATH, HOME: root, GEMINI_CLI_HOME: ghome, GEMINI_API_KEY: 'placeholder-not-a-real-key', GOOGLE_GEMINI_BASE_URL: api.url };
const run = (cwd, args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [geminiBin, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
  const t = setTimeout(() => p.kill(), 90000);
  p.on('exit', (code, sig) => { clearTimeout(t); resolve(`exit ${code ?? sig}; out ${JSON.stringify(out.trim().slice(-120))}; stderr about sessions: ${JSON.stringify(err.split('\n').filter((l) => /session|resume|latest/i.test(l)).join(' | ').slice(0, 400))}`); });
});
const files = () => { const o = {}; const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : (o[p] = statSync(p).mtimeMs + ':' + statSync(p).size); } }; try { walk(join(ghome, '.gemini', 'tmp')); } catch {} return o; };
const step = async (cwd, args) => {
  const before = files();
  const res = await run(cwd, args);
  const after = files();
  const changed = Object.keys(after).filter((p) => after[p] !== before[p] && /chats|session/i.test(p)).map((p) => p.slice(ghome.length));
  console.log(`${cwd.split('/').at(-1)} ${args.join(' ')}: ${res}\n   chat files changed: ${changed.join(', ') || 'none'}`);
};
await step(wts[0], ['-p', 'SAY alpha']);
await new Promise((r) => setTimeout(r, 1100));
await step(wts[1], ['-p', 'SAY beta']);
await step(wts[0], ['--resume', 'latest', '-p', 'SAY gamma']);
await step(wts[2], ['--resume', 'latest', '-p', 'SAY delta']);
try { console.log('projects.json:', readFileSync(join(ghome, '.gemini', 'projects.json'), 'utf8')); } catch (e) { console.log('no projects.json', readdirSync(join(ghome, '.gemini'))); }
console.log('requests:', api.requests.filter((r) => r.stream !== false).map((r) => r.text ?? r).slice(0, 12).map((x) => JSON.stringify(x).slice(0, 80)));
await api.close();
rmSync(root, { recursive: true, force: true });
