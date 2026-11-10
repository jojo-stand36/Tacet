// A fake ACP v1 agent for adapter tests: newline-delimited JSON-RPC on stdio, behaviour from env.
// FAKE_LOG: file to append every received message and this process's argv to (JSON lines).
// FAKE_LOGIN_METHODS: JSON array of `authMethods` to offer. FAKE_NEEDS_LOGIN=1: `session/new`
// fails with -32000 until `authenticate` succeeded. FAKE_STDERR: text to write to stderr at
// start, in two chunks.
// FAKE_CAPS: JSON merged into `agentCapabilities` (e.g. `loadSession`, `sessionCapabilities`).
// Prompts are scripted by their text:
// - `PERMS`: asks two permissions at once; ends the turn `cancelled` on `session/cancel`, once
//   both are answered, or `end_turn` if both were answered without a cancel.
// - `ABORT`: waits for `session/cancel`, then fails the request with -32800.
// - `CRASH`: exits with code 3 mid-turn.
// - `SLOW <text>`: replies `<text>` after 300 ms. Anything else: replies with the prompt text.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const log = (entry) => {
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${JSON.stringify(entry)}\n`);
};
const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
const say = (sessionId, text) =>
  send({
    method: 'session/update',
    params: {
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    },
  });
// Names only, never values.
log({ argv: process.argv.slice(2), envNames: Object.keys(process.env).sort() });
if (process.env.FAKE_STDERR) {
  // In two writes, split mid-text, so a secret in it arrives in two chunks.
  const t = process.env.FAKE_STDERR;
  const half = Math.floor(t.length / 2);
  process.stderr.write(t.slice(0, half));
  setTimeout(() => process.stderr.write(`${t.slice(half)}\n`), 100);
}

let authed = false;
let nextId = 1000;
/** Our own requests to the client, by id. */
const asked = new Map();
/** What a running turn does on `session/cancel`. */
let onCancel;

function ask(method, params) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve) => asked.set(id, resolve));
}

function prompt(m) {
  const sessionId = m.params.sessionId;
  const text = m.params.prompt.map((b) => b.text ?? '').join('');
  const end = (stopReason) => send({ id: m.id, result: { stopReason } });
  if (text === 'PERMS') {
    let cancelled = false;
    onCancel = () => {
      cancelled = true;
    };
    const options = [
      { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
      { optionId: 'no', name: 'Reject', kind: 'reject_once' },
    ];
    const toolCall = (id) => ({ toolCallId: id, title: `tool ${id}`, kind: 'execute' });
    Promise.all([
      ask('session/request_permission', { sessionId, toolCall: toolCall('t1'), options }),
      ask('session/request_permission', { sessionId, toolCall: toolCall('t2'), options }),
    ]).then(() => end(cancelled ? 'cancelled' : 'end_turn'));
  } else if (text === 'ABORT') {
    onCancel = () => send({ id: m.id, error: { code: -32800, message: 'Request cancelled' } });
  } else if (text === 'CRASH') {
    say(sessionId, 'about to crash');
    setTimeout(() => process.exit(3), 50);
  } else if (text.startsWith('SLOW ')) {
    setTimeout(() => {
      say(sessionId, text.slice(5));
      end('end_turn');
    }, 300);
  } else {
    say(sessionId, text || 'ok');
    end('end_turn');
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  log({ received: m });
  if (m.method === undefined && asked.has(m.id)) {
    asked.get(m.id)(m.result);
    asked.delete(m.id);
  } else if (m.method === 'initialize') {
    send({
      id: m.id,
      result: {
        protocolVersion: 1,
        authMethods: JSON.parse(process.env.FAKE_LOGIN_METHODS ?? '[]'),
        agentCapabilities: {
          mcpCapabilities: { http: true, sse: false },
          ...JSON.parse(process.env.FAKE_CAPS ?? '{}'),
        },
      },
    });
  } else if (m.method === 'authenticate') {
    authed = true;
    send({ id: m.id, result: {} });
  } else if (m.method === 'session/new') {
    if (process.env.FAKE_NEEDS_LOGIN === '1' && !authed) {
      send({ id: m.id, error: { code: -32000, message: 'Authentication required' } });
    } else send({ id: m.id, result: { sessionId: 'fake-session-1' } });
  } else if (m.method === 'session/load') {
    // The history is replayed as updates before the answer.
    say(m.params.sessionId, 'replayed history');
    send({ id: m.id, result: null });
  } else if (m.method === 'session/resume') {
    send({ id: m.id, result: {} });
  } else if (m.method === 'session/prompt') {
    prompt(m);
  } else if (m.method === 'session/cancel') {
    onCancel?.();
    onCancel = undefined;
  } else if (m.id !== undefined) {
    send({ id: m.id, error: { code: -32601, message: 'Method not found' } });
  }
});
