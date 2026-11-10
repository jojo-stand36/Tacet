// A scripted stand-in for `codex app-server` for failure-path unit tests. Speaks the same
// newline-delimited JSON-RPC. FAKE_MODE selects the behaviour; FAKE_LOG records the client's
// messages (method and params or result only) for assertions. FAKE_ENV_LOG receives the names
// (never values) of the variables this process got.
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync } from 'node:fs';
import { createInterface } from 'node:readline';

const mode = process.env.FAKE_MODE ?? 'normal';
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const log = (m) =>
  process.env.FAKE_LOG && appendFileSync(process.env.FAKE_LOG, `${JSON.stringify(m)}\n`);
if (process.env.FAKE_ENV_LOG) {
  appendFileSync(process.env.FAKE_ENV_LOG, JSON.stringify(Object.keys(process.env).sort()));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let turns = 0;
let modelLists = 0;
let active;

if (mode === 'child') {
  // A background child, like Codex's plugin sync, that outlives a plain kill of this process.
  const child = spawn('sleep', ['60'], { stdio: 'ignore' });
  log({ childPid: child.pid });
}

const complete = (turnId, status, extra = {}) => {
  send({
    method: 'turn/completed',
    params: { threadId: 'thread-1', turn: { id: turnId, status, ...extra } },
  });
  if (active === turnId) active = undefined;
};

const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  const m = JSON.parse(line);
  log(m);
  if (m.method === 'initialize') return send({ id: m.id, result: { userAgent: 'fake/0.167.0' } });
  if (m.method === 'account/read') {
    return send({ id: m.id, result: { account: null, requiresOpenaiAuth: true } });
  }
  if (m.method === 'thread/start' || m.method === 'thread/resume' || m.method === 'thread/fork') {
    send({ id: m.id, result: { thread: { id: 'thread-1' }, model: 'fake-model' } });
    if (mode === 'close-stdin') {
      // Stop reading, stay alive for a moment, then exit: writes in between hit EPIPE.
      await sleep(50);
      rl.close();
      process.stdin.pause();
      closeSync(0);
      setTimeout(() => process.exit(0), 800);
    }
    if (mode === 'exit-idle') setTimeout(() => process.exit(5), 100);
    return;
  }
  if (m.method === 'model/list') {
    modelLists++;
    if (mode === 'models-fail-once' && modelLists === 1) {
      return send({ id: m.id, error: { code: -32603, message: 'catalog unavailable' } });
    }
    if (mode === 'models-slow') await sleep(200);
    const levels = ['low', 'high'].map((reasoningEffort) => ({ reasoningEffort }));
    return send({
      id: m.id,
      result: {
        data: [
          {
            id: 'fake-model',
            model: 'fake-model',
            isDefault: true,
            supportedReasoningEfforts: levels,
          },
          // Malformed: no supportedReasoningEfforts. Skipped by the adapter.
          { id: 'broken', model: 'broken' },
        ],
        // A server that repeats its cursor must not make the adapter loop.
        nextCursor: mode === 'models-loop' ? 'same' : null,
      },
    });
  }
  if (m.method === 'turn/interrupt') {
    send({ id: m.id, result: {} });
    if (active) complete(active, 'interrupted');
    return;
  }
  if (m.method === 'turn/start') {
    const turnId = `turn-${++turns}`;
    active = turnId;
    if (mode === 'slow-start') await sleep(300);
    send({ id: m.id, result: { turn: { id: turnId, status: 'inProgress' } } });
    send({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: turnId } } });
    if (mode === 'crash') process.exit(3);
    if (mode === 'drop-stdout') {
      process.stdout.end();
      setTimeout(() => process.exit(4), 100);
      return;
    }
    if (mode === 'refresh') {
      send({ id: 900, method: 'account/chatgptAuthTokens/refresh', params: {} });
      return;
    }
    if (mode === 'slow-start') return; // Stays running until interrupted.
    if (mode === 'approval' && turns === 1) {
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
    if (mode === 'permissions') {
      send({
        id: 902,
        method: 'item/permissions/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId,
          itemId: 'p1',
          reason: 'needs network',
          permissions: { network: { enabled: true }, fileSystem: { write: ['/w'] } },
        },
      });
      return;
    }
    // split-delta: the message comes in the pieces FAKE_DELTAS lists (a JSON array).
    const deltas = mode === 'split-delta' ? JSON.parse(process.env.FAKE_DELTAS ?? '[]') : ['hi'];
    for (const delta of deltas) {
      send({
        method: 'item/agentMessage/delta',
        params: { threadId: 'thread-1', turnId, itemId: 'm', delta },
      });
    }
    if (mode === 'normal') complete(turnId, 'failed', { error: { message: 'model overloaded' } });
    else complete(turnId, 'completed');
  }
});
