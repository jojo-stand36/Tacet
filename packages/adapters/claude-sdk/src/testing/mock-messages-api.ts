import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A scripted local stand-in for the Anthropic Messages API, so the real Claude Code binary can
 * run in tests without credentials or network (ported from docs/adapters/spikes/64-claude).
 * Scripted by the last user text:
 * - `SAY <word>`: streams `You said <word>.` in several deltas.
 * - `RUN_TOOL`: asks for a Bash tool call (`touch tool-ran.txt`).
 * - `READ_TOOL <absolute path>`: asks to `Read` that file, which Claude Code would normally do
 *   without asking for a file in its working directory.
 * - `BACKGROUND_TOOL`: asks for a background Bash tool call (`run_in_background`) that writes
 *   its shell's pid to `background.pid` and then becomes `sleep 600`; with `ESCALATE` in the same first message,
 *   it then escalates as below.
 * - `ESCALATE`: calls the Tacet MCP `escalate` tool with a fixed question: the offered tool whose
 *   name ends in `escalate`, else `mcp__tacet__escalate` (Claude Code defers MCP tools behind
 *   ToolSearch, so they are usually not offered by name).
 * - `SLOW`: streams for about ten seconds, for interrupts.
 * - `WHO`: replies with the requested model id.
 * Requests are recorded (model, last user text, offered tool names, and the effort and beta
 * settings the binary sent; never headers that carry credentials) for assertions.
 */
export interface MockRequest {
  model: string | undefined;
  text: string;
  messages: number;
  /** Ids of the `tool_use` blocks in the conversation sent, so a resumed one can be recognised. */
  toolUseIds: string[];
  /** `output_config.effort` as sent, if any. */
  effort?: unknown;
  /** The `anthropic-beta` header values. */
  betas: string[];
  /** Names of the tools offered. */
  tools: string[];
  /** Which known credential authenticated it (see `startMockMessagesApi`); `none` if none. */
  credential: string;
  /** The request body as sent, to check that some text never reached the model (#181). */
  raw: string;
}

export interface MockMessagesApiOptions {
  /** Test credentials by label: each request records the label of the one it carried. */
  credentials?: Record<string, string>;
}

export interface MockMessagesApi {
  url: string;
  requests: MockRequest[];
  close(): Promise<void>;
}

type Block =
  | { type: 'text'; text: string; slow?: boolean }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

interface Body {
  model?: string;
  output_config?: { effort?: unknown };
  stream?: boolean;
  messages?: { role: string; content: string | { type: string; text?: string; id?: string }[] }[];
  tools?: { name?: string }[];
}

function lastUser(body: Body): { text: string; toolResult: boolean } {
  const m = [...(body.messages ?? [])].reverse().find((x) => x.role === 'user');
  if (!m) return { text: '', toolResult: false };
  if (typeof m.content === 'string') return { text: m.content, toolResult: false };
  return {
    text: m.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('\n'),
    toolResult: m.content.some((b) => b.type === 'tool_result'),
  };
}

/**
 * Which of the known test credentials a request carried (#145): the label of the one in its
 * `x-api-key` header or `Authorization: Bearer` token, `other` for an unknown one, or `none`.
 * Values are compared, never kept.
 */
function credentialOf(req: IncomingMessage, known: Record<string, string>): string {
  const bearer = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
  const xKey = req.headers['x-api-key'];
  const sent = typeof xKey === 'string' ? xKey : bearer;
  if (sent === undefined) return 'none';
  return Object.entries(known).find(([, v]) => v === sent)?.[0] ?? 'other';
}

let n = 0;

function firstUserText(body: Body): string {
  const m = (body.messages ?? []).find((x) => x.role === 'user');
  if (!m) return '';
  return typeof m.content === 'string'
    ? m.content
    : m.content.map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('\n');
}

