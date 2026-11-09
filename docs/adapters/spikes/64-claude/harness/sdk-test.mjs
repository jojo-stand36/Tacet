import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
const out = fs.createWriteStream(process.argv[2]);
const log = (tag, o) => out.write(JSON.stringify({ tag, ...o }) + '\n');
function inbox() { const q = []; let wake; let done = false;
  return { push(m) { q.push(m); wake?.(); }, end() { done = true; wake?.(); },
    async *[Symbol.asyncIterator]() { while (true) { if (q.length) { yield q.shift(); continue; } if (done) return; await new Promise(r => wake = r); wake = undefined; } } }; }
const user = (text) => ({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' });
const env = { ...process.env };
const common = { model: 'claude-sonnet-5-5', cwd: process.cwd(), env, settingSources: [], includePartialMessages: true };

const box = inbox();
const q = query({ prompt: box, options: { ...common,
  canUseTool: async (toolName, input, ctx) => { log('canUseTool', { toolName, input, suggestions: ctx.suggestions ?? null, keys: Object.keys(ctx) });
    return { behavior: 'allow', updatedInput: { ...input, command: 'echo via-sdk' } }; } } });
let sessionId; let phase = 0; let interruptedAt = null;
box.push(user('RUN_TOOL'));
for await (const m of q) {
  if (m.type === 'stream_event') { if (phase === 1 && !interruptedAt && m.event?.delta?.type === 'text_delta') { interruptedAt = Date.now();
      box.push(user('SAY queued'));
      const receipt = await q.interrupt(); log('interrupt', { receipt: receipt ?? null }); } continue; }
  log('msg', { type: m.type, subtype: m.subtype, content: m.message?.content, result: m.result, stop: m.stop_reason, cost: m.total_cost_usd, perm: m.permission_denials, err: m.errors });
  if (m.type === 'system' && m.subtype === 'init') sessionId = m.session_id;
  if (m.type === 'result') {
    phase++;
    if (phase === 1) { log('ctx', { usage: await q.getContextUsage().catch(e => String(e)) }); await q.setModel('claude-opus-5-5'); box.push(user('SLOW')); }
    else if (phase >= 2) { if (phase === 3 || phase > 4) box.end(); }
  }
}
log('phase', { phase, sessionId });
// resume in a new process
const q2 = query({ prompt: 'SAY resumed', options: { ...common, resume: sessionId } });
for await (const m of q2) if (m.type !== 'stream_event') log('resume', { type: m.type, subtype: m.subtype, session: m.session_id, result: m.result });
out.end();
