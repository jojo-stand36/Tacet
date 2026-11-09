// A scripted stand-in for `codex app-server` for failure-path unit tests. Speaks the same
// newline-delimited JSON-RPC. FAKE_MODE selects the behaviour; FAKE_LOG records the client's
// messages (method and params or result only) for assertions.

import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const mode = process.env.FAKE_MODE ?? 'normal';
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const log = (m) =>
  process.env.FAKE_LOG && appendFileSync(process.env.FAKE_LOG, `${JSON.stringify(m)}\n`);
let turns = 0;
if (mode === 'child') {
  // A background child, like Codex's plugin sync, that outlives a plain kill of this process.
  const child = spawn('sleep', ['60'], { stdio: 'ignore' });
  log({ childPid: child.pid });
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  log(m);
  if (m.method === 'initialize') return send({ id: m.id, result: { userAgent: 'fake/0.167.0' } });
  if (m.method === 'account/read') {
    return send({ id: m.id, result: { account: null, requiresOpenaiAuth: true } });
  }
  if (m.method === 'thread/start' || m.method === 'thread/resume' || m.method === 'thread/fork') {
    return send({ id: m.id, result: { thread: { id: 'thread-1' }, model: 'fake-model' } });
  }
  if (m.method === 'turn/interrupt') return send({ id: m.id, result: {} });
  if (m.method === 'turn/start') {
    const turnId = `turn-${++turns}`;
    send({ id: m.id, result: { turn: { id: turnId, status: 'inProgress' } } });
    send({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: turnId } } });
    if (mode === 'crash') process.exit(3);
    if (mode === 'refresh') {
      send({ id: 900, method: 'account/chatgptAuthTokens/refresh', params: {} });
      return;
    }
    if (mode === 'approval') {
      send({
        id: 901,
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId,
          itemId: 'c1',
          command: 'echo SECRETVALUE12345',
          cwd: '/w',
        },
      });
      return;
    }
    send({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', turnId, itemId: 'm', delta: 'hi' },
    });
    send({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: turnId, status: 'failed', error: { message: 'model overloaded' } },
      },
    });
  }
});
