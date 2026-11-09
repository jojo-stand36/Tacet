// Minimal mock of the Anthropic Messages API (streaming) so the real Claude Code
// CLI can be driven without vendor credentials. Scripted by the last user message.
import http from 'node:http';
import fs from 'node:fs';

const LOG = process.env.MOCK_LOG || 'mock-requests.jsonl';
const port = Number(process.env.PORT || 8787);
let n = 0;

function lastUser(messages) {
  const m = [...messages].reverse().find((x) => x.role === 'user');
  if (!m) return { text: '', toolResult: false };
  if (typeof m.content === 'string') return { text: m.content, toolResult: false };
  const toolResult = m.content.some((b) => b.type === 'tool_result');
  const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  return { text, toolResult };
}

function plan(body) {
  const { text, toolResult } = lastUser(body.messages || []);
  if (toolResult) return [{ type: 'text', text: 'Tool finished.' }];
  if (/RUN_TOOL/.test(text)) return [{ type: 'tool_use', id: `toolu_mock_${++n}`, name: 'Bash', input: { command: 'touch spike-file.txt', description: 'create file' } }];
  if (/SLOW/.test(text)) return [{ type: 'text', text: 'slow reply '.repeat(40), slow: true }];
  const m = text.match(/SAY (\w+)/);
  return [{ type: 'text', text: m ? `You said ${m[1]}.` : 'ok' }];
}

function sse(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

http.createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  let body = {};
  try { body = JSON.parse(raw || '{}'); } catch {}
  fs.appendFileSync(LOG, JSON.stringify({ method: req.method, url: req.url, model: body.model, stream: body.stream, nMessages: body.messages?.length, last: body.messages ? lastUser(body.messages) : undefined }) + '\n');

  if (req.method === 'POST' && req.url.startsWith('/v1/messages/count_tokens')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ input_tokens: 100 }));
  }
  if (!(req.method === 'POST' && req.url.startsWith('/v1/messages'))) {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'mock' } }));
  }
  const blocks = plan(body);
  const id = `msg_mock_${++n}`;
  const usage = { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const stop = blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model: body.model, content: blocks.map(({ slow, ...b }) => b), stop_reason: stop, stop_sequence: null, usage }));
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  sse(res, 'message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } });
  for (const [i, b] of blocks.entries()) {
    if (b.type === 'text') {
      sse(res, 'content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } });
      const parts = b.slow ? b.text.match(/.{1,10}/g) : [b.text];
      for (const p of parts) {
        if (res.destroyed) return;
        sse(res, 'content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: p } });
        if (b.slow) await sleep(250);
      }
    } else {
      sse(res, 'content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    }
    sse(res, 'content_block_stop', { type: 'content_block_stop', index: i });
  }
  sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 10 } });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}).listen(port, '127.0.0.1', () => console.error(`mock on ${port}`));
