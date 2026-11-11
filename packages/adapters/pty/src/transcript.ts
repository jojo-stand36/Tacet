import {
  closeSync,
  constants,
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
 * blocks is written as several lines with the same id, and only the last has the final count.
 *
 * The transcript is found here, under the session's own config dir, and never taken from a
 * hook's `transcript_path`: a hook body is the Worker's word, and a path in it could point
 * Tacet at any file. Every read opens the file without following a symlink, without blocking on
 * a FIFO, and checks it is still the very file found first (device and inode): a file or
 * directory swapped in later is refused.
 */

/** Usage to report for one model call: what it added since it was last reported. */
export interface TranscriptCall {
  /** Input tokens, cache writes and reads included (as the SDK adapter counts them). */
  inputTokens: number;
  outputTokens: number;
  /** The call's whole input plus output so far: the conversation's context after it. */
  contextUsed: number;
  model: string | undefined;
}

/** A transcript found under the config dir, and which file it is. */
export interface TranscriptFile {
  path: string;
  dev: number;
  ino: number;
}

const NAME = /^[0-9a-f-]{36}$/;
// O_NONBLOCK: opening a FIFO for reading would otherwise wait for a writer, on the event loop.
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** Open `path` as the regular file `expect` names (any regular file when absent), or undefined. */
function openChecked(path: string, expect?: { dev: number; ino: number }) {
  let fd: number;
  try {
    fd = openSync(path, OPEN_FLAGS);
  } catch {
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    if (st.isFile() && (!expect || (st.dev === expect.dev && st.ino === expect.ino))) {
      return { fd, dev: st.dev, ino: st.ino, size: st.size };
    }
  } catch {
    // Treated as not there.
  }
  closeSync(fd);
  return undefined;
}

/**
 * The session's transcript: the one regular file `<id>.jsonl` directly in a project directory
 * under `<configDir>/projects`, not reached through a symlink. Undefined while there is none, and
 * when there is more than one (the session ran in several directories): which is current cannot
 * be told, so no usage is read rather than the wrong one.
 */
export function findTranscript(configDir: string, sessionId: string): TranscriptFile | undefined {
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
  const found: TranscriptFile[] = [];
  for (const d of dirs) {
    const dir = join(projects, d);
    const path = join(dir, `${sessionId}.jsonl`);
    try {
      if (!lstatSync(dir).isDirectory() || !lstatSync(path).isFile()) continue;
      if (!realpathSync(path).startsWith(root + sep)) continue;
    } catch {
      continue;
    }
    const f = openChecked(path);
    if (!f) continue;
    closeSync(f.fd);
    found.push({ path, dev: f.dev, ino: f.ino });
  }
  return found.length === 1 ? found[0] : undefined;
}

/** The most one read takes in; the rest waits for the next read. */
const MAX_READ = 16 * 1024 * 1024;
/** A longer line is dropped, not kept. */
const MAX_LINE = 4 * 1024 * 1024;
const CHUNK = 1024 * 1024;
/** Calls whose reported usage is remembered, to report later lines as deltas. */
const MAX_CALLS = 4096;

interface Reported {
  input: number;
  output: number;
}

/**
 * Reads a transcript as it grows, from where the last read stopped, a line at a time, and returns
 * the usage not returned before: a new call in full, a call already reported by what its later
 * lines added (`usage` events are deltas).
 */
export class TranscriptReader {
  #file: TranscriptFile | undefined;
  #offset = 0;
  #partial: Buffer[] = [];
  #partialBytes = 0;
  /** Dropping an over-long line until its end. */
  #dropping = false;
  #reported = new Map<string, Reported>();
  #skipPending = false;

  constructor(private readonly locate: () => TranscriptFile | undefined) {}

  /** The transcript has been found. */
  get found(): boolean {
    this.#file ??= this.locate();
    return this.#file !== undefined;
  }

  /**
   * Take what the transcript holds now as already reported (a resumed session's history). If it
   * cannot be found yet, this applies when it first is.
   */
  skip(): void {
    this.#skipPending = true;
    this.#open();
  }

  /** The usage the transcript gained since the last read; main-conversation calls only. */
  read(): TranscriptCall[] {
    const opened = this.#open();
    if (!opened) return [];
    const { fd, size } = opened;
    const lines: string[] = [];
    try {
      if (size < this.#offset) {
        // Cut short and rewritten: read it again; remembered calls only report what they add.
        this.#offset = 0;
        this.#partial = [];
        this.#partialBytes = 0;
        this.#dropping = false;
      }
      const end = Math.min(size, this.#offset + MAX_READ);
      const buf = Buffer.alloc(Math.min(CHUNK, Math.max(0, end - this.#offset)));
      while (this.#offset < end) {
        const n = readSync(fd, buf, 0, Math.min(buf.length, end - this.#offset), this.#offset);
        if (n === 0) break;
        this.#offset += n;
        this.#lines(buf.subarray(0, n), lines);
      }
    } finally {
      closeSync(fd);
    }
    return this.#calls(lines);
  }

  /** Open the transcript, first finding it; applies a pending skip. */
  #open(): { fd: number; size: number } | undefined {
    this.#file ??= this.locate();
    if (!this.#file) return undefined;
    const f = openChecked(this.#file.path, this.#file);
    if (!f) return undefined;
    if (this.#skipPending) {
      this.#skipPending = false;
      // From the end; a line still being written there is dropped up to its end.
      this.#offset = f.size;
      this.#partial = [];
      this.#partialBytes = 0;
      this.#dropping = f.size > 0 && !endsWithNewline(f.fd, f.size);
      closeSync(f.fd);
      return undefined;
    }
    return { fd: f.fd, size: f.size };
  }

  /** Split a chunk into whole lines, keeping the unfinished end for the next chunk. */
  #lines(chunk: Buffer, out: string[]): void {
    let start = 0;
    for (let nl = chunk.indexOf(10); nl >= 0; nl = chunk.indexOf(10, start)) {
      const piece = chunk.subarray(start, nl);
      start = nl + 1;
      if (this.#dropping) {
        this.#dropping = false;
        continue;
      }
      if (this.#partialBytes + piece.length > MAX_LINE) {
        this.#partial = [];
        this.#partialBytes = 0;
        continue;
      }
      out.push(Buffer.concat([...this.#partial, piece]).toString('utf8'));
      this.#partial = [];
      this.#partialBytes = 0;
    }
    const rest = chunk.subarray(start);
    if (rest.length === 0 || this.#dropping) return;
    if (this.#partialBytes + rest.length > MAX_LINE) {
      this.#partial = [];
      this.#partialBytes = 0;
      this.#dropping = true;
      return;
    }
    // Copied: the chunk's buffer is reused.
    this.#partial.push(Buffer.from(rest));
    this.#partialBytes += rest.length;
  }

  #calls(lines: string[]): TranscriptCall[] {
    // The last line read of each call holds its usage so far.
    const latest = new Map<string, Parsed>();
    for (const line of lines) {
      const p = parseCall(line);
      if (!p) continue;
      latest.delete(p.id);
      latest.set(p.id, p);
    }
    const out: TranscriptCall[] = [];
    for (const p of latest.values()) {
      const before = this.#reported.get(p.id);
      const input = Math.max(p.input, before?.input ?? 0);
      const output = Math.max(p.output, before?.output ?? 0);
      if (before && input === before.input && output === before.output) continue;
      this.#reported.delete(p.id);
      this.#reported.set(p.id, { input, output });
      if (this.#reported.size > MAX_CALLS) {
        const oldest = this.#reported.keys().next().value;
        if (oldest !== undefined) this.#reported.delete(oldest);
      }
      // A subagent's calls are left out, as the claude-sdk adapter leaves them out.
      if (p.sidechain) continue;
      out.push({
        inputTokens: input - (before?.input ?? 0),
        outputTokens: output - (before?.output ?? 0),
        contextUsed: input + output,
        model: p.model,
      });
    }
    return out;
  }
}

function endsWithNewline(fd: number, size: number): boolean {
  const b = Buffer.alloc(1);
  return readSync(fd, b, 0, 1, size - 1) === 1 && b[0] === 10;
}

const count = (v: unknown): number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0;

interface Parsed {
  id: string;
  input: number;
  output: number;
  model: string | undefined;
  sidechain: boolean;
}

function parseCall(line: string): Parsed | undefined {
  // Only a fast path past the other line types; the parse below decides.
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
    input:
      count(u.input_tokens) +
      count(u.cache_creation_input_tokens) +
      count(u.cache_read_input_tokens),
    output: count(u.output_tokens),
    model: typeof m.model === 'string' && m.model !== '' ? m.model : undefined,
    sidechain: o.isSidechain === true,
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
 * The context window for a call's model, or undefined when it is not known. `launchModel` is the
 * model the session started with (`--model`, else `ANTHROPIC_MODEL`): `[1m]` there selects 1M
 * for the 4.6 models. `env` is the Worker's environment, as the matrix records from Claude Code's
 * model-config docs: `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` caps every window at 200K, and
 * `CLAUDE_CODE_MAX_CONTEXT_TOKENS` sets the window of a model Claude Code does not know (applied
 * here only to models not in the table, the scope verified).
 */
export function contextWindow(
  model: string | undefined,
  launchModel: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): number | undefined {
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
  if (entry === undefined) {
    const override = Number(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS);
    return env.CLAUDE_CODE_MAX_CONTEXT_TOKENS && Number.isSafeInteger(override) && override > 0
      ? override
      : undefined;
  }
  const window =
    entry === 'suffix' ? (launchModel?.toLowerCase().endsWith('[1m]') ? M : K200) : entry;
  return env.CLAUDE_CODE_DISABLE_1M_CONTEXT === '1' ? Math.min(window, K200) : window;
}
