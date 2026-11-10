import { randomUUID } from 'node:crypto';
import {
  type CanUseTool,
  type EffortLevel,
  type ModelInfo,
  type Options,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import {
  type AdapterCapabilities,
  type AgentAdapter,
  type AgentEvent,
  type ApprovalDecision,
  AsyncQueue,
  DeltaScrubber,
  type InterruptResult,
  mcpHeaderSecrets,
  ProfileRefusedError,
  type SendOptions,
  type SessionHandle,
  type SessionOptions,
  type SessionState,
  scrubbedEvents,
  type UserInput,
  type WorkerEnvPolicy,
  workerEnv,
} from '@tacet/core';
import { authEnv, type ClaudeAuthRoute, claudeEnvAllow, withSubprocessScrub } from './auth.js';
import { removeMcpConfig, sweepStaleMcpConfigs, writeMcpConfig } from './mcp-config.js';

const CONTEXT_1M = 1_000_000;

/**
 * Capabilities verified against the Claude Agent SDK in spike #64
 * (docs/adapters/spikes/64-claude) and re-checked on SDK 0.3.319 by this package's conformance
 * test. Cost is `estimated` because `total_cost_usd` is a client-side estimate, not billing data.
 */
export const CLAUDE_SDK_CAPABILITIES: AdapterCapabilities = {
  streaming: true,
  liveInput: true,
  approvals: 'roundtrip',
  interrupt: 'receipt',
  resume: true,
  fork: 'native',
  usage: { live: true, context: true, cost: 'estimated' },
  modelSwitch: 'mid-session',
  injectContext: false,
  // Verified on SDK 0.3.319 against the mock API (#110): `applyFlagSettings({ effortLevel })`
  // changes the next request's `output_config.effort`.
  effortSwitch: 'per-turn',
  // The `context-1m-2025-08-07` beta; refused for models the SDK does not document it for.
  contextSizes: [CONTEXT_1M],
};

export interface ClaudeSdkAdapterOptions {
  /**
   * Which credentials the Worker uses (see `chooseAuthRoute`). Default `api_key`, the owner's
   * policy for parallel or unattended Workers.
   */
  authRoute?: ClaudeAuthRoute;
  /** The user's environment, which the Worker gets an allowlist of. Default `process.env`. */
  baseEnv?: Record<string, string | undefined>;
  /**
   * Which of `baseEnv` the Worker gets (#147). Default: the allowlist (`workerEnv`), with no
   * passthrough. Interactive sessions may pass `{ inherit: 'all' }`.
   */
  envPolicy?: WorkerEnvPolicy;
  /** Told the names (never values) of the variables left out of each session's environment. */
  onEnvDropped?: (names: string[]) => void;
  /** Directory for per-session MCP config files. Default `~/.tacet/run/mcp`. */
  mcpConfigDir?: string;
  /**
   * Told how many stale MCP config files (of Mini-conductors no longer running) were removed when
   * this adapter started its first session (#108). Only the count: never names or contents.
   */
  onSweep?: (removedFiles: number) => void;
  /** SDK options passed through unchanged, e.g. `settingSources` or `pathToClaudeCodeExecutable`. */
  sdkOptions?: Pick<
    Options,
    'settingSources' | 'pathToClaudeCodeExecutable' | 'permissionMode' | 'allowedTools'
  >;
  /**
   * Whether the commands an API-key Worker runs get its credentials stripped (#150). Default
   * `true`; `false` only for tests that replace the Claude Code binary (`query`).
   */
  subprocessScrub?: boolean;
  /** Replaces the SDK's `query()`; for tests. */
  query?: typeof sdkQuery;
}

interface PendingApproval {
  resolve: (r: PermissionResult) => void;
  suggestions: PermissionUpdate[] | undefined;
}

interface Session {
  handle: SessionHandle;
  q: Query;
  inbox: AsyncQueue<SDKUserMessage>;
  events: AsyncQueue<AgentEvent>;
  state: SessionState;
  /** Texts of inputs sent but not yet answered by a `result`, by message uuid. */
  pending: Map<string, string>;
  approvals: Map<string, PendingApproval>;
  interrupting: boolean;
  closing: boolean;
  /** The process has exited or failed; only `close()`, `events()` and `status()` still work. */
  ended: boolean;
  /** Literal secrets of this session (MCP header values), scrubbed from every event. */
  secrets: string[];
  /** Scrubs message text across delta boundaries (#109); made on the first event. */
  deltas?: DeltaScrubber;
  model: string | undefined;
  /** Effort requested for this session (launch or the last `send`), if any. */
  effort: EffortLevel | undefined;
  /** Context window opted into at launch, if any. */
  contextWindow: number | undefined;
  /** `supportedModels()`, fetched once when effort first needs checking. */
  models: Promise<ModelInfo[]> | undefined;
  /**
   * Last cumulative `total_cost_usd`, to turn it into per-turn deltas. `undefined` when resuming
   * a session whose earlier total this adapter never saw: the first turn then sets the baseline
   * and reports no cost, because its total includes the whole earlier session.
   */
  costSoFar: number | undefined;
  /** The top-level model call in progress: prompt tokens and model from `message_start`. */
  call: { inputTokens: number; model: string | undefined } | undefined;
  /** Context window of `contextMaxModel`, from `getContextUsage`. */
  contextMax: number | undefined;
  contextMaxModel: string | undefined;
  /** Context size after the last model call (prompt plus output). */
  contextUsed: number | undefined;
  mcpConfigPath: string | undefined;
  loop: Promise<void>;
}

const CLIENT_APP = 'tacet/0.0.0';
const EFFORT_LEVELS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];
/**
 * Models the SDK documents the 1M beta for ("Sonnet 4/4.5 only"). The binary sends the beta
 * header for any model, so the adapter refuses the rest rather than let the request fail or
 * silently run with the default window.
 */
