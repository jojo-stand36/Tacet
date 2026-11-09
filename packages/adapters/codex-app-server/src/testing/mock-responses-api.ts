import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A scripted local stand-in for the OpenAI Responses API (`POST /v1/responses`, SSE), so the real
 * `codex app-server` can run in tests without credentials or network. Scripted by the last user
 * text, like the Claude adapter's mock:
 * - `SAY <word>`: streams `You said <word>.` in several deltas.
 * - `RUN_TOOL`: calls the shell tool Codex offers (`exec_command`) with `touch tool-ran.txt`.
 * - `RUN_CMD <shell command>`: calls the same tool with the rest of the line.
 * - `SLOW`: streams for about ten seconds, for interrupts.
 * - `WHO`: replies with the requested model id.
 * Each request is recorded (model, effort, last user text, whether it carried a tool result and
 * whether an Authorization header was present) for assertions; header values are not kept. A
 * request carrying a tool result also records that result's text as `toolOutput`.
 */
export interface MockResponsesApi {
  url: string;
  requests: {
    model: string | undefined;
    effort: string | undefined;
    text: string;
    toolResult: boolean;
    toolOutput?: string;
    authorized: boolean;
  }[];
  close(): Promise<void>;
}

interface InputItem {
  type?: string;
  role?: string;
  content?: string | { text?: string }[];
  output?: string | { text?: string }[];
}

const joinText = (c: InputItem['content']): string =>
  typeof c === 'string' ? c : (c ?? []).map((x) => x.text ?? '').join('\n');

interface Body {
  model?: string;
  reasoning?: { effort?: string };
  input?: InputItem[];
  tools?: { name?: string; type?: string }[];
}

function lastUser(body: Body): { text: string; toolResult: boolean; toolOutput?: string } {
  const items = body.input ?? [];
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (!it) continue;
    if (it.type === 'function_call_output') {
      return { text: '', toolResult: true, toolOutput: joinText(it.output) };
    }
    if (it.role === 'user') return { text: joinText(it.content), toolResult: false };
  }
  return { text: '', toolResult: false };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let n = 0;

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  log: MockResponsesApi['requests'],
): Promise<void> {
  let raw = '';
  for await (const c of req) raw += c;
  if (!(req.method === 'POST' && req.url?.endsWith('/responses'))) {
    res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
    return;
  }
  let body: Body = {};
  try {
    body = JSON.parse(raw || '{}') as Body;
  } catch {}
  const last = lastUser(body);
  log.push({
    model: body.model,
    effort: body.reasoning?.effort,
    text: last.text,
    toolResult: last.toolResult,
    ...(last.toolOutput !== undefined ? { toolOutput: last.toolOutput } : {}),
    authorized: /^Bearer \S+/.test(req.headers.authorization ?? ''),
  });
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const sse = (event: Record<string, unknown> & { type: string }) =>
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  const id = `resp_mock_${++n}`;
  sse({ type: 'response.created', response: { id } });

  const runCmd = last.text.match(/RUN_CMD (.+)/)?.[1];
  if (!last.toolResult && (runCmd !== undefined || /RUN_TOOL/.test(last.text))) {
    const tools = (body.tools ?? []).map((t) => t.name ?? '');
    const name = tools.find((t) => t === 'exec_command') ?? tools.find((t) => /shell/.test(t));
    const cmd = runCmd ?? 'touch tool-ran.txt';
    // Codex's default tool is `exec_command` ({ cmd }); older models get a `shell` tool instead.
    const args = name && name !== 'exec_command' ? { command: ['sh', '-c', cmd] } : { cmd };
    const item = {
      type: 'function_call',
      id: `fc_mock_${n}`,
      call_id: `call_mock_${n}`,
      name: name ?? 'exec_command',
      arguments: JSON.stringify(args),
    };
    sse({ type: 'response.output_item.added', output_index: 0, item });
    sse({ type: 'response.output_item.done', output_index: 0, item });
  } else {
    const slow = !last.toolResult && /SLOW/.test(last.text);
    const say = last.text.match(/SAY (\w+)/);
    const text = last.toolResult
      ? 'Tool finished.'
      : slow
        ? 'slow reply '.repeat(40)
        : /WHO/.test(last.text)
          ? `model=${body.model ?? '?'}`
          : say
            ? `You said ${say[1]}.`
            : 'ok';
    const item = { type: 'message', id: `msg_mock_${n}`, role: 'assistant', content: [] };
    sse({ type: 'response.output_item.added', output_index: 0, item });
    const parts = slow ? (text.match(/.{1,10}/g) ?? []) : (text.match(/\S+\s*/g) ?? []);
    for (const delta of parts) {
      if (res.destroyed) return;
      sse({
        type: 'response.output_text.delta',
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta,
      });
      await sleep(slow ? 250 : 5);
    }
    sse({
      type: 'response.output_item.done',
      output_index: 0,
      item: { ...item, content: [{ type: 'output_text', text }] },
    });
  }
  sse({
    type: 'response.completed',
    response: {
      id,
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 20 },
        output_tokens: 10,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 110,
      },
    },
  });
  res.end();
}

export async function startMockResponsesApi(): Promise<MockResponsesApi> {
  const requests: MockResponsesApi['requests'] = [];
  const server: Server = createServer((req, res) => {
    handle(req, res, requests).catch(() => res.destroy());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
