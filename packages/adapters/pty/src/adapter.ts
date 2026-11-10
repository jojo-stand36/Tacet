import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  authEnv,
  claudeEnvAllow,
  withSubprocessScrub,
  writeMcpConfig,
} from '@tacet/adapter-claude-sdk/launch';
import {
  type AdapterCapabilities,
  type AgentAdapter,
  type AgentEvent,
  type AgentTerminal,
  type ApprovalDecision,
  AsyncQueue,
  type InterruptResult,
  mcpHeaderSecrets,
  ProfileRefusedError,
  promptCommandPrefix,
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
import { removeClaudeConfigDir, repoOf, sweepClaudeConfigDirs } from './config-dirs.js';
import { type HookBody, HookServer } from './hook-server.js';
import { loadPty, type Pty, type SpawnPty } from './pty.js';
import { TerminalBuffer } from './terminal.js';

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
  /**
   * The repo the Workers belong to; keys the state directory. Default: the repo of the session's
   * cwd (the main checkout, for a git worktree), else the cwd itself.
   */
  repoRoot?: string;
  /** Tacet's state directory. Default `~/.tacet/state`. */
  stateDir?: string;
  /**
   * Days after its last write that a session's Claude config directory (its transcript) is
   * removed, if no Mini-conductor discarded it before (#153). Swept when the adapter starts its
   * first session for a repo. Default 30, as `events.retention.transcript_days`.
   */
  retentionDays?: number;
  /** Directory for per-session secret files (hook settings, MCP config). Default core's. */
  sessionFileDir?: string;
  /** Milliseconds `start()` waits for the session to report it is ready. Default 30000. */
  startTimeoutMs?: number;
  /**
   * Milliseconds a typed prompt may go unacknowledged (no `UserPromptSubmit`) before the session
   * is reported as `waiting_input`: something in the terminal holds it up. Default 15000.
   */
  ackTimeoutMs?: number;
  /**
   * Longest wait after `SessionStart` for the interface to take input (it turns on bracketed
   * paste) before `start()` fails. Default 30000.
   */
  inputReadyTimeoutMs?: number;
  /** Name of Tacet's own MCP server in the Worker's config: its tools never ask. Default `tacet`. */
  tacetMcpServer?: string;
  /** Milliseconds `close()` waits for Claude Code to exit by itself before SIGTERM. Default 3000. */
  exitTimeoutMs?: number;
  /** Milliseconds to wait after SIGTERM before SIGKILL. Default 5000. */
  killTimeoutMs?: number;
  /** Terminal size. Default 200 × 50. */
  cols?: number;
  rows?: number;
  /**
   * Whether the commands the Worker runs get its credentials stripped (#150). Default `true`;
   * `false` is honoured only with `spawn` (a test that replaces Claude Code).
   */
  subprocessScrub?: boolean;
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
  /** The `prompt_id` of the last cancelled turn: its hooks are stale whenever they arrive. */
  cancelledPromptId: string | undefined;
  /** Bumped by a cancel or close, so a prompt being typed stops typing. */
  epoch: number;
  /** Fires when a typed prompt was not acknowledged in time. */
  ackTimer: NodeJS.Timeout | undefined;
  /** Tool calls whose result was reported. */
  finished: Set<string>;
  queue: string[];
  /** When the last turn was cancelled (Esc, or a denial that interrupts). */
  cancelledAt: number;
  /** When the terminal last showed output. */
  lastOutputAt: number;
  /** What `terminal()` shows. */
  screen: TerminalBuffer;
  ready: () => void;
  exited: Promise<void>;
  exit?: { exitCode: number; signal?: number };
  closing: boolean;
  ended: boolean;
}