const CONTEXT_1M_MODELS = /^claude-sonnet-4(-5)?(-\d{8})?$/;
/** Vendor sessions whose cost baseline is remembered for resume; the oldest is dropped. */
const COST_TOTALS_MAX = 1000;

/**
 * Tacet adapter for Claude Code, driven through the Claude Agent SDK's streaming-input
 * `query()`. One `query()` (one Claude Code process) per session. Vendor messages are mapped to
 * `AgentEvent`s here and nothing SDK-specific leaves this module.
 *
 * Status: `running` from the first `send()` until the turn's `result`, then `idle` (or
 * `cancelled` / `error`). Input sent during a turn runs next, so `idle` can be followed at once
 * by `running`: consumers must not read `idle` alone as "the Worker is finished". An approval
 * the SDK aborts (e.g. the turn was interrupted) is dropped without an event; a later
 * `respond()` for it throws. After the process exits, the session reports `done` or `error` and
 * only `close()` remains useful.
 */
export class ClaudeSdkAdapter implements AgentAdapter {
  readonly id = 'claude-sdk';
  readonly #opts: ClaudeSdkAdapterOptions;
  readonly #sessions = new Map<string, Session>();
  /** Last cumulative cost seen per vendor session, so resume and fork report deltas. */
  readonly #costTotals = new Map<string, number>();
  #swept = false;

  constructor(opts: ClaudeSdkAdapterOptions = {}) {
    this.#opts = opts;
  }

  capabilities(): AdapterCapabilities {
    return structuredClone(CLAUDE_SDK_CAPABILITIES);
  }

