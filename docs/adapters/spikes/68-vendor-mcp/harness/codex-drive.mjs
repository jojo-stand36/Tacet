import { spawn } from 'node:child_process';
import readline from 'node:readline';
const p = spawn(process.argv[2], ['app-server', ...JSON.parse(process.env.EXTRA_ARGS || '[]')], { env: { PATH: process.env.PATH, HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME, OPENAI_API_KEY: 'sk-dummy-not-a-key' }, cwd: process.argv[3], stdio: ['pipe', 'pipe', 'inherit'] });
const rl = readline.createInterface({ input: p.stdout }); const pending = new Map(); let id = 0;
rl.on('line', (l) => { const m = JSON.parse(l); console.log('<<', l.slice(0, 400)); if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const req = (method, params) => new Promise((r) => { const i = ++id; pending.set(i, r); const s = JSON.stringify({ jsonrpc: '2.0', id: i, method, params }); console.log('>>', s); p.stdin.write(s + '\n'); });
const note = (method, params) => { const s = JSON.stringify({ jsonrpc: '2.0', method, params }); console.log('>>', s); p.stdin.write(s + '\n'); };
await req('initialize', { clientInfo: { name: 'tacet-spike', title: 'Tacet spike', version: '0.0.0' }, capabilities: { experimentalApi: false } });
note('initialized', {});
const t = await req('thread/start', { cwd: process.argv[3], approvalPolicy: 'on-request', config: JSON.parse(process.env.THREAD_CONFIG || 'null') });
const threadId = t.result?.thread?.id;

await req('mcpServerStatus/list', {}); await new Promise(r => setTimeout(r, 3000));
p.kill('SIGTERM');
