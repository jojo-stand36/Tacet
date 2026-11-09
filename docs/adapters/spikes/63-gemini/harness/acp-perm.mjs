// Drive an ACP agent through one prompt that triggers a tool permission request; answer with OPTION kind.
import { spawn } from 'node:child_process'; import readline from 'node:readline'; import fs from 'node:fs';
const [out, kind, cmd, ...args] = process.argv.slice(2);
const log = fs.createWriteStream(out); const w = (d, m) => log.write(JSON.stringify({ dir: d, msg: m }) + '\n');
const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'], env: process.env });
const rl = readline.createInterface({ input: p.stdout }); const pend = new Map(); let id = 0;
const send = (m) => { w('>>', m); p.stdin.write(JSON.stringify(m) + '\n'); };
const req = (method, params) => new Promise((r) => { const i = ++id; pend.set(i, r); send({ jsonrpc: '2.0', id: i, method, params }); });
rl.on('line', (l) => { let m; try { m = JSON.parse(l); } catch { return; } w('<<', m);
  if (m.method === 'session/request_permission') {
    const opt = m.params.options.find((o) => o.kind === kind) ?? m.params.options[0];
    if (kind === 'cancel') { send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: m.params.sessionId } }); send({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'cancelled' } } }); }
    else send({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'selected', optionId: opt.optionId } } });
  } else if (m.id != null && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
await req('initialize', { protocolVersion: 1, clientCapabilities: {} });
const s = await req('session/new', { cwd: process.cwd(), mcpServers: [] });
const r = await req('session/prompt', { sessionId: s.result.sessionId, prompt: [{ type: 'text', text: 'RUN_TOOL' }] });
console.log(JSON.stringify({ kind, stopReason: r.result?.stopReason, error: r.error }));
p.kill(); process.exit(0);