  async start(opts: SessionOptions): Promise<SessionHandle> {
    const effort = opts.effort === undefined ? undefined : effortLevel(opts.effort);
    if (opts.contextWindow !== undefined) {
      if (opts.contextWindow !== CONTEXT_1M) {
        throw new ProfileRefusedError(
          'contextWindow',
          `Claude supports only a ${CONTEXT_1M}-token window opt-in, not ${opts.contextWindow}`,
        );
      }
      check1m(opts.model);
    }
    const id = randomUUID();
    const base = this.#opts.baseEnv ?? process.env;
    const filtered = workerEnv(
      base,
      claudeEnvAllow({ ...base, ...opts.env }),
      this.#opts.envPolicy,
    );
    this.#opts.onEnvDropped?.(filtered.dropped);
    // The SDK's `env` replaces the child's environment (verified, 0.3.319): only this reaches it.
    const route = this.#opts.authRoute ?? 'api_key';
    const routed = authEnv(route, {
      ...filtered.env,
      ...opts.env,
      CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP,
    });
    // An API-key Worker's commands never see the key (#150); a login session has none to hide.
    const env =
      route === 'api_key' && this.#opts.subprocessScrub !== false
        ? withSubprocessScrub(routed)
        : routed;
    // Tacet owns the effort: this variable overrides the `effort` option and later
    // `applyFlagSettings` calls without any sign that it did.
    delete env.CLAUDE_CODE_EFFORT_LEVEL;

    // A fresh session gets its vendor id up front, so the handle can be resumed even if it
    // closes before the first turn. A fork gets a new id; a plain resume keeps the old one.
    let vendorSessionId: string;
    const sessionOpts: Partial<Options> = {};
    if (opts.resume) {
      sessionOpts.resume = opts.resume.vendorSessionId;
      if (opts.resume.fork) {
        vendorSessionId = randomUUID();
        sessionOpts.forkSession = true;
        sessionOpts.sessionId = vendorSessionId;
      } else {
        vendorSessionId = opts.resume.vendorSessionId;
      }
    } else {
      vendorSessionId = randomUUID();
      sessionOpts.sessionId = vendorSessionId;
    }

    if (!this.#swept) {
      // Once per adapter, which lives as long as its Mini-conductor: files a crashed one left.
      this.#swept = true;
      // Cleanup never stands in the way of a session.
      try {
        const removed = sweepStaleMcpConfigs(this.#opts.mcpConfigDir);
        this.#opts.onSweep?.(removed);
      } catch {
        // Tried again by the next Mini-conductor that starts.
      }
    }
    const mcpConfigPath = opts.mcpServers?.length
      ? writeMcpConfig(opts.mcpServers, {
          sessionId: id,
          worktree: opts.cwd,
          ...(this.#opts.mcpConfigDir !== undefined ? { dir: this.#opts.mcpConfigDir } : {}),
        })
      : undefined;

    const inbox = new AsyncQueue<SDKUserMessage>();
    const handle: SessionHandle = { id, vendorSessionId };
    // `s` is assigned below, before the SDK can call canUseTool.
    let s: Session | undefined;
    const canUseTool: CanUseTool = (toolName, input, ctx) =>
      s ? this.#askApproval(s, toolName, input, ctx) : Promise.resolve(deny('session not ready'));

    let q: Query;
    try {
      q = (this.#opts.query ?? sdkQuery)({
        prompt: inbox,
        options: {
          ...this.#opts.sdkOptions,
          ...sessionOpts,
          cwd: opts.cwd,
          env,
          includePartialMessages: true,
          canUseTool,
          ...(opts.model !== undefined ? { model: opts.model } : {}),
          ...(effort !== undefined ? { effort } : {}),
          ...(opts.contextWindow === CONTEXT_1M ? { betas: ['context-1m-2025-08-07'] } : {}),
          ...(opts.systemPrompt !== undefined
            ? {
                systemPrompt: { type: 'preset', preset: 'claude_code', append: opts.systemPrompt },
              }
            : {}),
          // A file, not the `mcpServers` option: the SDK passes `mcpServers` as JSON on the
          // command line, where any local user can read the Worker token in the process list.
          ...(mcpConfigPath ? { extraArgs: { 'mcp-config': mcpConfigPath } } : {}),
        },
      });
    } catch (err) {
      if (mcpConfigPath) removeMcpConfig(mcpConfigPath);
      throw err;
    }

    s = {
      handle,
      q,
      inbox,
      events: new AsyncQueue(),
      state: 'idle',
      pending: new Map(),
      approvals: new Map(),
      interrupting: false,
      closing: false,
      ended: false,
      secrets: mcpHeaderSecrets(opts.mcpServers),
      model: opts.model,
      effort,
      contextWindow: opts.contextWindow,
      models: undefined,
      costSoFar: opts.resume ? this.#costTotals.get(opts.resume.vendorSessionId) : 0,
      call: undefined,
      contextMax: undefined,
      contextMaxModel: undefined,
      contextUsed: undefined,
      mcpConfigPath,
      loop: Promise.resolve(),
    };
    this.#sessions.set(id, s);
    this.#setState(s, 'idle');
    s.loop = this.#read(s);
    if (effort !== undefined) {
      try {
        await this.#checkEffort(s, s.model, effort);
      } catch (err) {
        await this.close(handle);
        throw err;
      }
    }
    return handle;
  }

  async send(h: SessionHandle, input: UserInput, opts?: SendOptions): Promise<void> {
    const s = this.#live(h);
    const effort = opts?.effort === undefined ? s.effort : effortLevel(opts.effort);
    const model = opts?.model || s.model;
    // The SDK silently drops (or lowers) an effort the model lacks, so check before switching.
    if (effort !== undefined && (effort !== s.effort || model !== s.model)) {
      await this.#checkEffort(s, model, effort);
    }
    // The 1M beta stays on the session's requests, so a new model must take it too.
    if (opts?.model && s.contextWindow === CONTEXT_1M) check1m(opts.model);
    // Effort first, so a failed model switch can be rolled back to the previous state.
    const effortChanged = effort !== undefined && effort !== s.effort;
    if (effortChanged) await s.q.applyFlagSettings({ effortLevel: effort });
    if (opts?.model) {
      try {
        await s.q.setModel(opts.model);
      } catch (err) {
        if (effortChanged) {
          await s.q.applyFlagSettings({ effortLevel: s.effort ?? null }).catch(() => {});
        }
        throw err;
      }
      s.model = opts.model;
    }
    if (effortChanged) s.effort = effort;
    const uuid = randomUUID();
    s.pending.set(uuid, input.text);
    s.inbox.push({
      type: 'user',
      message: { role: 'user', content: input.text },
      parent_tool_use_id: null,
      uuid,
    } as SDKUserMessage);
    if (s.state !== 'running') {
      s.interrupting = false;
      this.#setState(s, 'running');
    }
  }

  async interrupt(h: SessionHandle): Promise<InterruptResult> {
    const s = this.#live(h);
    if (s.state === 'running') s.interrupting = true;
    const receipt = await s.q.interrupt();
    // The turn may have ended before the interrupt landed; then no result will consume the flag.
    if (s.state !== 'running') s.interrupting = false;
    const stillQueued = (receipt?.still_queued ?? [])
      .map((uuid) => s.pending.get(uuid))
      .filter((t): t is string => t !== undefined);
    return { stillQueued };
  }

  async respond(h: SessionHandle, requestId: string, decision: ApprovalDecision): Promise<void> {
    const s = this.#live(h);
    const pending = s.approvals.get(requestId);
    if (!pending) throw new Error(`no pending approval ${requestId}`);
    s.approvals.delete(requestId);
    pending.resolve(toPermissionResult(decision, pending.suggestions));
    if (decision.kind === 'cancel') s.interrupting = true;
  }

  async close(h: SessionHandle): Promise<void> {
    const s = this.#sessions.get(h.id);
    if (!s || s.closing) return;
    s.closing = true;
    for (const p of s.approvals.values()) p.resolve(deny('session closed', true));
    s.approvals.clear();
    s.inbox.end();
    try {
      s.q.close();
      await s.loop;
    } finally {
      if (s.mcpConfigPath) removeMcpConfig(s.mcpConfigPath);
      this.#setState(s, 'done');
      s.events.end();
      this.#sessions.delete(h.id);
    }
  }

  events(h: SessionHandle): AsyncIterable<AgentEvent> {
    return this.#session(h).events;
  }

  status(h: SessionHandle): SessionState {
    return this.#sessions.get(h.id)?.state ?? 'done';
  }

  /** Refuse an effort level the model does not list, rather than let the SDK drop or lower it. */
  async #checkEffort(s: Session, model: string | undefined, effort: EffortLevel): Promise<void> {
    s.models ??= s.q.supportedModels();
    const models = await s.models;
    const name = model ?? 'default';
    const info =
      models.find((m) => m.value === name) ?? models.find((m) => m.resolvedModel === name);
    if (!info) {
      throw new ProfileRefusedError('effort', `cannot confirm effort support for ${name}`);
    }
    if (!info.supportsEffort || !info.supportedEffortLevels?.includes(effort)) {
      throw new ProfileRefusedError('effort', `${name} does not support effort ${effort}`);
    }
  }

