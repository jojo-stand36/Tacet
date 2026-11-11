import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { join, sep } from 'node:path';

/**
 * Token usage from the session's own Claude Code transcript (#255). The PTY gives no usage
 * stream, but Claude Code writes every model call to `<CLAUDE_CONFIG_DIR>/projects/<project>/
 * <session id>.jsonl` (seen live with 2.1.319, recorded in the capability matrix). An assistant
 * line carries `message.id`, `message.model` and `message.usage`; a call with several content
 * blocks is written as several lines with the same id.
 *
 * The transcript is found here, under the session's own config dir, and never taken from a
 * hook's `transcript_path`: a hook body is the Worker's word, and a path in it could point
 * Tacet at any file.
 */

/** One model call. */
export interface TranscriptCall {
  /** Input tokens, cache writes and reads included (as the SDK adapter counts them). */
  inputTokens: number;
  outputTokens: number;
  model: string | undefined;
  /** A subagent's call: counted, but not the main conversation's context. */
  sidechain: boolean;
}

const NAME = /^[0-9a-f-]{36}$/;

/**
 * The session's transcript: the one regular file `<id>.jsonl` directly in a project directory
 * under `<configDir>/projects`, not reached through a symlink. Undefined while there is none, and
 * when there is more than one (the session ran in several directories): which is current cannot
 * be told, so no usage is read rather than the wrong one.
 */
export function findTranscript(configDir: string, sessionId: string): string | undefined {
  if (!NAME.test(sessionId)) return undefined;
  const projects = join(configDir, 'projects');
  let root: string;
  let dirs: string[];
  try {
    if (!lstatSync(projects).isDirectory()) return undefined;
    root = realpathSync(projects);
    dirs = readdirSync(projects);
  } catch {
    return undefined;
  }
  const found: string[] = [];
  for (const d of dirs) {
    const dir = join(projects, d);
    const file = join(dir, `${sessionId}.jsonl`);
    try {
      if (!lstatSync(dir).isDirectory() || !lstatSync(file).isFile()) continue;
      if (!realpathSync(file).startsWith(root + sep)) continue;
    } catch {
      continue;
    }
    found.push(file);
  }
  return found.length === 1 ? found[0] : undefined;
}

const MAX_LINE = 4 * 1024 * 1024;

/**
 * Reads a transcript as it grows, from where the last read stopped, and returns the model calls
 * not returned before. Call it when a turn has ended: a call whose lines are still being written
 * is taken with the usage its last line has so far.
 */
export class TranscriptReader {
  #offset = 0;
  #partial = Buffer.alloc(0);
  #seen = new Set<string>();
  #file: string | undefined;

  constructor(private readonly locate: () => string | undefined) {}

  /** Take what the transcript holds now as already reported (a resumed session's history). */
  skip(): void {
    this.read();
  }

