import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import {
  type AdapterCapabilities,
  type AgentAdapter,
  type AgentEvent,
  type AgentTerminal,
  type ApprovalDecision,
  AsyncQueue,
  ForkRefusedError,
  type InterruptResult,
  looksSecret,
  ProfileRefusedError,
  redactSecrets,
  type SendOptions,
  type SessionHandle,
  type SessionOptions,
  type SessionState,
  scrubLiterals,
  type UserInput,
  type WorkerEnvPolicy,
  workerEnv,
} from '@tacet/core';
import { promptText } from './adapter.js';
import { loadPty, type Pty, type SpawnPty } from './pty.js';
import { plainText, TerminalBuffer } from './terminal.js';

/**
 * What a CLI with no structured interface supports through the PTY adapter (#15). Its state is
 * read from its output: the turn ends when the CLI shows its ready prompt again (or goes quiet),
 * and that turn's output is the reply, once, as one delta. It cannot be asked for approvals. It is
 * resumed only if its preset has `resumeArgs` (`capabilities()` then reports `resume`).
 * `modelSwitch` is `launch-only` because the preset's command fixes the model: `start({ model })`
 * is refused, never ignored.
 */
export const PTY_CLI_CAPABILITIES: AdapterCapabilities = {
  streaming: false,
  liveInput: false,
  approvals: 'none',
  interrupt: 'turn',
  resume: false,
  fork: 'none',
  usage: { live: false, context: false, cost: 'none' },
  modelSwitch: 'launch-only',
  injectContext: false,
};

/** A CLI to run in a PTY: the `agents.<slug>` preset of kind `pty` (config). */
export interface PtyPreset {
  /** argv; the first element is the executable. */
  command: string[];
  /** Fixed environment for the CLI (secret references resolved by the caller). */
  env?: Record<string, string>;
  /**
   * Values the caller resolved from secret references: scrubbed from every event. Values of
   * variables whose name looks secret are scrubbed too, listed here or not. Values shorter than
   * four characters are not.
   */
  secrets?: string[];
  /**
   * Text the CLI shows when it waits for input, e.g. `> `: the turn ends when the last line of
   * output is this prompt. Without it, a pause of `quietMs` ends the turn, which is unreliable for
   * a CLI that can think silently for longer than that.
   */
  readyPrompt?: string;
  /**
   * Arguments appended after `command` to continue the CLI's most recent session in the working
   * directory (#157). Only for a CLI whose resume is scoped to its working directory: one that
   * picks the latest session of a wider scope could continue another Worker's session. Checked
   * per worktree on Linux (#168): `['resume', '--last']` for codex-cli 0.167.0 (live, in a PTY),
   * `['--resume', 'latest']` for Gemini CLI 0.67.0 (live with `-p`, and from the bundle's code for
   * interactive use); with nothing saved there, both start a fresh session. A Codex preset's
   * command also passes `-c features.daemon_auto_start=false`: interactive Codex otherwise starts
   * a managed daemon, shared per `CODEX_HOME`, that outlives the session (#171). Tacet resumes a
   * Worker only in the checkout it ran in, so "the last session here" is that checkout's, which
   * can be an earlier attempt's. A generic CLI has no session id Tacet can read, so
   * `vendorSessionId` is a marker, set at start.
   */
  resumeArgs?: string[];
  /**
   * For Gemini CLI (#245), which reads files named in a prompt into it with `ReadManyFiles`: a
   * file in the workspace without asking, one outside after a confirmation whose default is Yes
   * (the next Enter Tacet types would accept it). Two routes, both closed: an `@path` (also an
   * `@agent` or MCP `@resource`), so every `@` is typed as `\@`, which Gemini takes as a literal
   * at sign and sends as typed; and a paste made only of existing file paths (`./a.txt`, a quoted
   * path), which Gemini turns into `@path` itself, so the prompt starts with `. ` and ends with
   * ` .`: a segment that is a directory, never a file, which nothing before it can join (an
   * unclosed quote or a trailing backslash in the text could join the suffix onto a path), and
   * which the suffix keeps from ending in a backslash (Enter would add a newline). Verified live on Gemini CLI 0.67.0 against a local mock of
   * its API (capability matrix, "Generic PTY presets: `@path` mentions").
   */
  escapeAt?: boolean;
  /**
   * For Codex CLI (#249), whose composer reads two things into a paste. A paste that ends in an
   * `@token` leaves its Mentions popup open, and the Enter Tacet types then inserts a completion
   * instead of submitting; a trailing space keeps it closed, and Codex trims it, so the text is
   * sent unchanged. A paste that Codex reads as one image path (`codexReadsAsPath`) is attached
   * as an image, inside the checkout or not; such a prompt gets a first line saying it is text,
   * after which it is several words. Verified live on Codex CLI 0.167.0 against a local mock of
   * its API (capability matrix, "Generic PTY presets: `@path` mentions").
   */
  codexPaste?: boolean;
}

