import type { AgentEvent, ApprovalDecision, SessionState } from '../schema/agent-event.js';
import type { Effort } from '../schema/profile.js';

/**
 * What an adapter honestly supports (ARCHITECTURE.md §3, capability matrix §7). The conformance
 * bench (`@tacet/core/testing`) compares these declarations with observed behaviour and reports
 * `drift` when they disagree. Never declare a capability the vendor surface does not provide.
 */
export interface AdapterCapabilities {
  /** Emits `message.delta` events while the model writes. */
  streaming: boolean;
  /** Accepts `send()` while a turn is running (Omnigent's live message queue). */
  liveInput: boolean;
  /**
   * `roundtrip`: emits `approval.request` and waits for `respond()`.
   * `predecided`: approvals are fixed at start (e.g. Gemini headless `--approval-mode`).
   * `none`: the surface never asks.
   */
  approvals: 'roundtrip' | 'predecided' | 'none';
  /**
   * `receipt`: interrupts the turn and reports still-queued input (Claude Agent SDK).
   * `turn`: interrupts the turn. `tool-boundary`: stops at the next tool boundary.
   * `kill`: only by ending the process. `none`: not supported.
   */
  interrupt: 'receipt' | 'turn' | 'tool-boundary' | 'kill' | 'none';
  /** `SessionOptions.resume` continues an earlier vendor session. */
  resume: boolean;
  /** `native`: the vendor forks. `emulated`: Tacet seeds a new session from a HandoffPacket. */
  fork: 'native' | 'emulated' | 'none';
  usage: {
    /** A `usage` event follows every model call. */
    live: boolean;
    /** `usage.contextUsed` and `usage.contextMax` are filled in. */
    context: boolean;
    cost: 'reported' | 'estimated' | 'none';
  };
  /** Where a model change takes effect. */
  modelSwitch: 'mid-session' | 'per-turn' | 'launch-only';
  /** `injectContext()` is implemented (Gas City `InjectContext`). */
  injectContext: boolean;
  /**
   * Where a reasoning-effort change takes effect (#110): `per-turn` honours `SendOptions.effort`,
   * `per-session` only `SessionOptions.effort`. Absent: the adapter does not support effort.
   */
  effortSwitch?: 'per-turn' | 'per-session';
  /**
   * Context windows (tokens) the adapter can select through `SessionOptions.contextWindow`,
   * beyond the model's default (#110). Absent or empty: only the default window. An adapter
   * refuses a window it does not list instead of silently running on the default.
   */
  contextSizes?: number[];
}

/** An MCP server the Worker session should connect to, e.g. the Mini-conductor's (ADR-003 §6). */
export interface McpServerConfig {
  name: string;
  url: string;
  /** Typically `mcpAuthHeaders(workerToken)` from `@tacet/core/node`. Never logged. */
  headers?: Record<string, string>;
}

export interface SessionOptions {
  /** Working directory, normally the Worker's git worktree. */
  cwd: string;
  model?: string;
  /** Reasoning effort; see `effortSwitch`. Refused (`ProfileRefusedError`, `./errors.ts`) if unsupported. */
  effort?: Effort;
  /**
   * Context window in tokens, larger than the model's default; must be one of
   * `capabilities().contextSizes`, otherwise `start()` refuses it (#110).
   */
  contextWindow?: number;
  systemPrompt?: string;
  /** Extra environment for the vendor process. Credentials come from the user's environment. */
  env?: Record<string, string>;
  mcpServers?: McpServerConfig[];
  /** Continue (or fork) an earlier vendor session. Requires `capabilities().resume`. */
  resume?: { vendorSessionId: string; fork?: boolean };
}

export interface SessionHandle {
  /** Tacet's id for this session (one per handoff generation). */
  readonly id: string;
  /** The vendor's session or thread id, for resume. Known once the vendor reports it. */
  vendorSessionId?: string;
}

export interface UserInput {
  text: string;
}

export interface SendOptions {
  /** Model for this and later turns, if `modelSwitch` allows it. */
  model?: string;
  /**
   * Reasoning effort for this and later turns, if `effortSwitch` is `per-turn`. Applies from the
   * vendor's next model call: sent while a turn runs, it also reaches that turn's remaining calls.
   */
  effort?: Effort;
}

export interface InterruptResult {
  /** Input that had been sent but not yet started; only with `interrupt: 'receipt'`. */
  stillQueued?: string[];
}

/**
 * The contract every Worker adapter implements (ARCHITECTURE.md §3). Vendor output is
 * normalized to `AgentEvent` before it leaves the adapter; no vendor types leak out.
 * Cross-checked against Gas City's `AgentProvider`: Start → `start` (resolves once the session
 * is ready, which covers IsReady), SendMessage → `send`, GetStatus → `status`, InjectContext →
 * `injectContext`, Resume/Fork → `SessionOptions.resume`, GetUsage → `usage` events.
 */
export interface AgentAdapter {
  readonly id: string;
  capabilities(): AdapterCapabilities;
  /** Start a session. Resolves when it is ready for input. */
  start(opts: SessionOptions): Promise<SessionHandle>;
  /** Send user input. Resolves when the adapter has accepted it, not when the turn ends. */
  send(h: SessionHandle, input: UserInput, opts?: SendOptions): Promise<void>;
  interrupt(h: SessionHandle): Promise<InterruptResult>;
  /** Answer an `approval.request` by its id. */
  respond(h: SessionHandle, requestId: string, decision: ApprovalDecision): Promise<void>;
  /** End the session and its process tree. `events(h)` then completes. */
  close(h: SessionHandle): Promise<void>;
  /** The session's normalized events. Each handle has one stream. */
  events(h: SessionHandle): AsyncIterable<AgentEvent>;
  /** Current state, as last reported by a `status` event. */
  status(h: SessionHandle): SessionState;
  /** Add context to the running session without starting a turn. */
  injectContext?(h: SessionHandle, text: string): Promise<void>;
  /**
   * The session's terminal, for adapters that run one (PTY, #15): what `tacet attach` shows.
   * Read-only: typed keys would bypass `send` and `respond`, and so the event log. Its bytes
   * travel on their own channel, never as events (ADR-003), and are never persisted.
   */
  terminal?(h: SessionHandle): AgentTerminal;
}

/** A read-only view of a session's terminal (`AgentAdapter.terminal`). */
export interface AgentTerminal {
  readonly cols: number;
  readonly rows: number;
  /** The most recent output (bounded), so a viewer can redraw the screen when it attaches. */
  scrollback(): string;
  /**
   * Output from now on, until the session ends. Each call is its own stream. A reader that falls
   * too far behind sees its stream end early; check `status()` before taking that as the end of
   * the session, and call `output()` again (with `scrollback()` to redraw) to go on watching.
   */
  // Neither stream is scrubbed of secrets: it is the Worker's own terminal, shown to its user.
  // Never log it or write it to the event log.
  output(): AsyncIterable<string>;
}