  read(): TranscriptCall[] {
    this.#file ??= this.locate();
    if (this.#file === undefined) return [];
    const lines = this.#newLines(this.#file);
    // The last line of each call holds its final usage.
    const calls = new Map<string, TranscriptCall>();
    for (const line of lines) {
      const call = parseCall(line);
      if (!call || this.#seen.has(call.id)) continue;
      calls.delete(call.id);
      calls.set(call.id, call.call);
    }
    for (const id of calls.keys()) {
      this.#seen.add(id);
      if (this.#seen.size > 4096) {
        const oldest = this.#seen.values().next().value;
        if (oldest !== undefined) this.#seen.delete(oldest);
      }
    }
    return [...calls.values()];
  }

  #newLines(file: string): string[] {
    let fd: number;
    try {
      fd = openSync(file, 'r');
    } catch {
      return [];
    }
    try {
      const size = fstatSync(fd).size;
      if (size < this.#offset) {
        // Rewritten from the start: read it again; seen ids keep calls from counting twice.
        this.#offset = 0;
        this.#partial = Buffer.alloc(0);
      }
      const chunks: Buffer[] = [this.#partial];
      while (this.#offset < size) {
        const buf = Buffer.alloc(Math.min(size - this.#offset, 1024 * 1024));
        const n = readSync(fd, buf, 0, buf.length, this.#offset);
        if (n === 0) break;
        this.#offset += n;
        chunks.push(buf.subarray(0, n));
      }
      const all = Buffer.concat(chunks);
      const end = all.lastIndexOf(10);
      this.#partial = end < 0 ? all : all.subarray(end + 1);
      // A line that never ends is not kept without bound.
      if (this.#partial.length > MAX_LINE) this.#partial = Buffer.alloc(0);
      return end < 0 ? [] : all.subarray(0, end).toString('utf8').split('\n');
    } finally {
      closeSync(fd);
    }
  }
}

const count = (v: unknown): number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0;

function parseCall(line: string): { id: string; call: TranscriptCall } | undefined {
  if (!line.includes('"assistant"')) return undefined;
  let j: unknown;
  try {
    j = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof j !== 'object' || j === null) return undefined;
  const o = j as Record<string, unknown>;
  if (o.type !== 'assistant' || typeof o.message !== 'object' || o.message === null) {
    return undefined;
  }
  const m = o.message as Record<string, unknown>;
  // Claude Code's own placeholder messages (e.g. for an API error) are not model calls.
  if (m.model === '<synthetic>') return undefined;
  if (typeof m.id !== 'string' || m.id === '') return undefined;
  if (typeof m.usage !== 'object' || m.usage === null) return undefined;
  const u = m.usage as Record<string, unknown>;
  return {
    id: m.id,
    call: {
      inputTokens:
        count(u.input_tokens) +
        count(u.cache_creation_input_tokens) +
        count(u.cache_read_input_tokens),
      outputTokens: count(u.output_tokens),
      model: typeof m.model === 'string' && m.model !== '' ? m.model : undefined,
      sidechain: o.isSidechain === true,
    },
  };
}

const M = 1_000_000;
const K200 = 200_000;

/**
 * Context windows by model id, from the capability matrix ("Model context windows (#255)",
 * verified 2026-11-11). Opus 4.6 and Sonnet 4.6 get 1M in Claude Code only with the `[1m]`
 * suffix at launch, so their entry depends on it.
 */
const WINDOWS: ReadonlyArray<readonly [string, number | 'suffix']> = [
  ['claude-fable-5-2', M],
  ['claude-fable-5-1', M],
  ['claude-fable-5', M],
  ['claude-mythos-5-2', M],
  ['claude-mythos-5-1', M],
  ['claude-mythos-5', M],
  ['claude-opus-5-5', M],
  ['claude-opus-5', M],
  ['claude-opus-4-8', M],
  ['claude-opus-4-7', M],
  ['claude-opus-4-6', 'suffix'],
  ['claude-opus-4-5', K200],
  ['claude-sonnet-5-5', M],
  ['claude-sonnet-5', M],
  ['claude-sonnet-4-6', 'suffix'],
  ['claude-sonnet-4-5', K200],
  ['claude-haiku-5-5', M],
  ['claude-haiku-4-5', K200],
];

/**
 * The context window for a call's model, or undefined when the model is not in the table.
 * `launchModel` is the `--model` the session started with (`[1m]` there selects 1M for the 4.6
 * models); `env` is the Worker's environment, whose `CLAUDE_CODE_MAX_CONTEXT_TOKENS` overrides
 * the window and whose `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` caps it at 200K, as Claude Code's
 * model-config docs say.
 */
export function contextWindow(
  model: string | undefined,
  launchModel: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): number | undefined {
  const override = Number(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS);
  if (env.CLAUDE_CODE_MAX_CONTEXT_TOKENS && Number.isSafeInteger(override) && override > 0) {
    return override;
  }
  if (model === undefined) return undefined;
  // Provider forms: `us.anthropic.claude-…`, `…@20250929`, `…-20250929-v1:0`, `…[1m]`.
  const id = model
    .toLowerCase()
    .replace(/\[1m\]$/, '')
    .replace(/^(?:[a-z]+\.)*anthropic\./, '')
    .replace(/@\d{8}$/, '')
    .replace(/-v\d+(?::\d+)?$/, '')
    .replace(/-\d{8}$/, '');
  const entry = WINDOWS.find(([name]) => name === id)?.[1];
  if (entry === undefined) return undefined;
  const window =
    entry === 'suffix' ? (launchModel?.toLowerCase().endsWith('[1m]') ? M : K200) : entry;
  return env.CLAUDE_CODE_DISABLE_1M_CONTEXT === '1' ? Math.min(window, K200) : window;
}