  #session(h: SessionHandle): Session {
    const s = this.#sessions.get(h.id);
    if (!s || s.closing) throw new Error(`unknown or closed session ${h.id}`);
    return s;
  }

  /** A session whose process is still running. */
  #live(h: SessionHandle): Session {
    const s = this.#session(h);
    if (s.ended) throw new Error(`session ${h.id} has ended (${s.state})`);
    return s;
  }

  /**
   * Every event leaves through here: known key formats and this session's secrets are scrubbed.
   * Message text is scrubbed across delta boundaries too (#109): a tail that could still be the
   * start of a secret is held back, and goes out before the next event of any other kind.
   */
  #emit(s: Session, e: AgentEvent): void {
    s.deltas ??= new DeltaScrubber(s.secrets);
    for (const out of scrubbedEvents(s.deltas, s.secrets, e)) s.events.push(out);
  }

  #setState(s: Session, state: SessionState, message?: string): void {
    s.state = state;
    this.#emit(s, { t: 'status', state, ...(message !== undefined ? { message } : {}) });
  }

  #askApproval(
    s: Session,
    toolName: string,
    input: Record<string, unknown>,
    ctx: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    if (s.closing) return Promise.resolve(deny('session closed', true));
    const id = `approval-${randomUUID()}`;
    return new Promise<PermissionResult>((resolve) => {
      s.approvals.set(id, { resolve, suggestions: ctx.suggestions });
      ctx.signal.addEventListener(
        'abort',
        () => {
          if (s.approvals.delete(id)) resolve(deny('aborted', true));
        },
        { once: true },
      );
      this.#emit(s, {
        t: 'approval.request',
        id,
        summary: ctx.title ?? `Claude wants to use ${toolName}`,
        toolName,
        options: ['allow_once', 'allow_always', 'reject', 'cancel'],
        requestedGrant: { input, suggestions: ctx.suggestions ?? [] },
      });
    });
  }

  async #read(s: Session): Promise<void> {
    try {
      for await (const m of s.q) await this.#onMessage(s, m);
      if (!s.closing) this.#setState(s, 'done');
    } catch (err) {
      if (!s.closing) this.#setState(s, 'error', errorMessage(err));
    } finally {
      s.ended = true;
      for (const p of s.approvals.values()) p.resolve(deny('session ended', true));
      s.approvals.clear();
      if (!s.closing) {
        if (s.mcpConfigPath) removeMcpConfig(s.mcpConfigPath);
        s.events.end();
      }
    }
  }

  async #onMessage(s: Session, m: SDKMessage): Promise<void> {
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') {
          s.handle.vendorSessionId = m.session_id;
          s.model = m.model;
        }
        return;
      case 'stream_event': {
        // Top level only: subagent output and usage arrive through their tool results and the
        // turn's cost (`result.usage` also excludes subagents).
        if (m.parent_tool_use_id !== null) return;
        const ev = m.event;
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          this.#emit(s, { t: 'message.delta', text: ev.delta.text });
        } else if (ev.type === 'message_start') {
          const u = ev.message.usage;
          s.call = {
            inputTokens:
              u.input_tokens +
              (u.cache_creation_input_tokens ?? 0) +
              (u.cache_read_input_tokens ?? 0),
            model: ev.message.model || s.model,
          };
        } else if (ev.type === 'message_delta' && s.call) {
          await this.#onCallEnd(s, s.call, ev.usage.output_tokens);
        }
        return;
      }
      case 'assistant':
        for (const b of m.message.content) {
          if (b.type === 'tool_use') {
            this.#emit(s, {
              t: 'tool.call',
              id: b.id,
              name: b.name,
              input: b.input,
            });
          }
        }
        return;
      case 'user': {
        const content = m.message.content;
        if (typeof content === 'string') return;
        for (const b of content) {
          if (b.type === 'tool_result') {
            this.#emit(s, { t: 'tool.result', id: b.tool_use_id, ok: b.is_error !== true });
          }
        }
        return;
      }
      case 'result':
        this.#onResult(s, m);
        return;
      default:
        return;
    }
  }

  /** One top-level model call finished: emit its tokens, model and the context gauge. */
  async #onCallEnd(
    s: Session,
    call: NonNullable<Session['call']>,
    outputTokens: number,
  ): Promise<void> {
    s.call = undefined;
    s.contextUsed = call.inputTokens + outputTokens;
    if (s.contextMax === undefined || s.contextMaxModel !== call.model) {
      // The window depends on the model; ask once per model. `summary` makes no API calls.
      const ctx = await s.q.getContextUsage({ detail: 'summary' }).catch(() => undefined);
      if (ctx) {
        s.contextMax = ctx.maxTokens;
        s.contextMaxModel = call.model;
      }
    }
    this.#emit(s, {
      t: 'usage',
      inputTokens: call.inputTokens,
      outputTokens,
      ...this.#contextFields(s),
      ...(call.model ? { model: call.model } : {}),
      source: 'reported',
    });
  }

  #contextFields(s: Session): { contextUsed?: number; contextMax?: number } {
    return s.contextUsed !== undefined && s.contextMax !== undefined
      ? { contextUsed: s.contextUsed, contextMax: s.contextMax }
      : {};
  }

  #onResult(s: Session, m: Extract<SDKMessage, { type: 'result' }>): void {
    const answered = m.user_message_uuids ?? (m.user_message_uuid ? [m.user_message_uuid] : []);
    if (answered.length > 0) for (const u of answered) s.pending.delete(u);
    else {
      // Older CLIs do not say which input a result answers; assume the oldest.
      const first = s.pending.keys().next();
      if (!first.done) s.pending.delete(first.value);
    }

    // Round to nano-dollars so float subtraction noise does not reach the ledger.
    const cost =
      s.costSoFar === undefined
        ? undefined
        : Math.round(Math.max(0, m.total_cost_usd - s.costSoFar) * 1e9) / 1e9;
    s.costSoFar = Math.max(s.costSoFar ?? 0, m.total_cost_usd);
    if (s.handle.vendorSessionId) {
      // Re-insert so the map stays in recency order, and keep it bounded.
      this.#costTotals.delete(s.handle.vendorSessionId);
      this.#costTotals.set(s.handle.vendorSessionId, s.costSoFar);
      if (this.#costTotals.size > COST_TOTALS_MAX) {
        const oldest = this.#costTotals.keys().next();
        if (!oldest.done) this.#costTotals.delete(oldest.value);
      }
    }
    // Tokens were reported per model call; this event carries the turn's cost only, so the
    // ledger never counts tokens twice. No awaits here: the turn's end state is decided on the
    // same tick as its result, so a late interrupt() cannot relabel it.
    if (cost !== undefined) {
      this.#emit(s, {
        t: 'usage',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: cost,
        ...this.#contextFields(s),
        ...(s.model ? { model: s.model } : {}),
        source: 'estimated',
      });
    }

    if (s.interrupting) {
      s.interrupting = false;
      this.#setState(s, 'cancelled');
    } else if (m.subtype === 'success' && !m.is_error) {
      this.#setState(s, 'idle');
    } else {
      this.#setState(s, 'error', m.subtype === 'success' ? 'turn failed' : m.subtype);
    }
    // Inputs sent during the turn run next.
    if (s.pending.size > 0) this.#setState(s, 'running');
  }
}