/** `vendorSessionId` of a session whose CLI resumes by `resumeArgs`: there is no real id. */
export const PTY_LAST_SESSION = 'pty:last-in-checkout';

export interface PtyCliAdapterOptions {
  /** The preset's slug: the adapter is `pty:<slug>`. */
  slug: string;
  preset: PtyPreset;
  /** The user's environment, which the CLI gets an allowlist of (#147). Default `process.env`. */
  baseEnv?: Record<string, string | undefined>;
  envPolicy?: WorkerEnvPolicy;
  onEnvDropped?: (names: string[]) => void;
  /** Milliseconds the output must stay unchanged before a prompt or a turn's end counts. Default 800. */
  quietMs?: number;
  /** Milliseconds after an interrupt for the CLI to show its prompt again. Default 10000. */
  settleTimeoutMs?: number;
  /**
   * Milliseconds of silence without the ready prompt after which a turn is reported as
   * `waiting_input` (the CLI may be asking something in the terminal). Default 60000.
   */
  stallMs?: number;
  /** Milliseconds `start()` waits for the CLI to be ready. Default 30000. */
  startTimeoutMs?: number;
  /** Milliseconds to wait after SIGTERM before SIGKILL. Default 5000. */
  killTimeoutMs?: number;
  cols?: number;
  rows?: number;
  /** Replaces node-pty; for tests. */
  spawn?: SpawnPty;
}

interface Session {
  handle: SessionHandle;
  pty: Pty;
  events: AsyncQueue<AgentEvent>;
  state: SessionState;
  screen: TerminalBuffer;
  /**
   * Raw output since the current turn's input was typed (bounded). Kept raw and made plain text
   * only when read, so an escape sequence split across two chunks is still recognised.
   */
  turnOutput: string;
  /** Raw recent output, to find the ready prompt (bounded). */
  tail: string;
  lastOutputAt: number;
  /** Chunks of output so far: "output since X" compares these, not clock times. */
  outputs: number;
  /** A turn is in progress (`running`, or `waiting_input` after a stall). */
  inTurn: boolean;
  /** The turn went quiet without the prompt and was reported waiting. */
  stalled: boolean;
  /** `outputs` when the stall was reported. */
  stalledOutputs: number;
  /** After an interrupt, until the CLI shows its prompt again: input sent meanwhile is queued. */
  cancelledAt: number;
  /** `outputs` when the interrupt was sent. */
  cancelledOutputs: number;
  /** Literal values scrubbed from every event. */
  secrets: string[];
  /** The CLI turned on bracketed paste: several lines can go as one paste. */
  pasteMode: boolean;
  /** The text typed for the current turn, to leave its echo out of the reply. */
  typed: string;
  queue: string[];
  poll: NodeJS.Timeout | undefined;
  exited: Promise<void>;
  exit?: { exitCode: number };
  closing: boolean;
  ended: boolean;
}

const MAX_TEXT = 64 * 1024;
/**
 * Shorter secret values are not scrubbed: replacing every occurrence of one to three characters
 * would garble the reply and hide almost nothing.
 */
const MIN_SECRET = 4;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const deadline = (ms: number) => new Promise((r) => setTimeout(r, ms).unref());

/**
 * Runs any interactive CLI in a pseudo-terminal (#15), configured by a preset after Gas Town's
 * agent provider presets (command, ready prompt; ADR-001: the idea, not the code). The CLI gets
 * an allowlist of the user's environment plus its preset's own variables; it gets no Tacet MCP
 * server, since there is no known way to configure one for an arbitrary CLI.
 */
export class PtyCliAdapter implements AgentAdapter {
  readonly id: string;
  readonly #opts: PtyCliAdapterOptions;

  /** The preset this adapter runs, read-only. */
  get preset(): Readonly<PtyPreset> {
    return this.#opts.preset;
  }
  readonly #sessions = new Map<string, Session>();

