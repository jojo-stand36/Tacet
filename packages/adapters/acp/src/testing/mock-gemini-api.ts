import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A scripted local stand-in for the Gemini API (`generateContent`, `streamGenerateContent`,
 * `countTokens`), so the real Gemini CLI can run over ACP in tests without a key or network
 * (ported from docs/adapters/spikes/63-gemini; the CLI reads `GOOGLE_GEMINI_BASE_URL`).
 *
 * Non-streaming `generateContent` calls are the CLI's own utility calls (model routing), and
 * always get the routing answer it expects. Streaming calls are the conversation, scripted by the
 * last user text:
 * - `SAY <word>`: streams `You said <word>.` in several chunks.
 * - `RUN_TOOL`: calls `run_shell_command` (`touch tool-ran.txt`), which needs approval.
 * - `ENV_TOOL`: calls `run_shell_command` writing its environment to `tool-env.txt` (#150).
 * - `SLOW`: streams for about ten seconds, for interrupts.
 * - `WHO`: replies with the model in the request path.
 * Requests are recorded (model, last user text, whether it carried a tool result); the API key,
 * which travels in the URL or a header, is never kept.
 */
export interface MockGeminiRequest {
  model: string;
  stream: boolean;
  text: string;
  toolResult: boolean;
  /** The request body as sent, to check that some text never reached the model (#181). */
  raw: string;
}

export interface MockGeminiApi {
  url: string;
  requests: MockGeminiRequest[];
  close(): Promise<void>;
}

interface Part {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: unknown;
}
interface Body {
  contents?: { role?: string; parts?: Part[] }[];
}

const usageMetadata = {
  promptTokenCount: 120,
  candidatesTokenCount: 8,
  totalTokenCount: 128,
  cachedContentTokenCount: 0,
  thoughtsTokenCount: 0,
};

function lastUser(body: Body): { text: string; toolResult: boolean } {
  const u = [...(body.contents ?? [])].reverse().find((c) => c.role === 'user');
  const parts = u?.parts ?? [];
  return {
    text: parts
      .filter((p) => p.text)
      .map((p) => p.text)
      .join('\n'),
    toolResult: parts.some((p) => p.functionResponse !== undefined),
  };
}

const chunk = (parts: Part[], finish = false) => ({
  candidates: [
    {
      content: { role: 'model', parts },
      ...(finish ? { finishReason: 'STOP' } : {}),
      index: 0,
    },
  ],
  usageMetadata,
  modelVersion: 'mock-model',
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The conversation reply for `body`, as stream chunks (each a list of parts) and a delay. */
function script(model: string, body: Body): { chunks: Part[][]; delayMs: number } {
  const { text, toolResult } = lastUser(body);
  if (toolResult) return { chunks: [[{ text: 'Tool finished.' }]], delayMs: 0 };
  if (/ENV_TOOL/.test(text)) {
    return {
      chunks: [
        [
          {
            functionCall: {
              name: 'run_shell_command',
              args: { command: 'env > tool-env.txt', description: 'record the environment' },
            },
          },
        ],
      ],
      delayMs: 0,
    };
  }
  if (/RUN_TOOL/.test(text)) {
    return {
      chunks: [
        [
          {
            functionCall: {
              name: 'run_shell_command',
              args: { command: 'touch tool-ran.txt', description: 'create a file' },
            },
          },
        ],
      ],
      delayMs: 0,
    };
  }
  if (/SLOW/.test(text)) {
    return { chunks: Array.from({ length: 40 }, () => [{ text: 'slow reply ' }]), delayMs: 250 };
  }
  if (/WHO/.test(text)) return { chunks: [[{ text: `model=${model}` }]], delayMs: 0 };
  const m = text.match(/SAY (\w+)/);
  const words = (m ? `You said ${m[1]}.` : 'ok').match(/\S+\s*/g) ?? ['ok'];
  return { chunks: words.map((w) => [{ text: w }]), delayMs: 20 };
}

async function handle(req: IncomingMessage, res: ServerResponse, log: MockGeminiRequest[]) {
  let raw = '';
  for await (const c of req) raw += c;
  let body: Body = {};
  try {
    body = JSON.parse(raw || '{}') as Body;
  } catch {}
  const url = req.url ?? '';
  const model = /models\/([^:/?]+)/.exec(url)?.[1] ?? '';
  const json = (status: number, v: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(v));
  };
  if (url.includes(':countTokens')) return json(200, { totalTokens: 120 });
  if (url.includes(':streamGenerateContent')) {
    log.push({ model, stream: true, raw, ...lastUser(body) });
    const { chunks, delayMs } = script(model, body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [i, parts] of chunks.entries()) {
      if (res.destroyed) return;
      res.write(`data: ${JSON.stringify(chunk(parts, i === chunks.length - 1))}\n\n`);
      if (delayMs) await sleep(delayMs);
    }
    res.end();
    return;
  }
  if (url.includes(':generateContent')) {
    log.push({ model, stream: false, raw, ...lastUser(body) });
    // The CLI's model router asks for a JSON choice; any reasonable one will do.
    return json(200, chunk([{ text: '{"reasoning":"mock","model_choice":"flash"}' }], true));
  }
  json(404, { error: { code: 404, message: 'mock', status: 'NOT_FOUND' } });
}

export async function startMockGeminiApi(): Promise<MockGeminiApi> {
  const requests: MockGeminiRequest[] = [];
  const server: Server = createServer((req, res) => {
    handle(req, res, requests).catch(() => res.destroy());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
