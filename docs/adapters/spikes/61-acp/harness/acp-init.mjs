import { spawn } from 'node:child_process'; import readline from 'node:readline';
const [cmd, ...args] = process.argv.slice(2);
const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'], env: process.env });
const rl = readline.createInterface({ input: p.stdout });
rl.on('line', (l) => { try { const m = JSON.parse(l); if (m.id === 1) { console.log(JSON.stringify({ protocolVersion: m.result?.protocolVersion, agentInfo: m.result?.agentInfo, agentCapabilities: m.result?.agentCapabilities, error: m.error })); p.kill(); process.exit(0); } } catch {} });
p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } }) + '\n');
setTimeout(() => { console.log('timeout'); p.kill(); process.exit(1); }, 40000);