  constructor(opts: PtyCliAdapterOptions) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(opts.slug))
      throw new Error(`invalid preset slug ${opts.slug}`);
    if (opts.preset.command.length === 0 || opts.preset.command.some((a) => a === '')) {
      throw new Error(`pty:${opts.slug}: command must be a non-empty list of strings`);
    }
    const resume = opts.preset.resumeArgs;
    if (resume !== undefined && (resume.length === 0 || resume.some((a) => a === ''))) {
      throw new Error(`pty:${opts.slug}: resume arguments must be a non-empty list of strings`);
    }
    this.#opts = opts;
    this.id = `pty:${opts.slug}`;
  }

  capabilities(): AdapterCapabilities {
    return {
      ...structuredClone(PTY_CLI_CAPABILITIES),
      resume: this.#opts.preset.resumeArgs !== undefined,
    };
  }

  async start(opts: SessionOptions): Promise<SessionHandle> {
    if (opts.model !== undefined) {
      throw new ProfileRefusedError('model', `${this.id} cannot choose a model`);
    }
    if (opts.effort !== undefined) {
      throw new ProfileRefusedError('effort', `${this.id} does not set an effort`);
    }
    if (opts.contextWindow !== undefined) {
      throw new ProfileRefusedError('contextWindow', `${this.id} does not set a context size`);
    }
    const resumeArgs = this.#opts.preset.resumeArgs;
    if (opts.resume && !resumeArgs) throw new Error(`${this.id} does not resume sessions`);
    if (opts.resume?.fork) throw new ForkRefusedError(this.id, `${this.id} cannot fork a session`);
    if (opts.mcpServers?.length) {
      throw new Error(
        `${this.id} cannot be given MCP servers: a generic CLI has no known way to take them`,
      );
    }
    const spawn = this.#opts.spawn ?? (await loadPty());
    const preset = this.#opts.preset;
    const filtered = workerEnv(
      this.#opts.baseEnv ?? process.env,
      { names: Object.keys(preset.env ?? {}) },
      this.#opts.envPolicy,
    );
    this.#opts.onEnvDropped?.(filtered.dropped);
    const env: Record<string, string> = {
      ...filtered.env,
      ...preset.env,
      ...Object.fromEntries(
        Object.entries(opts.env ?? {}).filter((e): e is [string, string] => e[1] !== undefined),
      ),
    };
    env.TERM ??= 'xterm-256color';
    // Longest first, so a secret that starts another does not leave that one's end showing.
    const secrets = [
      ...new Set([
        ...(preset.secrets ?? []),
        ...Object.entries(env)
          .filter(([k]) => looksSecret(k))
          .map(([, v]) => v),
      ]),
    ]
      .filter((v) => v.length >= MIN_SECRET)
      .sort((a, b) => b.length - a.length);
    const cols = this.#opts.cols ?? 200;
    const rows = this.#opts.rows ?? 50;
    const [file, ...command] = preset.command as [string, ...string[]];
    const args = opts.resume && resumeArgs ? [...command, ...resumeArgs] : command;
    const pty = spawn(file, args, { cwd: realpathSync(opts.cwd), env, cols, rows });
    let resolveExit!: () => void;
    const exited = new Promise<void>((r) => {
      resolveExit = r;
    });
    const handle: SessionHandle = {
      id: randomUUID(),
      // Resumable: the daemon records a vendor session only when there is one to resume.
      ...(resumeArgs ? { vendorSessionId: PTY_LAST_SESSION } : {}),
    };
    const s: Session = {
      handle,
      pty,
      events: new AsyncQueue(),
      state: 'idle',
      screen: new TerminalBuffer(cols, rows),
      turnOutput: '',
      tail: '',
      lastOutputAt: 0,
      outputs: 0,
      inTurn: false,
      stalled: false,
      stalledOutputs: 0,
      cancelledAt: 0,
      cancelledOutputs: 0,
      secrets,
      pasteMode: false,
      typed: '',
      queue: [],
      poll: undefined,
      exited,
      closing: false,
      ended: false,
    };
    pty.onData((d) => {
      s.lastOutputAt = Date.now();
      s.outputs++;
      s.screen.push(d);
      if (d.includes('\x1b[?2004h')) s.pasteMode = true;
      if (d.includes('\x1b[?2004l')) s.pasteMode = false;
      s.tail = (s.tail + d).slice(-8192);
      if (s.inTurn) s.turnOutput = (s.turnOutput + d).slice(-MAX_TEXT);
    });
    pty.onExit((e) => {
      s.exit = e;
      resolveExit();
      this.#onExit(s);
    });
    const timeout = this.#opts.startTimeoutMs ?? 30_000;
    const by = Date.now() + timeout;
    while (!this.#readyNow(s)) {
      if (s.exit || Date.now() > by) {
        const exit = s.exit;
        await this.#terminate(s);
        throw new Error(
          exit
            ? `${this.id} exited during start (code ${exit.exitCode})`
            : `${this.id} did not become ready within ${timeout} ms`,
        );
      }
      await sleep(50);
    }
    this.#sessions.set(handle.id, s);
    this.#emit(s, { t: 'status', state: 'idle' });
    return handle;
  }

  async send(h: SessionHandle, input: UserInput, opts: SendOptions = {}): Promise<void> {
    const s = this.#live(h);
    if (opts.model !== undefined) {
      throw new ProfileRefusedError('model', `${this.id} cannot choose a model`);
    }
    if (opts.effort !== undefined) {
      throw new ProfileRefusedError('effort', `${this.id} does not set an effort`);
    }
    const typed = promptText(input.text);
    const escaped = this.#opts.preset.escapeAt ? `. ${typed.replaceAll('@', '\\@')} .` : typed;
    // Both can be set (a command running both CLIs): the escaped text is several words, so safe.
    const text = this.#opts.preset.codexPaste ? codexPasteText(escaped) : escaped;
    // A stalled turn may be asking something (a `[y/N]`): the input is its answer, typed now.
    if (s.stalled) {
      s.stalled = false;
      this.#setState(s, 'running');
      s.pty.write(`${this.#line(s, text)}\r`);
      return;
    }
    // During a turn, and after an interrupt until the CLI takes input again.
    if (s.inTurn || s.cancelledAt !== 0) {
      s.queue.push(text);
      return;
    }
    this.#type(s, text);
  }

  async interrupt(h: SessionHandle): Promise<InterruptResult> {
    const s = this.#live(h);
    s.queue.length = 0;
    if (!s.inTurn) return {};
    clearInterval(s.poll);
    // Ctrl-C: a line-based CLI drops the turn and shows its prompt again. Until it does, it may
    // still print the turn's output and ignore input, so input sent meanwhile waits.
    s.pty.write('\x03');
    s.inTurn = false;
    s.cancelledAt = Date.now();
    s.cancelledOutputs = s.outputs;
    this.#setState(s, 'cancelled');
    const settleMs = this.#opts.settleTimeoutMs ?? 10_000;
    s.poll = setInterval(() => {
      if (s.ended || s.closing) return clearInterval(s.poll);
      if (this.#readyNow(s, s.cancelledOutputs)) {
        clearInterval(s.poll);
        s.cancelledAt = 0;
        const next = s.queue.shift();
        if (next !== undefined) this.#type(s, next);
        return;
      }
      if (Date.now() - s.cancelledAt < settleMs) return;
      clearInterval(s.poll);
      s.cancelledAt = 0;
      const dropped = s.queue.length;
      s.queue.length = 0;
      this.#setState(
        s,
        'waiting_input',
        `${this.id} did not show its prompt after the interrupt; check the terminal` +
          (dropped > 0 ? ` (${dropped} input(s) sent meanwhile were not typed)` : ''),
      );
    }, 50);
    s.poll.unref();
    return {};
  }

  async respond(_h: SessionHandle, requestId: string, _d: ApprovalDecision): Promise<void> {
    throw new Error(`${this.id} sends no approval requests (${requestId})`);
  }

  async close(h: SessionHandle): Promise<void> {
    const s = this.#sessions.get(h.id);
    if (!s || s.closing) return;
    s.closing = true;
    clearInterval(s.poll);
    await this.#terminate(s);
    this.#setState(s, 'done');
    s.events.end();
    s.screen.end();
    this.#sessions.delete(h.id);
  }

  events(h: SessionHandle): AsyncIterable<AgentEvent> {
    const s = this.#sessions.get(h.id);
    if (!s) throw new Error(`unknown session ${h.id}`);
    return s.events;
  }

  status(h: SessionHandle): SessionState {
    return this.#sessions.get(h.id)?.state ?? 'done';
  }

  terminal(h: SessionHandle): AgentTerminal {
    const s = this.#sessions.get(h.id);
    if (!s) throw new Error(`unknown session ${h.id}`);
    return s.screen;
  }

  // ---- internals -------------------------------------------------------------------------

  /**
   * The CLI waits for input: there was output after the first `since` chunks, it stayed still, and
   * the prompt is shown.
   */
  #readyNow(s: Session, since = 0): boolean {
    if (s.outputs <= since) return false;
    if (Date.now() - s.lastOutputAt < (this.#opts.quietMs ?? 800)) return false;
    return this.#promptShown(s);
  }

  /** The last line of output is the ready prompt (always true without one). */
  #promptShown(s: Session): boolean {
    const prompt = this.#opts.preset.readyPrompt?.trim();
    if (!prompt) return true;
    const text = plainText(s.tail).trimEnd();
    return text.slice(text.lastIndexOf('\n') + 1).trim() === prompt;
  }

  /**
   * Type a prompt and watch for the end of its turn. Several lines go as one bracketed paste if
   * the CLI turned that on; otherwise they are joined by spaces, since a line-based CLI would
   * take each line as its own input.
   */
  /** Text as typed: one paste if the CLI turned that on, else one line. */
  #line(s: Session, text: string): string {
    // Outside a paste, a tab is a key (completion in a readline-style CLI): type a space.
    return s.pasteMode
      ? `\x1b[200~${text}\x1b[201~`
      : text.replace(/\s*\n\s*/g, ' ').replace(/\t/g, ' ');
  }

  #type(s: Session, text: string): void {
    const line = this.#line(s, text);
    // A space a preset adds at the end (`codexPaste`) is not echoed: matched without it.
    s.typed = s.pasteMode ? text.trimEnd() : line;
    s.turnOutput = '';
    s.inTurn = true;
    s.stalled = false;
    this.#setState(s, 'running');
    const typedAt = Date.now();
    const typedOutputs = s.outputs;
    s.pty.write(`${line}\r`);
    clearInterval(s.poll);
    const stallMs = this.#opts.stallMs ?? 60_000;
    s.poll = setInterval(() => {
      if (!s.inTurn || s.ended || s.closing) return clearInterval(s.poll);
      if (this.#readyNow(s, typedOutputs)) {
        clearInterval(s.poll);
        this.#endTurn(s);
        return;
      }
      if (s.stalled) {
        // Output again after a stall: the turn goes on.
        if (s.outputs > s.stalledOutputs) {
          s.stalled = false;
          this.#setState(s, 'running');
        }
      } else if (Date.now() - Math.max(s.lastOutputAt, typedAt) >= stallMs) {
        s.stalled = true;
        s.stalledOutputs = s.outputs;
        this.#setState(
          s,
          'waiting_input',
          `no prompt from ${this.id} for ${Math.round(stallMs / 1000)} s; it may be asking something: the next input is typed as the answer, or interrupt the turn`,
        );
      }
    }, 50);
    s.poll.unref();
  }

  #endTurn(s: Session): void {
    s.inTurn = false;
    s.stalled = false;
    // Leave out the echo of what was typed, and the prompt the CLI showed again.
    let reply = stripEcho(plainText(s.turnOutput), s.typed).trimEnd();
    const prompt = this.#opts.preset.readyPrompt?.trim();
    const last = reply.lastIndexOf('\n') + 1;
    if (prompt && reply.slice(last).trim() === prompt) reply = reply.slice(0, last);
    reply = reply.trim();
    if (reply) this.#emit(s, { t: 'message.delta', text: reply });
    this.#setState(s, 'idle');
    const next = s.queue.shift();
    if (next !== undefined) this.#type(s, next);
  }

  #onExit(s: Session): void {
    clearInterval(s.poll);
    if (s.closing || s.ended || !this.#sessions.has(s.handle.id)) return;
    s.ended = true;
    this.#setState(s, 'error', `${this.id} exited (code ${s.exit?.exitCode ?? 'unknown'})`);
    s.events.end();
    s.screen.end();
  }

  /** End the process group: SIGTERM, then SIGKILL. node-pty makes the child a session leader. */
  async #terminate(s: Session): Promise<void> {
    const signal = (sig: NodeJS.Signals) => {
      try {
        process.kill(-s.pty.pid, sig);
      } catch {
        if (s.exit) return;
        try {
          s.pty.kill(sig);
        } catch {
          // Gone.
        }
      }
    };
    signal('SIGTERM');
    if (s.exit) return;
    const gone = await Promise.race([
      s.exited.then(() => true),
      deadline(this.#opts.killTimeoutMs ?? 5000).then(() => false),
    ]);
    if (!gone) {
      signal('SIGKILL');
      await Promise.race([s.exited, deadline(1000)]);
    }
  }

  /** Known key formats, and the session's own secret values, are scrubbed from every event. */
  #emit(s: Session, e: AgentEvent): void {
    // Literal values first: a pattern that matched only part of one would leave the rest.
    s.events.push(redactSecrets(scrubLiterals(e, s.secrets)));
  }

  #setState(s: Session, state: SessionState, message?: string): void {
    s.state = state;
    this.#emit(s, { t: 'status', state, ...(message !== undefined ? { message } : {}) });
  }

  #live(h: SessionHandle): Session {
    const s = this.#sessions.get(h.id);
    if (!s || s.closing) throw new Error(`unknown or closed session ${h.id}`);
    if (s.ended) throw new Error(`session ${h.id} has ended (${s.state})`);
    return s;
  }
}

