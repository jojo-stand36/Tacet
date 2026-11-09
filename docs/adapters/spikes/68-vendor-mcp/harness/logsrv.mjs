import http from 'node:http'; import fs from 'node:fs';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { factory } from './factory.mjs';
const LOG = process.env.LOG; const h = createMcpHandler(factory);
http.createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  let j; try { j = JSON.parse(body); } catch {}
  const msgs = [].concat(j ?? []);
  fs.appendFileSync(LOG, JSON.stringify({ ua: req.headers['user-agent'], method: req.method, url: req.url, xTacet: req.headers['x-tacet-token'] ? 'present' : 'absent', mcpProtoHeader: req.headers['mcp-protocol-version'] ?? null, rpc: msgs.map(m => ({ method: m.method, pv: m.params?.protocolVersion ?? m.params?._meta?.['io.modelcontextprotocol/protocolVersion'] ?? null, clientInfo: m.params?.clientInfo ?? null })) }) + '\n');
  const r = await h.fetch(new Request(`http://127.0.0.1:${process.env.PORT}${req.url}`, { method: req.method, headers: req.headers, body: ['GET','HEAD'].includes(req.method) ? undefined : body }));
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
}).listen(Number(process.env.PORT), '127.0.0.1');
