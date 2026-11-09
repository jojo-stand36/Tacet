import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'node:fs';
const LOG = process.env.PERM_LOG; const MODE = process.env.PERM_MODE || 'allow';
const s = new McpServer({ name: 'perm', version: '0.0.1' });
s.tool('approve', 'permission prompt', { tool_name: z.string(), input: z.any(), tool_use_id: z.string().optional() }, async (args, extra) => {
  fs.appendFileSync(LOG, JSON.stringify({ args, meta: extra?._meta }) + '\n');
  const r = MODE === 'allow' ? { behavior: 'allow', updatedInput: { ...args.input, command: 'echo rewritten' } } : { behavior: 'deny', message: 'denied by spike' };
  return { content: [{ type: 'text', text: JSON.stringify(r) }] };
});
await s.connect(new StdioServerTransport());
