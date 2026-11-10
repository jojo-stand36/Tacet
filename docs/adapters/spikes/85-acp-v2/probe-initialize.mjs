// Spike #85: send one `initialize` to an ACP agent on stdio and print the version it answers.
//   node probe-initialize.mjs <1|2> <agent command...>
// v2 needs `info`; v1 takes `clientCapabilities`. The agent runs in an empty temporary home, so
// no login or config of the user's is read. No prompt is sent and no model API is called.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [offer, ...cmd] = process.argv.slice(2);
const home = mkdtempSync(join(tmpdir(), 'acp-v2-probe-'));
const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, CLAUDE_CONFIG_DIR: home, GEMINI_CLI_HOME: home, NO_BROWSER: '1' };
const p = spawn(cmd[0], cmd.slice(1), { cwd: home, env, stdio: ['pipe', 'pipe', 'ignore'] });
const params =
  offer === '2'
    ? { protocolVersion: 2, info: { name: 'tacet-probe', version: '0.0.0' }, capabilities: {} }
    : { protocolVersion: 1, clientCapabilities: {} };
let buf = '';
const timer = setTimeout(() => finish({ timeout: true }), 20_000);
let done = false;
function finish(result) {
  if (done) return;
  done = true;
  clearTimeout(timer);
  console.log(JSON.stringify({ offered: Number(offer), ...result }));
  p.kill();
}
p.on('error', (e) => finish({ error: e.message }));
p.on('exit', () => rmSync(home, { recursive: true, force: true }));
p.stdout.on('data', (d) => {
  buf += d;
  const lines = buf.split('\n');
  buf = lines.pop() ?? '';
  for (const line of lines) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.id !== 1) continue;
    const r = m.result ?? {};
    finish({
      protocolVersion: r.protocolVersion,
      info: r.info ?? r.agentInfo,
      capabilityKeys: Object.keys(r.capabilities ?? r.agentCapabilities ?? {}),
      ...(m.error ? { error: m.error.message } : {}),
    });
  }
});
p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params })}\n`);