function plan(body: Body): Block[] {
  const { text, toolResult } = lastUser(body);
  const first = firstUserText(body);
  if (toolResult && /BACKGROUND_TOOL/.test(first) && /ESCALATE/.test(first)) {
    const done = JSON.stringify(body.messages ?? []).includes('Which queue should');
    if (!done) {
      const offered = (body.tools ?? []).map((t) => t.name ?? '');
      return [
        {
          type: 'tool_use',
          id: `toolu_mock_${++n}`,
          name: offered.find((t) => /tacet.*escalate$/.test(t)) ?? 'mcp__tacet__escalate',
          input: { question: 'Which queue should the jobs use?', urgency: 'normal' },
        },
      ];
    }
  }
  if (toolResult) return [{ type: 'text', text: 'Tool finished.' }];
  if (/BACKGROUND_TOOL/.test(text)) {
    return [
      {
        type: 'tool_use',
        id: `toolu_mock_${++n}`,
        name: 'Bash',
        input: {
          command: 'echo $$ > background.pid; exec sleep 600',
          description: 'start a background job',
          run_in_background: true,
        },
      },
    ];
  }
  if (/RUN_TOOL/.test(text)) {
    return [
      {
        type: 'tool_use',
        id: `toolu_mock_${++n}`,
        name: 'Bash',
        input: { command: 'touch tool-ran.txt', description: 'create a file' },
      },
    ];
  }
  const read = /READ_TOOL (\S+)/.exec(text);
  if (read) {
    return [
      { type: 'tool_use', id: `toolu_mock_${++n}`, name: 'Read', input: { file_path: read[1] } },
    ];
  }
  if (/ESCALATE/.test(text)) {
    const offered = (body.tools ?? []).map((t) => t.name ?? '');
    return [
      {
        type: 'tool_use',
        id: `toolu_mock_${++n}`,
        name: offered.find((t) => /tacet.*escalate$/.test(t)) ?? 'mcp__tacet__escalate',
        input: { question: 'Which database should the cache use?', urgency: 'normal' },
      },
    ];
  }
  if (/SLOW/.test(text)) return [{ type: 'text', text: 'slow reply '.repeat(40), slow: true }];
  if (/WHO/.test(text)) return [{ type: 'text', text: `model=${body.model ?? '?'}` }];
  const m = text.match(/SAY (\w+)/);
  return [{ type: 'text', text: m ? `You said ${m[1]}.` : 'ok' }];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  log: MockMessagesApi['requests'],
  known: Record<string, string>,
): Promise<void> {
  let raw = '';
  for await (const c of req) raw += c;
  let body: Body = {};
  try {
    body = JSON.parse(raw || '{}') as Body;
  } catch {}
  const json = (status: number, v: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(v));
  };
  if (req.method === 'POST' && req.url?.startsWith('/v1/messages/count_tokens')) {
    return json(200, { input_tokens: 100 });
  }
  if (!(req.method === 'POST' && req.url?.startsWith('/v1/messages'))) {
    return json(404, { type: 'error', error: { type: 'not_found_error', message: 'mock' } });
  }
  const beta = req.headers['anthropic-beta'];
  log.push({
    raw,
    credential: credentialOf(req, known),
    model: body.model,
    text: lastUser(body).text,
    messages: body.messages?.length ?? 0,
    toolUseIds: (body.messages ?? []).flatMap((m) =>
      typeof m.content === 'string'
        ? []
        : m.content.flatMap((b) => (b.type === 'tool_use' && b.id ? [b.id] : [])),
    ),
    ...(body.output_config?.effort !== undefined ? { effort: body.output_config.effort } : {}),
    betas: (Array.isArray(beta) ? beta.join(',') : (beta ?? ''))
      .split(',')
      .map((b) => b.trim())
      .filter(Boolean),
    tools: (body.tools ?? []).map((t) => t.name ?? ''),
  });
  const blocks = plan(body);
  const id = `msg_mock_${++n}`;
  const usage = {
    input_tokens: 100,
    output_tokens: 10,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  const stop = blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
  if (!body.stream) {
    return json(200, {
      id,
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: blocks.map((b) => (b.type === 'text' ? { type: 'text', text: b.text } : b)),
      stop_reason: stop,
      stop_sequence: null,
      usage,
    });
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const sse = (event: string, data: Record<string, unknown>) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  sse('message_start', {
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { ...usage, output_tokens: 1 },
    },
  });
  for (const [index, b] of blocks.entries()) {
    if (b.type === 'text') {
      sse('content_block_start', { index, content_block: { type: 'text', text: '' } });
      const parts = b.slow ? (b.text.match(/.{1,10}/g) ?? []) : (b.text.match(/\S+\s*/g) ?? []);
      for (const text of parts) {
        if (res.destroyed) return;
        sse('content_block_delta', { index, delta: { type: 'text_delta', text } });
        await sleep(b.slow ? 250 : 5);
      }
    } else {
      sse('content_block_start', {
        index,
        content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} },
      });
      sse('content_block_delta', {
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) },
      });
    }
    sse('content_block_stop', { index });
  }
  sse('message_delta', {
    delta: { stop_reason: stop, stop_sequence: null },
    usage: { output_tokens: 10 },
  });
  sse('message_stop', {});
  res.end();
}

export async function startMockMessagesApi(
  opts: MockMessagesApiOptions = {},
): Promise<MockMessagesApi> {
  const requests: MockMessagesApi['requests'] = [];
  const server: Server = createServer((req, res) => {
    handle(req, res, requests, opts.credentials ?? {}).catch(() => res.destroy());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        // Not expected to wait; if it ever does (#189), say what is still open rather than
        // leaving a test hook to time out without a reason.
        const stuck = setTimeout(() => {
          server.getConnections((_err, open) =>
            reject(
              new Error(
                `mock Messages API did not close within 5 s: ${open} connection(s) open, listening=${server.listening}`,
              ),
            ),
          );
        }, 5000);
        stuck.unref();
        server.close(() => {
          clearTimeout(stuck);
          resolve();
        });
      }),
  };
}
