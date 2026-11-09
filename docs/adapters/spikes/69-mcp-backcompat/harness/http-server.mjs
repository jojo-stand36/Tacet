import http from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { factory } from './factory.mjs';
const h = createMcpHandler(factory, process.env.LEGACY ? { legacy: process.env.LEGACY } : {});
http.createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  const r = await h.fetch(new Request(`http://127.0.0.1:${process.env.PORT}${req.url}`, { method: req.method, headers: req.headers, body: ['GET','HEAD'].includes(req.method) ? undefined : body }));
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
}).listen(Number(process.env.PORT), '127.0.0.1', () => console.error('listening'));