/**
 * The reply without the echo of the typed input at its start. The echo may be wrapped at the
 * terminal's width, which puts line breaks (and, for some line editors, a space before them)
 * inside it; it starts within the first few characters (a `^C` or prompt redraw before it).
 */
export function stripEcho(reply: string, typed: string): string {
  if (!typed) return reply;
  for (let start = 0; start <= Math.min(16, reply.length); start++) {
    let i = start;
    let j = 0;
    while (j < typed.length && i < reply.length) {
      if (reply[i] === typed[j]) {
        i++;
        j++;
      } else if (reply[i] === '\n' || (reply[i] === ' ' && reply[i + 1] === '\n')) i++;
      else break;
    }
    if (j === typed.length) return reply.slice(i);
  }
  return reply;
}

/** What Codex CLI is pasted for `text` (`PtyPreset.codexPaste`, #249). */
export function codexPasteText(text: string): string {
  // Before the text, so the paste starts with neither a quote, `file:` nor a drive letter.
  const body = codexReadsAsPath(text)
    ? `(This message is text, not a file to attach.)\n${text}`
    : text;
  return `${body} `;
}

/** Extensions the `image` crate 0.25.9 (Codex 0.167.0's) decodes: `ImageFormat::from_extension`. */
const IMAGE_EXTENSION =
  /\.(avif|jpe?g|jfif|a?png|gif|webp|tiff?|tga|dds|bmp|ico|hdr|exr|p[abgnp]m|ff|qoi)$/i;

