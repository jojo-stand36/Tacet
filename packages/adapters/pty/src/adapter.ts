import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authEnv, claudeEnvAllow, writeMcpConfig } from '@tacet/adapter-claude-sdk/launch';
import {
  type AdapterCapabilities,
  type AgentAdapter,
  type AgentEvent,
  type ApprovalDecision,
  AsyncQueue,
  type InterruptResult,
  mcpHeaderSecrets,
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
import {
  defaultStateDir,
  removeSessionFile,
  repoStateDir,
  sweepStaleSessionFiles,
  writeSessionFile,
} from '@tacet/core/node';
import {
  allowPermission,
  type ClaudeHook,
  claudeArgs,
  claudeHookSettings,
  denyPermission,
  parseClaudeHook,
  prepareClaudeConfigDir,
  preToolUseDecision,
} from './claude.js';
import { type HookBody, HookServer } from './hook-server.js';
import { loadPty, type Pty, type SpawnPty } from './pty.js';

/**
 * What interactive Claude Code in a PTY honestly supports (#15), verified on 2.1.319:
 * - no streaming: the reply's text arrives once, from the `Stop` hook (`last_assistant_message`);
 * - approvals round-trip through the `PermissionRequest` hook (allow or deny answered over HTTP);
 * - Esc ends a turn (the binary sends no `Stop` for it, so the adapter reports `cancelled`);
 * - resume by session id (`--resume`) in the session's own config directory; no fork yet;
 * - no usage: the hooks carry no token counts;
 * - the model is chosen at launch (`--model`).
 */
export const CLAUDE_PTY_CAPABILITIES: AdapterCapabilities = {
  streaming: false,
  liveInput: false,
  approvals: 'roundtrip',
  interrupt: 'turn',
  resume: true,
  fork: 'none',
  usage: { live: false, context: false, cost: 'none' },
  modelSwitch: 'launch-only',
  injectContext: false,
};

export interface PtyAdapterOptions {
  /** The `claude` executable (and any leading arguments). Default `['claude']` on PATH. */
  command?: string[];
  /** The user's environment, which the Worker gets an allowlist of. Default `process.env`. */
  baseEnv?: Record<string, string | undefined>;
  /** Which of `baseEnv` the Worker gets (#147). Default: the allowlist. */
  envPolicy?: WorkerEnvPolicy;
  /** Told the names (never values) of the variables left out of each session's environment. */
  onEnvDropped?: (names: string[]) => void;
  /** The repo the Workers belong to; keys the state directory. Default: the session's cwd. */
  repoRoot?: string;
  /** Tacet's state directory. Default `~/.tacet/state`. */
  stateDir?: string;
  /** Directory for per-session secret files (hook settings, MCP config). Default core's. */
  sessionFileDir?: string;
  /** Milliseconds `start()` waits for the session to report it is ready. Default 30000. */
  startTimeoutMs?: number;
  /**
   * Milliseconds a typed prompt may go unacknowledged (no `UserPromptSubmit`) before the session
   * is reported as `waiting_input`: something in the terminal holds it up. Default 15000.
   */
  ackTimeoutMs?: number;
  /** Name of Tacet's own MCP server in the Worker's config: its tools never ask. Default `tacet`. */
  tacetMcpServer?: string;
  /** Milliseconds to wait after SIGTERM before SIGKILL. Default 5000. */
  killTimeoutMs?: number;
  /** Terminal size. Default 200 × 50. */
  cols?: number;
  rows?: number;
  /** Replaces node-pty; for tests. */
  spawn?: SpawnPty;
}

interface PendingApproval {
  reply: (out?: object) => void;
  toolUseId: string | undefined;
}

/** A tool call that started (`PreToolUse`) and has no result yet. */
interface OpenTool {
  id: string;
  name: string;
  /** Its input, as stable JSON: a `PermissionRequest` carries no tool id, only name and input. */
  input: string;
}

interface Session {
  handle: SessionHandle;
  pty: Pty;
  events: AsyncQueue<AgentEvent>;
  state: SessionState;
  secrets: string[];
  hookKey: string;
  files: string[];
  approvals: Map<string, PendingApproval>;
  /** Tool calls that started and have no result yet, oldest first. */
  openTools: OpenTool[];
  /** The `prompt_id` of the turn in progress, from its `UserPromptSubmit`. */
  promptId: string | undefined;
  /** A prompt is being typed: input sent meanwhile is queued. */
  typing: boolean;
  /** Fires when a typed prompt was not acknowledged in time. */
  ackTimer: NodeJS.Timeout | undefined;
  /** Tool calls whose result was reported. */
  finished: Set<string>;
  queue: string[];
  /** When Esc was last written: a key right after it would read as Alt+key. */
  escAt: number;
  ready: () => void;
  exited: Promise<void>;
  exit?: { exitCode: number; signal?: number };
  closing: boolean;
  ended: boolean;
}

const ESC = '\x1b';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A timer that never keeps the process alive, for deadlines raced against other promises. */
const deadline = (ms: number) => new Promise((r) => setTimeout(r, ms).unref());

/** The hook forwarder's entry point: the compiled `.js`, or the `.ts` source in a checkout. */
function forwardScript(): string {
  const js = fileURLToPath(new URL('./hook-forward.js', import.meta.url));
  return existsSync(js) ? js : fileURLToPath(new URL('./hook-forward.ts', import.meta.url));
}

const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/**
 * Runs interactive Claude Code in a pseudo-terminal and derives its state from Claude Code's
 * hooks (#15): the fallback for a CLI with no structured interface. Each session has its own
 * process group, its own Claude config directory, and a 0600 hook settings file outside the
 * worktree holding its hook token. Workers use an API key only (owner decision 2026-11-09): the
 * PTY route never runs an unattended Worker on a subscription login.
 */
export class PtyAdapter implements AgentAdapter {
  readonly id = 'pty:claude';
  readonly #opts: PtyAdapterOptions;
  readonly #sessions = new Map<string, Session>();
  readonly #hooks = new HookServer();
  #swept = false;

  constructor(opts: PtyAdapterOptions = {}) {
    this.#opts = opts;
  }

  capabilities(): AdapterCapabilities {
    return structuredClone(CLAUDE_PTY_CAPABILITIES);
  }

  async start(opts: SessionOptions): Promise<SessionHandle> {
    if (opts.effort !== undefined) {
      throw new ProfileRefusedError('effort', 'the PTY adapter does not set an effort');
    }
    if (opts.contextWindow !== undefined) {
      throw new ProfileRefusedError('contextWindow', 'the PTY adapter does not set a context size');
    }
    if (opts.resume?.fork) throw new Error('the PTY adapter does not fork sessions');
    // It names a directory and goes on the command line: only a session id Claude Code made.
    if (opts.resume && !UUID.test(opts.resume.vendorSessionId)) {
      throw new Error('a PTY session to resume is named by its UUID');
    }
    const spawn = this.#opts.spawn ?? (await loadPty());
    if (!this.#swept) {
      this.#swept = true;
      try {
        sweepStaleSessionFiles(this.#opts.sessionFileDir);
      } catch {
        // Tried again by the next adapter that starts.
      }
    }

    // Environment: the allowlist of the user's (#147), checked for an API key, then Tacet's own.
    const base = this.#opts.baseEnv ?? process.env;
    const filtered = workerEnv(
      base,
      claudeEnvAllow({ ...base, ...opts.env }),
      this.#opts.envPolicy,
    );
    this.#opts.onEnvDropped?.(filtered.dropped);
    const env = authEnv('api_key', { ...filtered.env, ...opts.env });

    const vendorSessionId = opts.resume?.vendorSessionId ?? randomUUID();
    const handle: SessionHandle = { id: randomUUID(), vendorSessionId };
    const cwd = realpathSync(opts.cwd);
    const home = env.HOME ?? homedir();
    const configDir = join(
      repoStateDir(this.#opts.repoRoot ?? cwd, this.#opts.stateDir ?? defaultStateDir(home)),
      'claude-pty',
      vendorSessionId,
    );
    if (opts.resume && !existsSync(configDir)) {
      throw new Error(`no PTY session ${vendorSessionId} to resume`);
    }
    prepareClaudeConfigDir(configDir, {
      cwd,
      ...(env.ANTHROPIC_API_KEY ? { apiKey: env.ANTHROPIC_API_KEY } : {}),
    });

    const files: string[] = [];
    const fileOpts = {
      worktree: cwd,
      ...(this.#opts.sessionFileDir !== undefined ? { dir: this.#opts.sessionFileDir } : {}),
    };
    let s: Session | undefined;
    let ready!: () => void;
    const readyP = new Promise<void>((r) => {
      ready = r;
    });
    const early: HookBody[] = [];
    const reg = await this.#hooks.register((body, reply, onAbort) => {
      if (s) this.#onHook(s, body, reply, onAbort);
      else {
        early.push(body);
        reply();
      }
    });
    const secrets = [reg.token.reveal(), ...mcpHeaderSecrets(opts.mcpServers)];
    try {
      const hookFile = writeSessionFile(
        `${handle.id}.hook.json`,
        JSON.stringify({ url: `${reg.url}/SessionStart`, token: reg.token.reveal() }),
        fileOpts,
      );
      files.push(hookFile);
      const forward = `${shellQuote(process.execPath)} ${shellQuote(forwardScript())} ${shellQuote(hookFile)}`;
      const settingsPath = writeSessionFile(
        `${handle.id}.settings.json`,
        JSON.stringify(claudeHookSettings({ url: reg.url, token: reg.token.reveal(), forward })),
        fileOpts,
      );
      files.push(settingsPath);
      let mcpConfigPath: string | undefined;
      if (opts.mcpServers?.length) {
        mcpConfigPath = writeMcpConfig(opts.mcpServers, {
          sessionId: handle.id,
          ...fileOpts,
        });
        files.push(mcpConfigPath);
      }
      const command = this.#opts.command ?? ['claude'];
      const args = [
        ...command.slice(1),
        ...claudeArgs({
          settingsPath,
          ...(opts.resume ? { resume: vendorSessionId } : { sessionId: vendorSessionId }),
          ...(opts.model !== undefined ? { model: opts.model } : {}),
          ...(mcpConfigPath ? { mcpConfigPath } : {}),
        }),
      ];
      const ptyEnv: Record<string, string> = {
        ...env,
        CLAUDE_CONFIG_DIR: configDir,
        TERM: env.TERM ?? 'xterm-256color',
        // The hook endpoint is local: never through a proxy the user has set.
        NO_PROXY: [env.NO_PROXY, '127.0.0.1'].filter(Boolean).join(','),
        no_proxy: [env.no_proxy, '127.0.0.1'].filter(Boolean).join(','),
      };
      const pty = spawn(command[0] ?? 'claude', args, {
        cwd,
        env: ptyEnv,
        cols: this.#opts.cols ?? 200,
        rows: this.#opts.rows ?? 50,
      });
      let resolveExit!: () => void;
      const exited = new Promise<void>((r) => {
        resolveExit = r;
      });
      s = {
        handle,
        pty,
        events: new AsyncQueue(),
        state: 'idle',
        secrets,
        hookKey: reg.key,
        files,
        approvals: new Map(),
        openTools: [],
        promptId: undefined,
        typing: false,
        ackTimer: undefined,
        finished: new Set(),
        queue: [],
        escAt: 0,
        ready,
        exited,
        closing: false,
        ended: false,
      };
      const session = s;
      // The terminal itself is not an event stream; it is drained so the child never blocks.
      pty.onData(() => {});
      pty.onExit((e) => {
        session.exit = e;
        resolveExit();
        ready();
        this.#onExit(session);
      });
      for (const b of early)
        this.#onHook(
          session,
          b,
          () => {},
          () => {},
        );
      const timeout = this.#opts.startTimeoutMs ?? 30_000;
      const started = await Promise.race([
        readyP.then(() => true),
        deadline(timeout).then(() => false),
      ]);
      if (!started || session.exit) {
        throw new Error(
          session.exit
            ? `claude exited during start (code ${session.exit.exitCode})`
            : `claude did not report ready within ${timeout} ms`,
        );
      }
    } catch (err) {
      if (s) await this.#terminate(s);
      for (const f of files) removeSessionFile(f);
      await this.#hooks.unregister(reg.key);
      throw err;
    }
    this.#sessions.set(handle.id, s);
    this.#emit(s, { t: 'status', state: 'idle' });
    return handle;
  }

  async send(h: SessionHandle, input: UserInput, opts: SendOptions = {}): Promise<void> {
    const s = this.#live(h);
    if (opts.model !== undefined) {
      throw new ProfileRefusedError('model', 'the PTY adapter chooses the model at launch');
    }
    if (opts.effort !== undefined) {
      throw new ProfileRefusedError('effort', 'the PTY adapter does not set an effort');
    }
    const text = promptText(input.text);
    if (s.typing || s.state === 'running' || s.state === 'waiting_input') {
      s.queue.push(text);
      return;
    }
    await this.#type(s, text);
  }

  async interrupt(h: SessionHandle): Promise<InterruptResult> {
    const s = this.#live(h);
    s.queue.length = 0;
    if (s.state !== 'running' && s.state !== 'waiting_input') return {};
    this.#cancelTurn(s);
    return {};
  }

  async respond(h: SessionHandle, requestId: string, decision: ApprovalDecision): Promise<void> {
    const s = this.#live(h);
    const p = s.approvals.get(requestId);
    if (!p) throw new Error(`no pending approval ${requestId}`);
    s.approvals.delete(requestId);
    if (decision.kind === 'allow_once' || decision.kind === 'allow_always') {
      p.reply(allowPermission());
      this.#setState(s, 'running');
      return;
    }
    if (p.toolUseId) this.#toolResult(s, p.toolUseId, false);
    if (decision.kind === 'cancel') {
      // Cancel the turn, not just the tool: a denial that interrupts (verified live, #15).
      p.reply(denyPermission('cancelled by Tacet', true));
      this.#cancelTurn(s, true);
      return;
    }
    p.reply(denyPermission('denied by Tacet'));
    this.#setState(s, 'running');
  }

  async close(h: SessionHandle): Promise<void> {
    const s = this.#sessions.get(h.id);
    if (!s || s.closing) return;
    s.closing = true;
    s.queue.length = 0;
    clearTimeout(s.ackTimer);
    this.#releaseApprovals(s);
    await this.#terminate(s);
    for (const f of s.files) removeSessionFile(f);
    await this.#hooks.unregister(s.hookKey);
    this.#setState(s, 'done');
    s.events.end();
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

  // ---- internals -------------------------------------------------------------------------

  /**
   * Type a prompt as one bracketed paste and submit it. `UserPromptSubmit` acknowledges it; if it
   * does not come in time, something in the terminal holds the prompt up.
   */
  async #type(s: Session, text: string): Promise<void> {
    s.typing = true;
    this.#setState(s, 'running');
    try {
      // A key right after Esc reads as Alt+key.
      const since = Date.now() - s.escAt;
      if (since < 500) await sleep(500 - since);
      if (s.ended || s.closing) return;
      const before = s.promptId;
      s.pty.write(`${PASTE_START}${text}${PASTE_END}`);
      await sleep(100);
      if (s.ended || s.closing) return;
      s.pty.write('\r');
      clearTimeout(s.ackTimer);
      s.ackTimer = setTimeout(() => {
        if (s.promptId === before && s.state === 'running' && !s.ended && !s.closing) {
          this.#setState(s, 'waiting_input', 'the prompt was not taken; check the terminal');
        }
      }, this.#opts.ackTimeoutMs ?? 15_000);
      s.ackTimer.unref();
    } finally {
      s.typing = false;
    }
  }

  /**
   * End the turn in progress. An open permission is denied with `interrupt` (verified live: the
   * turn stops, no `Stop` follows); otherwise Esc, which Claude Code also ends with no `Stop`. So
   * the adapter reports `cancelled` itself, and hooks of that turn arriving later are dropped.
   */
  #cancelTurn(s: Session, interruptedByDenial = false): void {
    s.queue.length = 0;
    if (interruptedByDenial || s.approvals.size > 0) {
      for (const p of s.approvals.values()) {
        if (p.toolUseId) this.#toolResult(s, p.toolUseId, false);
        p.reply(denyPermission('cancelled by Tacet', true));
      }
      s.approvals.clear();
    } else {
      s.pty.write(ESC);
      s.escAt = Date.now();
    }
    clearTimeout(s.ackTimer);
    this.#setState(s, 'cancelled');
  }

  #onHook(
    s: Session,
    body: HookBody,
    reply: (out?: object) => void,
    onAbort: (fn: () => void) => void,
  ): void {
    const ev: ClaudeHook | undefined = parseClaudeHook(body);
    // The token says which session this is; a body naming another session is not ours.
    if (!ev || (ev.session_id !== undefined && ev.session_id !== s.handle.vendorSessionId)) {
      reply();
      return;
    }
    if (s.ended || s.closing) {
      reply();
      return;
    }
    const promptId = typeof body.prompt_id === 'string' ? body.prompt_id : undefined;
    // A turn-scoped hook from another turn than the one in progress (e.g. an interrupted one
    // whose events arrive late) changes nothing.
    const stale =
      ev.hook_event_name !== 'SessionStart' &&
      ev.hook_event_name !== 'UserPromptSubmit' &&
      (s.state === 'cancelled' ||
        (promptId !== undefined && s.promptId !== undefined && promptId !== s.promptId));
    if (stale) {
      if (ev.hook_event_name === 'PreToolUse')
        reply(preToolUseDecision(ev.tool_name, this.#tacetPrefix));
      else if (ev.hook_event_name === 'PermissionRequest') {
        reply(denyPermission('the turn was cancelled', true));
      } else reply();
      return;
    }
    switch (ev.hook_event_name) {
      case 'SessionStart':
        s.ready();
        reply();
        return;
      case 'UserPromptSubmit':
        s.promptId = promptId;
        clearTimeout(s.ackTimer);
        if (s.state !== 'running') this.#setState(s, 'running');
        reply();
        return;
      case 'PreToolUse':
        s.openTools.push({
          id: ev.tool_use_id,
          name: ev.tool_name,
          input: stableJson(ev.tool_input),
        });
        this.#emit(s, {
          t: 'tool.call',
          id: ev.tool_use_id,
          name: ev.tool_name,
          input: ev.tool_input ?? {},
        });
        reply(preToolUseDecision(ev.tool_name, this.#tacetPrefix));
        return;
      case 'PostToolUse':
      case 'PostToolUseFailure':
        this.#toolResult(s, ev.tool_use_id, ev.hook_event_name === 'PostToolUse');
        reply();
        return;
      case 'PermissionRequest': {
        const id = `perm-${randomUUID()}`;
        // The oldest open call with this tool and input; none if nothing matches.
        const input = stableJson(ev.tool_input);
        const tool = s.openTools.find((t) => t.name === ev.tool_name && t.input === input);
        s.approvals.set(id, { reply, toolUseId: tool?.id });
        onAbort(() => {
          // Claude Code stopped waiting (timeout): its own dialog is up in the terminal.
          if (s.approvals.delete(id) && !s.ended && !s.closing) {
            this.#setState(s, 'waiting_input', 'a permission dialog waits in the terminal');
          }
        });
        this.#emit(s, {
          t: 'approval.request',
          id,
          summary: `${ev.tool_name}: ${summarize(ev.tool_input)}`,
          toolName: ev.tool_name,
          options: ['allow_once', 'reject', 'cancel'],
          ...(ev.tool_input !== undefined ? { requestedGrant: { input: ev.tool_input } } : {}),
        });
        this.#setState(s, 'waiting_input');
        return;
      }
      case 'Notification':
        // A dialog Tacet did not answer (e.g. a permission whose hook timed out).
        if (ev.notification_type === 'permission_prompt' && s.approvals.size === 0) {
          this.#setState(s, 'waiting_input', 'a permission dialog waits in the terminal');
        }
        reply();
        return;
      case 'Stop':
        if (ev.last_assistant_message) {
          this.#emit(s, { t: 'message.delta', text: ev.last_assistant_message });
        }
        this.#turnEnded(
          s,
          'idle',
          ev.background_tasks?.length ? 'background tasks still running' : undefined,
        );
        reply();
        return;
      case 'StopFailure':
        this.#turnEnded(s, 'idle', 'the turn failed');
        reply();
        return;
    }
  }

  get #tacetPrefix(): string {
    return `mcp__${this.#opts.tacetMcpServer ?? 'tacet'}__`;
  }

  /** One result per tool call, whichever reports it first (a denial, or the vendor's hook). */
  #toolResult(s: Session, id: string, ok: boolean): void {
    s.openTools = s.openTools.filter((t) => t.id !== id);
    if (s.finished.has(id)) return;
    s.finished.add(id);
    this.#emit(s, { t: 'tool.result', id, ok });
  }

  #turnEnded(s: Session, state: SessionState, message?: string): void {
    clearTimeout(s.ackTimer);
    s.openTools = [];
    this.#setState(s, state, message);
    const next = s.queue.shift();
    if (next !== undefined) void this.#type(s, next);
  }

  /** Let open permission requests go (the session is closing): answered with no decision. */
  #releaseApprovals(s: Session): void {
    for (const p of s.approvals.values()) p.reply();
    s.approvals.clear();
  }

  #onExit(s: Session): void {
    clearTimeout(s.ackTimer);
    if (s.closing || s.ended || !this.#sessions.has(s.handle.id)) return;
    s.ended = true;
    s.approvals.clear();
    this.#setState(s, 'error', `claude exited (code ${s.exit?.exitCode ?? 'unknown'})`);
    s.events.end();
    for (const f of s.files) removeSessionFile(f);
    void this.#hooks.unregister(s.hookKey);
  }

  /** End the process group: SIGTERM, then SIGKILL. node-pty makes the child a session leader. */
  async #terminate(s: Session): Promise<void> {
    if (s.exit) return;
    const signal = (sig: NodeJS.Signals) => {
      try {
        process.kill(-s.pty.pid, sig);
      } catch {
        try {
          s.pty.kill(sig);
        } catch {
          // Gone.
        }
      }
    };
    signal('SIGTERM');
    const timeout = this.#opts.killTimeoutMs ?? 5000;
    const gone = await Promise.race([
      s.exited.then(() => true),
      deadline(timeout).then(() => false),
    ]);
    if (!gone) {
      signal('SIGKILL');
      await Promise.race([s.exited, deadline(1000)]);
    }
  }

  /**
   * Every event leaves through here, scrubbed of known key formats and this session's secrets.
   * A reply arrives whole (from `Stop`), never in pieces, so it is scrubbed as one text: the
   * streaming scrubber would hold back a tail that looks like the start of a secret and so split
   * one reply into two deltas.
   */
  #emit(s: Session, e: AgentEvent): void {
    s.events.push(scrubLiterals(redactSecrets(e), s.secrets));
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
 * The text to type for a prompt. Control characters would act as keys (Esc, Ctrl-C, Ctrl-D, the
 * end of the paste), so only newlines and tabs are kept. A prompt starting with `/` or `!` would
 * run a slash command or, without asking anyone, a shell command (verified live on 2.1.319: a
 * leading `!` runs it with no `UserPromptSubmit`, `PreToolUse` or `PermissionRequest`; a leading
 * space or zero-width character does not stop `/`), so it is refused.
 */
export function promptText(text: string): string {
  const clean = [...text.replace(/\r\n?/g, '\n')]
    .filter((c) => {
      const code = c.codePointAt(0) ?? 0;
      // C0 and C1 controls and DEL, except tab and newline.
      return c === '\t' || c === '\n' || !(code < 0x20 || (code >= 0x7f && code <= 0x9f));
    })
    .join('');
  const first = clean.replace(/^[\s\p{Cf}\p{Z}]+/u, '').charAt(0);
  if (first === '/' || first === '!') {
    throw new Error(
      `a PTY prompt must not start with "${first}": Claude Code would run it as a command`,
    );
  }
  if (clean.trim() === '') throw new Error('a PTY prompt must not be empty');
  return clean;
}

/** JSON with sorted keys, so equal tool inputs compare equal. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/** A short, single-line description of a tool input for an approval summary. */
function summarize(input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    for (const k of ['description', 'command', 'file_path', 'path', 'url']) {
      if (typeof o[k] === 'string') return (o[k] as string).slice(0, 200);
    }
  }
  return JSON.stringify(input ?? {}).slice(0, 200);
}
