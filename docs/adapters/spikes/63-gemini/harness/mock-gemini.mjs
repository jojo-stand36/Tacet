// Scripted mock of the Gemini generateContent API so the real Gemini CLI can run without a key.
import http from 'node:http'; import fs from 'node:fs';
const LOG = process.env.MOCK_LOG || 'mock-gemini.jsonl';
const usage = { promptTokenCount: 120, candidatesTokenCount: 8, totalTokenCount: 128, cachedContentTokenCount: 0, thoughtsTokenCount: 0 };
function lastUser(contents = []) {
  const u = [...contents].reverse().find((c) => c.role === 'user') || { parts: [] };
  return { text: u.parts.filter((p) => p.text).map((p) => p.text).join('\n'), fnResp: u.parts.some((p) => p.functionResponse) };
}
function reply(body) {
  const { text, fnResp } = lastUser(body.contents);
  if (fnResp) return [{ text: 'Tool finished.' }];
  if (/RUN_TOOL/.test(text)) return [{ functionCall: { name: 'run_shell_command', args: { command: 'touch spike-file.txt', description: 'create file' } } }];
  const m = text.match(/SAY (\w+)/);
  if (m) return [{ text: `You said ${m[1]}.` }];
  return [{ text: '{"reasoning":"mock","model_choice":"flash"}' }];
}
http.createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c; let body = {}; try { body = JSON.parse(raw || '{}'); } catch {}
  fs.appendFileSync(LOG, JSON.stringify({ method: req.method, url: req.url.replace(/key=[^&]*/, 'key=<redacted>'), last: lastUser(body.contents) }) + '\n');
  if (req.url.includes(':countTokens')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ totalTokens: 120 })); }
  const parts = reply(body);
  const resp = { candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP', index: 0 }], usageMetadata: usage, modelVersion: 'mock-model' };
  if (req.url.includes(':streamGenerateContent')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(`data: ${JSON.stringify(resp)}\n\n`); return res.end(); }
  if (req.url.includes(':generateContent')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(resp)); }
  res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":{"code":404,"message":"mock","status":"NOT_FOUND"}}');
}).listen(Number(process.env.PORT || 8796), '127.0.0.1');