/**
 * Whether Codex CLI 0.167.0 would attach a paste of `text` as an image (#249). Its composer
 * (`apply_paste` in `chat_composer/paste_input.rs`) checks a paste of 2 to 1000 characters with
 * `normalize_pasted_path` (`clipboard_paste.rs`): after trimming, a string in matching quotes, a
 * `file:` URL (the URL parser drops tabs and newlines anywhere), a Windows path, or exactly one
 * word as the Rust `shlex` crate splits it (a `#` starting a word comments out its line). It then
 * attaches the file when the `image` crate decodes it, whose format comes from the extension
 * alone (`ImageReader::open`). So: any `file:` URL (it can hide its extension), or such a path
 * ending in an image extension once quotes, backslashes, tabs and newlines are taken out. Errs
 * towards yes; a word like `continue` or `y` is not one.
 */
export function codexReadsAsPath(text: string): boolean {
  const t = text.trim();
  if (/^file:/i.test(t.replace(/[\t\n\r]/g, ''))) return true;
  const onePath =
    /^(["'])[\s\S]*\1$/.test(t) || /^[A-Za-z]:[\\/]|^\\\\/.test(t) || shellWords(t) <= 1;
  return onePath && IMAGE_EXTENSION.test(t.replace(/[\t\n\r\\'"]/g, ''));
}

/** How many words a POSIX shell splitter like the Rust `shlex` crate yields before an error. */
function shellWords(text: string): number {
  let words = 0;
  let i = 0;
  const n = text.length;
  const space = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
  while (i < n) {
    while (i < n && space(text[i])) i++;
    if (i >= n) break;
    if (text[i] === '#') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    // One word, up to unquoted whitespace.
    while (i < n && !space(text[i])) {
      const c = text[i];
      if (c === '\\') {
        if (i + 1 >= n) return words; // A trailing backslash is an error: no more words.
        i += 2;
      } else if (c === "'") {
        const end = text.indexOf("'", i + 1);
        if (end < 0) return words;
        i = end + 1;
      } else if (c === '"') {
        i++;
        while (i < n && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
        if (i >= n) return words;
        i++;
      } else {
        i++;
      }
    }
    words++;
  }
  return words;
}
