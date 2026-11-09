import { randomUUID } from 'node:crypto';
import {
  type CanUseTool,
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
  type InterruptResult,
  redactSecrets,
  type SendOptions,
  type SessionHandle,
  type SessionOptions,
  type SessionState,
  type UserInput,
} from '@tacet/core';
import { authEnv, type ClaudeAuthRoute } from './auth.js';
import { removeMcpConfig, writeMcpConfig } from './mcp-config.js';
import { AsyncQueue } from './queue.js';

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
};

export interface ClaudeSdkAdapterOptions {
  /**
   * Which credentials the Worker uses (see `chooseAuthRoute`). Default `api_key`, the owner's
   * policy for parallel or unattended Workers.
   */
  authRoute?: ClaudeAuthRoute;
  /** The user's environment the Worker inherits. Default `process.env`. */
  baseEnv?: Record<string, string | undefined>;
  /** Directory for per-session MCP config files. Default `~/.tacet/run/mcp`. */
  mcpConfigDir?: string;
  /** SDK options passed through unchanged, e.g. `settingSources` or `pathToClaudeCodeExecutable`. */
  sdkOptions?: Pick<
    Options,
    'settingSources' | 'pathToClaudeCodeExecutable' | 'permissionMode' | 'allowedTools'
  >;
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
  model: string | undefined;
  /** Last cumulative `total_cost_usd`, to turn it into per-turn deltas. */
  costSoFar: number;
  mcpConfigPath: string | undefined;
  loop: Promise<void>;
}

const CLIENT_APP = 'tacet/0.0.0';

/**
 * Tacet adapter for Claude Code, driven through the Claude Agent SDK's streaming-input
 * `query()`. One `query()` (one Claude Code process) per session. Vendor messages are mapped to
 * `AgentEvent`s here and nothing SDK-specific leaves this module.
 */
export class ClaudeSdkAdapter implements AgentAdapter {
  readonly id = 'claude-sdk';
  readonly #opts: ClaudeSdkAdapterOptions;
  readonly #sessions = new Map<string, Session>();

  constructor(opts: ClaudeSdkAdapterOptions = {}) {
    this.#opts = opts;
  }

  capabilities(): AdapterCapabilities {
    return structuredClone(CLAUDE_SDK_CAPABILITIES);
  }

  async start(opts: SessionOptions): Promise<SessionHandle> {
    const id = randomUUID();
    const env = authEnv(this.#opts.authRoute ?? 'api_key', {
      ...(this.#opts.baseEnv ?? process.env),
      ...opts.env,
      CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP,
    });

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
      model: opts.model,
      costSoFar: 0,
      mcpConfigPath,
      loop: Promise.resolve(),
    };
    this.#sessions.set(id, s);
    this.#setState(s, 'idle');
    s.loop = this.#read(s);
    return handle;
  }

  async send(h: SessionHandle, input: UserInput, opts?: SendOptions): Promise<void> {
    const s = this.#session(h);
    if (opts?.model) {
      await s.q.setModel(opts.model);
      s.model = opts.model;
    }
    const uuid = randomUUID();
    s.pending.set(uuid, input.text);
    s.inbox.push({
      type: 'user',
      message: { role: 'user', content: input.text },
      parent_tool_use_id: null,
      uuid,
    } as SDKUserMessage);
    if (s.state !== 'running') this.#setState(s, 'running');
  }

  async interrupt(h: SessionHandle): Promise<InterruptResult> {
    const s = this.#session(h);
    if (s.state === 'running') s.interrupting = true;
    const receipt = await s.q.interrupt();
    const stillQueued = (receipt?.still_queued ?? [])
      .map((uuid) => s.pending.get(uuid))
      .filter((t): t is string => t !== undefined);
    return { stillQueued };
  }

  async respond(h: SessionHandle, requestId: string, decision: ApprovalDecision): Promise<void> {
    const s = this.#session(h);
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

  #session(h: SessionHandle): Session {
    const s = this.#sessions.get(h.id);
    if (!s || s.closing) throw new Error(`unknown or closed session ${h.id}`);
    return s;
  }

  #emit(s: Session, e: AgentEvent): void {
    s.events.push(e);
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
        requestedGrant: redactSecrets({ input, suggestions: ctx.suggestions ?? [] }),
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
        // Top-level text only: subagent output arrives through their tool results.
        const ev = m.event;
        if (
          m.parent_tool_use_id === null &&
          ev.type === 'content_block_delta' &&
          ev.delta.type === 'text_delta'
        ) {
          this.#emit(s, { t: 'message.delta', text: ev.delta.text });
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
              input: redactSecrets(b.input),
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
        await this.#onResult(s, m);
        return;
      default:
        return;
    }
  }

  async #onResult(s: Session, m: Extract<SDKMessage, { type: 'result' }>): Promise<void> {
    const answered = m.user_message_uuids ?? (m.user_message_uuid ? [m.user_message_uuid] : []);
    if (answered.length > 0) for (const u of answered) s.pending.delete(u);
    else {
      // Older CLIs do not say which input a result answers; assume the oldest.
      const first = s.pending.keys().next();
      if (!first.done) s.pending.delete(first.value);
    }

    // Round to nano-dollars so float subtraction noise does not reach the ledger.
    const cost = Math.round(Math.max(0, m.total_cost_usd - s.costSoFar) * 1e9) / 1e9;
    s.costSoFar = Math.max(s.costSoFar, m.total_cost_usd);
    const context = await s.q.getContextUsage({ detail: 'summary' }).catch(() => undefined);
    this.#emit(s, {
      t: 'usage',
      inputTokens:
        m.usage.input_tokens +
        (m.usage.cache_creation_input_tokens ?? 0) +
        (m.usage.cache_read_input_tokens ?? 0),
      outputTokens: m.usage.output_tokens,
      costUsd: cost,
      ...(context ? { contextUsed: context.totalTokens, contextMax: context.maxTokens } : {}),
      ...(s.model ? { model: s.model } : {}),
      source: 'estimated',
    });

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
