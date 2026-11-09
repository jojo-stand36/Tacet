import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import fs from 'node:fs';
export const factory = (ctx) => {
  if (process.env.ERA_LOG) fs.appendFileSync(process.env.ERA_LOG, ctx.era + '\n');
  const s = new McpServer({ name: 'tacet-mini-spike', version: '0.0.0' }, { capabilities: { tools: {} } });
  s.registerTool('escalate', { description: 'spike tool', inputSchema: z.object({ question: z.string() }) },
    async ({ question }) => ({ content: [{ type: 'text', text: `pending: ${question}` }] }));
  return s;
};
