import { Client as C1 } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport as S1 } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport as H1 } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Client as C2, StreamableHTTPClientTransport as H2 } from '@modelcontextprotocol/client';
import { StdioClientTransport as S2 } from '@modelcontextprotocol/client/stdio';
const url = new URL(`http://127.0.0.1:${process.env.PORT}/mcp`);
const stdio = (S) => new S({ command: 'node', args: ['stdio-server.mjs'], env: { ...process.env } });
const cases = [
  ['v1-sdk 1.32.2 / stdio', C1, () => stdio(S1)],
  ['v1-sdk 1.32.2 / http', C1, () => new H1(url)],
  ['v2-client 2.4.0 / stdio', C2, () => stdio(S2)],
  ['v2-client 2.4.0 / http', C2, () => new H2(url)],
  ['v2-client 2.4.0 auto / stdio', C2, () => stdio(S2), { versionNegotiation: { mode: 'auto' } }],
  ['v2-client 2.4.0 auto / http', C2, () => new H2(url), { versionNegotiation: { mode: 'auto' } }],
  ['v2-client 2.4.0 pin 2026-07-28 / stdio', C2, () => stdio(S2), { versionNegotiation: { mode: { pin: '2026-07-28' } } }],
  ['v2-client 2.4.0 pin 2026-07-28 / http', C2, () => new H2(url), { versionNegotiation: { mode: { pin: '2026-07-28' } } }],
];
for (const [name, C, mk, opts] of cases) {
  const c = new C({ name: 'spike', version: '0' }, opts);
  try {
    await c.connect(mk());
    const tools = await c.listTools();
    const r = await c.callTool({ name: 'escalate', arguments: { question: 'q?' } });
    console.log(JSON.stringify({ name, ok: true, negotiated: c.getNegotiatedProtocolVersion?.() ?? c.transport?.protocolVersion ?? null, server: c.getServerVersion?.()?.name, tools: tools.tools.map(t => t.name), result: r.content?.[0]?.text }));
  } catch (e) { console.log(JSON.stringify({ name, ok: false, error: String(e).slice(0, 300) })); }
  try { await c.close(); } catch {}
}
