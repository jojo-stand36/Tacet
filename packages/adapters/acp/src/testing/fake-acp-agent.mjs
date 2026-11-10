// A fake ACP v1 agent for adapter tests: newline-delimited JSON-RPC on stdio, behaviour from env.
// FAKE_LOG: file to append every received message and this process's argv to (JSON lines).
// FAKE_AUTH_METHODS: JSON array of `authMethods` to offer. FAKE_REQUIRE_AUTH=1: `session/new`
// fails with -32000 until `authenticate` succeeded. FAKE_STDERR: text to write to stderr at start.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const log = (entry) => {
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${JSON.stringify(entry)}\n`);
};
const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
log({ argv: process.argv.slice(2) });
if (process.env.FAKE_STDERR) process.stderr.write(`${process.env.FAKE_STDERR}\n`);
let authed = false;
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  log({ received: m });
  if (m.method === 'initialize') {
    send({
      id: m.id,
      result: {
        protocolVersion: 1,
        authMethods: JSON.parse(process.env.FAKE_AUTH_METHODS ?? '[]'),
        agentCapabilities: { mcpCapabilities: { http: true, sse: false } },
      },
    });
  } else if (m.method === 'authenticate') {
    authed = true;
    send({ id: m.id, result: {} });
  } else if (m.method === 'session/new') {
    if (process.env.FAKE_REQUIRE_AUTH === '1' && !authed) {
      send({ id: m.id, error: { code: -32000, message: 'Authentication required' } });
    } else send({ id: m.id, result: { sessionId: 'fake-session-1' } });
  } else if (m.method === 'session/prompt') {
    const sessionId = m.params.sessionId;
    send({
      method: 'session/update',
      params: {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } },
      },
    });
    send({ id: m.id, result: { stopReason: 'end_turn' } });
  } else if (m.id !== undefined) {
    send({ id: m.id, error: { code: -32601, message: 'Method not found' } });
  }
});