const ESC = '\x1b';
/** Bracketed paste mode on: the interface reads input from here on (verified live, #15). */
const PASTE_MODE_ON = '\x1b[?2004h';
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
  /** Claude config roots (`<repo state>/claude-pty`) already swept for old sessions. */
  readonly #sweptRoots = new Set<string>();

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
    const keyed = authEnv('api_key', { ...filtered.env, ...opts.env });
    // The commands the Worker runs never see its key (#150).
    const env =
      this.#opts.subprocessScrub === false && this.#opts.spawn ? keyed : withSubprocessScrub(keyed);

    const vendorSessionId = opts.resume?.vendorSessionId ?? randomUUID();
    const handle: SessionHandle = { id: randomUUID(), vendorSessionId };
    const cwd = realpathSync(opts.cwd);
    // From the user's environment, not the Worker's: where state lives never depends on a session.
    const home = (this.#opts.baseEnv ?? process.env).HOME ?? homedir();
    const root = this.#configRoot(cwd, home);
    const configDir = join(root, vendorSessionId);
    if (!this.#sweptRoots.has(root)) {
      this.#sweptRoots.add(root);
      try {
        const live = new Set([...this.#sessions.values()].map((x) => x.handle.vendorSessionId));
        live.add(vendorSessionId);
        sweepClaudeConfigDirs(
          root,
          (this.#opts.retentionDays ?? 30) * 24 * 60 * 60 * 1000,
          new Set([...live].filter((v): v is string => v !== undefined)),
        );
      } catch {
        // Tried again by the next adapter that starts; the directories are only kept longer.
      }
    }
    if (opts.resume && !existsSync(configDir)) {
      throw new Error(`no PTY session ${vendorSessionId} to resume`);
    }
    // A new session that fails to start leaves no directory; a resumed one keeps its own.
    const dropDir = () => {
      if (!opts.resume) removeClaudeConfigDir(root, vendorSessionId);
    };
    try {
      prepareClaudeConfigDir(configDir, {
        cwd,
        ...(env.ANTHROPIC_API_KEY ? { apiKey: env.ANTHROPIC_API_KEY } : {}),
      });
    } catch (err) {
      dropDir();
      throw err;
    }

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
    const reg = await this.#hooks
      .register((body, reply, onAbort) => {
        if (s) this.#onHook(s, body, reply, onAbort);
        else {
          early.push(body);
          reply();
        }
      })
      .catch((err: unknown) => {
        dropDir();
        throw err;
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
        cancelledPromptId: undefined,
        epoch: 0,
        ackTimer: undefined,
        finished: new Set(),
        queue: [],
        cancelledAt: 0,
        lastOutputAt: 0,
        screen: new TerminalBuffer(this.#opts.cols ?? 200, this.#opts.rows ?? 50),
        ready,
        exited,
        closing: false,
        ended: false,
      };
      const session = s;
      // The terminal itself is not an event stream; it is drained so the child never blocks, and
      // watched only for the moment the interface takes input (see below). The tail of the last
      // chunk is kept so the sequence is found across chunk boundaries.
      let inputReady = false;
      let tail = '';
      let onInputReady: () => void = () => {};
      const inputReadyP = new Promise<void>((r) => {
        onInputReady = r;
      });
      pty.onData((d) => {
        session.lastOutputAt = Date.now();
        session.screen.push(d);
        if (inputReady) return;
        const seen = tail + d;
        if (seen.includes(PASTE_MODE_ON)) {
          inputReady = true;
          onInputReady();
        }
        tail = seen.slice(-PASTE_MODE_ON.length);
      });
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
      // `SessionStart` comes before the interface reads input: a prompt typed then was lost, or
      // its Enter was (verified live). The interface turns on bracketed paste when it takes
      // input; typed from then on, prompts were taken every time, under load too.
      const takesInput = await Promise.race([
        inputReadyP.then(() => true),
        session.exited.then(() => false),
        deadline(this.#opts.inputReadyTimeoutMs ?? 30_000).then(() => false),
      ]);
      if (!takesInput) {
        // Set by the exit handler meanwhile; TypeScript keeps the narrowing from the check above.
        const exit = session.exit as Session['exit'];
        throw new Error(
          exit
            ? `claude exited during start (code ${exit.exitCode})`
            : 'claude never became ready for input',
        );
      }
    } catch (err) {
      if (s) await this.#terminate(s);
      for (const f of files) removeSessionFile(f);
      await this.#hooks.unregister(reg.key);
      dropDir();
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
      this.#setState(s, s.approvals.size > 0 ? 'waiting_input' : 'running');
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
    this.#setState(s, s.approvals.size > 0 ? 'waiting_input' : 'running');
  }

  async close(h: SessionHandle): Promise<void> {
    const s = this.#sessions.get(h.id);
    if (!s || s.closing) return;
    s.closing = true;
    s.epoch++;
    s.queue.length = 0;
    clearTimeout(s.ackTimer);
    this.#releaseApprovals(s);
    await this.#terminate(s, true);
    for (const f of s.files) removeSessionFile(f);
    await this.#hooks.unregister(s.hookKey);
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

  async discard(vendorSessionId: string, cwd: string): Promise<void> {
    if (!UUID.test(vendorSessionId)) throw new Error('a PTY session is named by its UUID');
    for (const s of this.#sessions.values()) {
      if (s.handle.vendorSessionId === vendorSessionId) {
        throw new Error(`PTY session ${vendorSessionId} is still open`);
      }
    }
    const base = this.#opts.baseEnv ?? process.env;
    removeClaudeConfigDir(this.#configRoot(cwd, base.HOME ?? homedir()), vendorSessionId);
  }

  terminal(h: SessionHandle): AgentTerminal {
    const s = this.#sessions.get(h.id);
    if (!s) throw new Error(`unknown session ${h.id}`);
    return s.screen;
  }

  // ---- internals -------------------------------------------------------------------------

  /** Where the sessions' Claude config directories live: `<repo state dir>/claude-pty`. */
  #configRoot(cwd: string, home: string): string {
    return join(
      repoStateDir(
        this.#opts.repoRoot ?? repoOf(cwd),
        this.#opts.stateDir ?? defaultStateDir(home),
      ),
      'claude-pty',
    );
  }

  /**
   * Type a prompt as one bracketed paste and submit it. `UserPromptSubmit` acknowledges it; if it
   * does not come in time, something in the terminal holds the prompt up.
   */
  async #type(s: Session, text: string): Promise<void> {
    s.typing = true;
    const epoch = s.epoch;
    // Cancelled or closed meanwhile: the prompt is not typed, or not submitted.
    const gone = () => s.epoch !== epoch || s.ended || s.closing;
    this.#setState(s, 'running');
    try {
      // After a cancel, the interface takes input again only once it has drawn the interruption:
      // a prompt typed at once was dropped (seen live under load), and a key right after Esc
      // reads as Alt+key. So wait a moment, and until the terminal is quiet.
      const until = Date.now() + 5000;
      while (
        Date.now() < until &&
        (Date.now() - s.cancelledAt < 500 || Date.now() - s.lastOutputAt < 300)
      ) {
        await sleep(50);
        if (gone()) return;
      }
      if (gone()) return;
      const before = s.promptId;
      // Paste and Enter in one write (verified live): no moment where a cancel could leave a
      // prompt typed but not submitted.
      s.pty.write(`${PASTE_START}${text}${PASTE_END}\r`);
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
    s.epoch++;
    s.cancelledPromptId = s.promptId;
    if (interruptedByDenial || s.approvals.size > 0) {
      for (const p of s.approvals.values()) {
        if (p.toolUseId) this.#toolResult(s, p.toolUseId, false);
        p.reply(denyPermission('cancelled by Tacet', true));
      }
      s.approvals.clear();
    } else {
      s.pty.write(ESC);
    }
    s.cancelledAt = Date.now();
    // Tool calls of the cancelled turn end here: no result follows for them.
    for (const t of s.openTools) this.#toolResult(s, t.id, false);
    s.openTools = [];
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
        (promptId !== undefined && promptId === s.cancelledPromptId) ||
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
        // A cancelled prompt's own submit (its Enter beat the cancel) is not a new turn.
        if (promptId !== undefined && promptId === s.cancelledPromptId) {
          reply();
          return;
        }
        s.promptId = promptId;
        s.cancelledPromptId = undefined;
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
          // Scrubbed before it is cut short, so no secret is left half there.
          summary: `${ev.tool_name}: ${summarize(scrubLiterals(redactSecrets(ev.tool_input), s.secrets))}`,
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
    // Never while a prompt is being typed: the queue drains after its turn.
    if (s.typing) return;
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
    s.screen.end();
    for (const f of s.files) removeSessionFile(f);
    void this.#hooks.unregister(s.hookKey);
  }

  /**
   * End the session. With `graceful`, Claude Code is first asked to exit (Ctrl-D twice, as its
   * docs say): killed at once, it can lose the last turn's transcript, so the session cannot be
   * resumed (seen live: "No conversation found"). Then the process group, which node-pty makes
   * the child lead, gets SIGTERM, and SIGKILL if it stays: background processes of the Worker
   * end too.
   */
  async #terminate(s: Session, graceful = false): Promise<void> {
    if (graceful && !s.exit) {
      s.pty.write('\x04');
      await sleep(150);
      if (!s.exit) s.pty.write('\x04');
      await Promise.race([s.exited, deadline(this.#opts.exitTimeoutMs ?? 3000)]);
    }
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
  const first = promptCommandPrefix(clean);
  if (first !== undefined) {
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
