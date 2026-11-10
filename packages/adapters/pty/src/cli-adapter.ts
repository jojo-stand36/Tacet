import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import {
  type AdapterCapabilities,
  type AgentAdapter,
  type AgentEvent,
  type AgentTerminal,
  type ApprovalDecision,
  AsyncQueue,
  type InterruptResult,
  ProfileRefusedError,
  redactSecrets,
  type SendOptions,
  type SessionHandle,
  type SessionOptions,
  type SessionState,
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
 * and that turn's output is the reply, once, as one delta. It cannot be asked for approvals, its
 * model cannot be chosen, and it is not resumed.
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
  /** Text the CLI shows when it waits for input, e.g. `> `. Without it, quiet output means ready. */
  readyPrompt?: string;
}

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
  /** Plain text of the output since the current turn's input was typed (bounded). */
  turnOutput: string;
  /** Plain text of the recent output, to find the ready prompt (bounded). */
  tail: string;
  lastOutputAt: number;
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
  readonly #sessions = new Map<string, Session>();

  constructor(opts: PtyCliAdapterOptions) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(opts.slug))
      throw new Error(`invalid preset slug ${opts.slug}`);
    if (opts.preset.command.length === 0 || opts.preset.command.some((a) => a === '')) {
      throw new Error(`pty:${opts.slug}: command must be a non-empty list of strings`);
    }
    this.#opts = opts;
    this.id = `pty:${opts.slug}`;
  }

  capabilities(): AdapterCapabilities {
    return structuredClone(PTY_CLI_CAPABILITIES);
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
    if (opts.resume) throw new Error(`${this.id} does not resume sessions`);
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
    const cols = this.#opts.cols ?? 200;
    const rows = this.#opts.rows ?? 50;
    const [file, ...args] = preset.command as [string, ...string[]];
    const pty = spawn(file, args, { cwd: realpathSync(opts.cwd), env, cols, rows });
    let resolveExit!: () => void;
    const exited = new Promise<void>((r) => {
      resolveExit = r;
    });
    const handle: SessionHandle = { id: randomUUID() };
    const s: Session = {
      handle,
      pty,
      events: new AsyncQueue(),
      state: 'idle',
      screen: new TerminalBuffer(cols, rows),
      turnOutput: '',
      tail: '',
      lastOutputAt: 0,
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
      s.screen.push(d);
      if (d.includes('\x1b[?2004h')) s.pasteMode = true;
      if (d.includes('\x1b[?2004l')) s.pasteMode = false;
      const text = plainText(d);
      s.tail = (s.tail + text).slice(-4096);
      if (s.state === 'running') s.turnOutput = (s.turnOutput + text).slice(-MAX_TEXT);
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
        await this.#terminate(s);
        throw new Error(
          s.exit
            ? `${this.id} exited during start (code ${s.exit.exitCode})`
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
    const text = promptText(input.text);
    if (s.state === 'running') {
      s.queue.push(text);
      return;
    }
    this.#type(s, text);
  }

  async interrupt(h: SessionHandle): Promise<InterruptResult> {
    const s = this.#live(h);
    s.queue.length = 0;
    if (s.state !== 'running') return {};
    clearInterval(s.poll);
    // Ctrl-C: a line-based CLI drops the turn and shows its prompt again.
    s.pty.write('\x03');
    this.#setState(s, 'cancelled');
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

  /** The CLI waits for input: its output stayed still, ending with the ready prompt if set. */
  #readyNow(s: Session, since = 0): boolean {
    if (s.lastOutputAt <= since) return false;
    if (Date.now() - s.lastOutputAt < (this.#opts.quietMs ?? 800)) return false;
    const prompt = this.#opts.preset.readyPrompt?.trimEnd();
    return prompt === undefined || s.tail.trimEnd().endsWith(prompt);
  }

  /**
   * Type a prompt and watch for the end of its turn. Several lines go as one bracketed paste if
   * the CLI turned that on; otherwise they are joined by spaces, since a line-based CLI would
   * take each line as its own input.
   */
  #type(s: Session, text: string): void {
    const line = s.pasteMode ? `\x1b[200~${text}\x1b[201~` : text.replace(/\s*\n\s*/g, ' ');
    s.typed = s.pasteMode ? text : line;
    s.turnOutput = '';
    this.#setState(s, 'running');
    const typedAt = Date.now();
    s.pty.write(`${line}\r`);
    clearInterval(s.poll);
    s.poll = setInterval(() => {
      if (s.state !== 'running' || s.ended || s.closing) return clearInterval(s.poll);
      if (!this.#readyNow(s, typedAt)) return;
      clearInterval(s.poll);
      this.#endTurn(s);
    }, 50);
    s.poll.unref();
  }

  #endTurn(s: Session): void {
    let reply = s.turnOutput.replace(/\r/g, '');
    // Leave out the echo of what was typed, and the prompt the CLI showed again.
    const echo = reply.indexOf(s.typed);
    if (echo !== -1 && echo < 16) reply = reply.slice(echo + s.typed.length);
    const prompt = this.#opts.preset.readyPrompt?.trimEnd();
    reply = reply.trimEnd();
    if (prompt && reply.endsWith(prompt)) reply = reply.slice(0, -prompt.length);
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

  /** Known key formats are scrubbed from everything that leaves as an event. */
  #emit(s: Session, e: AgentEvent): void {
    s.events.push(redactSecrets(e));
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