/** Refuse the 1M window for models the SDK does not document it for. */
function check1m(model: string | undefined): void {
  if (!model || !CONTEXT_1M_MODELS.test(model)) {
    throw new ProfileRefusedError(
      'contextWindow',
      `the 1M-token window is documented for Sonnet 4 and 4.5 only, not ${model ?? 'the default model'}`,
    );
  }
}

/** A Tacet effort name as the SDK's level, or a refusal for names Claude does not have. */
function effortLevel(effort: string): EffortLevel {
  if (!EFFORT_LEVELS.includes(effort)) {
    throw new ProfileRefusedError('effort', `Claude has no effort level ${effort}`);
  }
  return effort as EffortLevel;
}

function deny(message: string, interrupt = false): PermissionResult {
  return { behavior: 'deny', message, ...(interrupt ? { interrupt: true } : {}) };
}

/**
 * Map a Tacet decision to the SDK's permission result. `allow_always` applies the SDK's
 * suggested rules to this session only, unless `persist` asks for them to be kept as the SDK
 * suggested (which may write Claude Code settings files).
 */
export function toPermissionResult(
  d: ApprovalDecision,
  suggestions: PermissionUpdate[] | undefined,
): PermissionResult {
  const updatedInput =
    d.updatedInput !== undefined && typeof d.updatedInput === 'object' && d.updatedInput !== null
      ? { updatedInput: d.updatedInput as Record<string, unknown> }
      : {};
  switch (d.kind) {
    case 'allow_once':
      return { behavior: 'allow', ...updatedInput };
    case 'allow_always': {
      const rules = (suggestions ?? []).map((u) =>
        d.persist ? u : { ...u, destination: 'session' as const },
      );
      return {
        behavior: 'allow',
        ...updatedInput,
        ...(rules.length > 0 ? { updatedPermissions: rules } : {}),
      };
    }
    case 'cancel':
      return deny(d.message ?? 'cancelled by the user', true);
    default:
      return deny(d.message ?? 'rejected by the user');
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
