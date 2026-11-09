import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type AdapterCapabilities,
  type AgentAdapter,
  type AgentEvent,
  type ApprovalDecision,
  type ApprovalOption,
  AsyncQueue,
  type InterruptResult,
  mcpHeaderSecrets,
  redactSecrets,
  type SendOptions,
  type SessionHandle,
  type SessionOptions,
  type SessionState,
  scrubLiterals,
  type UserInput,
} from '@tacet/core';
import { type CodexAuthRoute, codexLaunch } from './auth.js';
import { JsonRpcPeer, METHOD_NOT_FOUND, RpcError } from './jsonrpc.js';

/** The Codex CLI version this adapter is pinned to and conformance-tested against. */
export const CODEX_VERSION = '0.167.0';

/**
 * Capabilities verified on Codex 0.167.0 against a local Responses API mock (#12; spike #58).
 * Live input is a queue in the adapter: input sent during a turn becomes the next turn, so the
 * interrupt receipt (`stillQueued`) is honest. Codex reports no cost, only tokens.
 */
export const CODEX_CAPABILITIES: AdapterCapabilities = {
  streaming: true,
  liveInput: true,
  approvals: 'roundtrip',
  interrupt: 'receipt',
  resume: true,
  fork: 'native',
  usage: { live: true, context: true, cost: 'none' },
  modelSwitch: 'per-turn',
  injectContext: false,
  effortSwitch: 'per-turn',
};

export interface CodexAdapterOptions {
  /** Default `api_key`, the owner's policy for parallel or unattended Workers. */
  authRoute?: CodexAuthRoute;
  /** The user's environment the Worker inherits. Default `process.env`. */
  baseEnv?: Record<string, string | undefined>;
  /** Responses API base URL for the `api_key` route. Default OpenAI's; tests use a local mock. */
  apiBaseUrl?: string;
  /**
   * Codex approval policy. Default `on-request` (Codex asks when it needs to leave the sandbox);
   * `untrusted` asks before any command that is not known to be safe.
   */
  approvalPolicy?: 'untrusted' | 'on-request' | 'never';
  /** Codex sandbox mode. Default `workspace-write`. */
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  /** Path to the `codex` entry point. Default: the pinned `@openai/codex` package. */
  codexPath?: string;
  /** Milliseconds to wait for the process to exit after SIGTERM before SIGKILL. */
  killTimeoutMs?: number;
  /**
   * Extra non-secret `-c key=value` overrides for `codex app-server`, e.g.
   * `{ 'features.plugins': false }`. Never put credentials here: they would be on the command
   * line.
   */
  config?: Record<string, string | number | boolean>;
}

type Queued = { text: string; model?: string; effort?: string };

interface PendingApproval {
  kind: 'command' | 'fileChange' | 'permissions' | 'elicitation';
  params: Record<string, unknown>;
  resolve: (result: unknown) => void;
}

interface Session {
  handle: SessionHandle;
  proc: ChildProcess;
  rpc: JsonRpcPeer;
  threadId: string;
  events: AsyncQueue<AgentEvent>;
  state: SessionState;
  queue: Queued[];
  /** The running turn: its id once `turn/start` answered, and that answer. */
  turn: { id?: string; started: Promise<string | undefined> } | undefined;
  approvals: Map<string, PendingApproval>;
  interrupting: boolean;
  closing: boolean;
  ended: boolean;
  model: string | undefined;
  secrets: string[];
  exited: Promise<void>;
}

const CLIENT_INFO = { name: 'tacet', title: 'Tacet', version: '0.0.0' };
const TOOL_ITEMS = new Set([
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'collabAgentToolCall',
  'webSearch',
  'imageView',
  'imageGeneration',
]);
const ALL_OPTIONS: ApprovalOption[] = ['allow_once', 'allow_always', 'reject', 'cancel'];

function defaultCodexPath(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve('@openai/codex/package.json')), 'bin', 'codex.js');
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * Tacet adapter for Codex, driven through `codex app-server` (JSON-RPC over stdio). One process
 * and one Codex thread per session. Codex items and notifications are mapped to `AgentEvent`s
 * here; nothing Codex-specific leaves this module.
 */
export class CodexAppServerAdapter implements AgentAdapter {
  readonly id = 'codex-app-server';
  readonly #opts: CodexAdapterOptions;
  readonly #sessions = new Map<string, Session>();

  constructor(opts: CodexAdapterOptions = {}) {
    this.#opts = opts;
  }

  capabilities(): AdapterCapabilities {
    return structuredClone(CODEX_CAPABILITIES);
  }

  async start(opts: SessionOptions): Promise<SessionHandle> {
    const route = this.#opts.authRoute ?? 'api_key';
    const launch = codexLaunch(
      route,
      { ...(this.#opts.baseEnv ?? process.env), ...opts.env },
      this.#opts.apiBaseUrl !== undefined ? { baseUrl: this.#opts.apiBaseUrl } : {},
    );
    // Codex refuses to start when CODEX_HOME does not exist.
    const codexHome = launch.env.CODEX_HOME ?? join(launch.env.HOME ?? homedir(), '.codex');
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });

    const extra = Object.entries(this.#opts.config ?? {}).flatMap(([k, v]) => [
      '-c',
      `${k}=${typeof v === 'string' ? JSON.stringify(v) : String(v)}`,
    ]);
    // Its own process group, so close() can end Codex's children too (e.g. its background
    // plugin `git` sync, which outlives app-server otherwise).
    const proc = spawn(
      process.execPath,
      [this.#opts.codexPath ?? defaultCodexPath(), 'app-server', ...launch.args, ...extra],
      {
        cwd: opts.cwd,
        env: launch.env,
        stdio: ['pipe', 'pipe', 'ignore'],
        detached: process.platform !== 'win32',
      },
    );
    const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
    const handle: SessionHandle = { id: randomUUID() };
    // Assigned right below; the handlers only run once the process has answered.
    let s: Session | undefined;
    const rpc = new JsonRpcPeer(
      proc.stdout as NonNullable<typeof proc.stdout>,
      proc.stdin as NonNullable<typeof proc.stdin>,
      {
        onRequest: (method, params) =>
          s
            ? this.#onServerRequest(s, method, params)
            : Promise.reject(new RpcError(-32603, 'not ready')),
        onNotification: (method, params) => s && this.#onNotification(s, method, params),
      },
    );
    proc.once('error', (err) => rpc.fail(err));

    try {
      await rpc.request('initialize', { clientInfo: CLIENT_INFO, capabilities: null });
      rpc.notify('initialized');
      const threadParams = {
        cwd: opts.cwd,
        approvalPolicy: this.#opts.approvalPolicy ?? 'on-request',
        sandbox: this.#opts.sandbox ?? 'workspace-write',
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        ...(opts.systemPrompt !== undefined ? { developerInstructions: opts.systemPrompt } : {}),
        // Per-session MCP servers travel over stdin as thread config, so the Worker token is
        // never on the command line or on disk (verified on 0.167.0, #12).
        ...(opts.mcpServers?.length
          ? {
              config: {
                mcp_servers: Object.fromEntries(
                  opts.mcpServers.map((m) => [
                    m.name,
                    { url: m.url, ...(m.headers ? { http_headers: m.headers } : {}) },
                  ]),
                ),
                ...(opts.effort !== undefined ? { model_reasoning_effort: opts.effort } : {}),
              },
            }
          : opts.effort !== undefined
            ? { config: { model_reasoning_effort: opts.effort } }
            : {}),
      };
      const result = await rpc.request<Obj>(
        opts.resume ? (opts.resume.fork ? 'thread/fork' : 'thread/resume') : 'thread/start',
        opts.resume ? { ...threadParams, threadId: opts.resume.vendorSessionId } : threadParams,
      );
      const thread = isObj(result.thread) ? result.thread : {};
      const threadId = str(thread.id);
      if (!threadId) throw new Error('app-server returned no thread id');
      handle.vendorSessionId = threadId;
      s = {
        handle,
        proc,
        rpc,
        threadId,
        events: new AsyncQueue(),
        state: 'idle',
        queue: [],
        turn: undefined,
        approvals: new Map(),
        interrupting: false,
        closing: false,
        ended: false,
        model: str(result.model) ?? opts.model,
        secrets: mcpHeaderSecrets(opts.mcpServers),
        exited,
      };
    } catch (err) {
      signalTree(proc, 'SIGTERM');
      throw err;
    }
    const session = s;
    this.#sessions.set(handle.id, session);
    void exited.then(() => this.#onExit(session));

    // The own-login route needs the user to have logged in to Codex; say so instead of failing
    // on the first turn.
    if (route === 'subscription') {
      const account = await rpc.request<Obj>('account/read', {}).catch(() => undefined);
      if (account && account.account === null && account.requiresOpenaiAuth === true) {
        this.#setState(session, 'auth_required', 'log in with `codex login` first');
        return handle;
      }
    }
    this.#setState(session, 'idle');
    return handle;
  }

  async send(h: SessionHandle, input: UserInput, opts?: SendOptions): Promise<void> {
    const s = this.#live(h);
    s.queue.push({
      text: input.text,
      ...(opts?.model !== undefined ? { model: opts.model } : {}),
      ...(opts?.effort !== undefined ? { effort: opts.effort } : {}),
    });
    if (!s.turn) this.#startNext(s);
  }

  async interrupt(h: SessionHandle): Promise<InterruptResult> {
    const s = this.#live(h);
    const stillQueued = s.queue.map((q) => q.text);
    const turn = s.turn;
    if (!turn) return { stillQueued };
    s.interrupting = true;
    const turnId = turn.id ?? (await turn.started);
    // The turn may have ended while we waited; then there is nothing to interrupt.
    if (turnId && s.turn === turn) {
      await s.rpc.request('turn/interrupt', { threadId: s.threadId, turnId }).catch((err) => {
        if (!(err instanceof RpcError)) throw err;
      });
    } else if (s.turn !== turn) {
      s.interrupting = false;
    }
    return { stillQueued };
  }

  async respond(h: SessionHandle, requestId: string, decision: ApprovalDecision): Promise<void> {
    const s = this.#live(h);
    const pending = s.approvals.get(requestId);
    if (!pending) throw new Error(`no pending approval ${requestId}`);
    s.approvals.delete(requestId);
    pending.resolve(toCodexDecision(pending.kind, pending.params, decision));
    if (decision.kind === 'cancel') s.interrupting = true;
  }

  async close(h: SessionHandle): Promise<void> {
    const s = this.#sessions.get(h.id);
    if (!s || s.closing) return;
    s.closing = true;
    this.#denyPending(s);
    // Let the denials reach the server before its input closes.
    await new Promise((r) => setImmediate(r));
    s.rpc.fail(new Error('session closed'));
    // End of input asks app-server to finish; then SIGTERM (forwarded by the npm wrapper to
    // the native binary), then SIGKILL.
    s.proc.stdin?.end();
    const exitedWithin = (ms: number) =>
      Promise.race([
        s.exited.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), ms).unref()),
      ]);
    const timeout = this.#opts.killTimeoutMs ?? 5000;
    if (!(await exitedWithin(Math.min(500, timeout)))) {
      signalTree(s.proc, 'SIGTERM');
      if (!(await exitedWithin(timeout))) {
        signalTree(s.proc, 'SIGKILL');
        await s.exited;
      }
    }
    // Children app-server left behind.
    signalTree(s.proc, 'SIGTERM');
    this.#setState(s, 'done');
    s.events.end();
    this.#sessions.delete(h.id);
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

  #live(h: SessionHandle): Session {
    const s = this.#session(h);
    if (s.ended) throw new Error(`session ${h.id} has ended (${s.state})`);
    return s;
  }

  /** Every event leaves through here: known key formats and this session's secrets are scrubbed. */
  #emit(s: Session, e: AgentEvent): void {
    s.events.push(scrubLiterals(redactSecrets(e), s.secrets));
  }

  #setState(s: Session, state: SessionState, message?: string): void {
    s.state = state;
    this.#emit(s, { t: 'status', state, ...(message !== undefined ? { message } : {}) });
  }

  #startNext(s: Session): void {
    const next = s.queue.shift();
    if (!next) return;
    if (next.model !== undefined) s.model = next.model;
    s.interrupting = false;
    this.#setState(s, 'running');
    const turn: Session['turn'] = {
      started: s.rpc
        .request<Obj>('turn/start', {
          threadId: s.threadId,
          input: [{ type: 'text', text: next.text, text_elements: [] }],
          ...(next.model !== undefined ? { model: next.model } : {}),
          ...(next.effort !== undefined ? { effort: next.effort } : {}),
        })
        .then((r) => {
          const id = isObj(r.turn) ? str(r.turn.id) : undefined;
          if (turn && id) turn.id = id;
          return id;
        })
        .catch((err: unknown) => {
          if (s.turn === turn) this.#endTurn(s, 'error', errorMessage(err));
          return undefined;
        }),
    };
    s.turn = turn;
  }

  #endTurn(s: Session, state: SessionState, message?: string): void {
    s.turn = undefined;
    s.interrupting = false;
    this.#setState(s, state, message);
    if (s.queue.length > 0 && !s.ended) this.#startNext(s);
  }

  #onNotification(s: Session, method: string, raw: unknown): void {
    const p = isObj(raw) ? raw : {};
    if (p.threadId !== undefined && p.threadId !== s.threadId) return;
    switch (method) {
      case 'item/agentMessage/delta': {
        const text = str(p.delta);
        if (text) this.#emit(s, { t: 'message.delta', text });
        return;
      }
      case 'item/started': {
        const item = isObj(p.item) ? p.item : {};
        const type = str(item.type);
        const id = str(item.id);
        if (type && id && TOOL_ITEMS.has(type)) {
          this.#emit(s, { t: 'tool.call', id, name: toolName(item), input: toolInput(item) });
        }
        return;
      }
      case 'item/completed': {
        const item = isObj(p.item) ? p.item : {};
        const type = str(item.type);
        const id = str(item.id);
        if (type && id && TOOL_ITEMS.has(type)) {
          const status = str(item.status);
          this.#emit(s, {
            t: 'tool.result',
            id,
            ok: status === undefined || status === 'completed',
            ...(status && status !== 'completed' ? { summary: status } : {}),
          });
        }
        return;
      }
      case 'thread/tokenUsage/updated': {
        // One update follows every model call; `last` is that call (verified on 0.167.0).
        const usage = isObj(p.tokenUsage) ? p.tokenUsage : {};
        const last = isObj(usage.last) ? usage.last : {};
        const n = (v: unknown) => (typeof v === 'number' && v >= 0 ? Math.round(v) : 0);
        const window = usage.modelContextWindow;
        this.#emit(s, {
          t: 'usage',
          inputTokens: n(last.inputTokens),
          outputTokens: n(last.outputTokens),
          ...(typeof window === 'number'
            ? { contextUsed: n(last.totalTokens), contextMax: n(window) }
            : {}),
          ...(s.model ? { model: s.model } : {}),
          source: 'reported',
        });
        return;
      }
      case 'turn/completed': {
        const turn = isObj(p.turn) ? p.turn : {};
        if (!s.turn || (s.turn.id && str(turn.id) !== s.turn.id)) return;
        const status = str(turn.status);
        if (status === 'interrupted' || s.interrupting) this.#endTurn(s, 'cancelled');
        else if (status === 'failed') {
          const err = isObj(turn.error) ? str(turn.error.message) : undefined;
          this.#endTurn(s, 'error', err ?? 'turn failed');
        } else this.#endTurn(s, 'idle');
        return;
      }
      default:
        return;
    }
  }

  async #onServerRequest(s: Session, method: string, raw: unknown): Promise<unknown> {
    const p = isObj(raw) ? raw : {};
    switch (method) {
      case 'item/commandExecution/requestApproval':
        return this.#askApproval(s, 'command', p, {
          summary: str(p.reason) ?? `Run: ${str(p.command) ?? 'a command'}`,
          toolName: 'shell',
          grant: { command: p.command, cwd: p.cwd, reason: p.reason },
        });
      case 'item/fileChange/requestApproval':
        return this.#askApproval(s, 'fileChange', p, {
          summary: str(p.reason) ?? 'Apply file changes',
          toolName: 'apply_patch',
          grant: { reason: p.reason, grantRoot: p.grantRoot },
        });
      case 'item/permissions/requestApproval':
        return this.#askApproval(s, 'permissions', p, {
          summary: str(p.reason) ?? 'Grant additional permissions',
          toolName: 'permissions',
          grant: p.permissions,
        });
      case 'mcpServer/elicitation/request':
        return this.#askApproval(s, 'elicitation', p, {
          summary: str(p.message) ?? 'An MCP server asks for input',
          toolName: 'mcp_elicitation',
          grant: p,
        });
      default:
        // Includes `account/chatgptAuthTokens/refresh`: Tacet never supplies ChatGPT tokens.
        throw new RpcError(METHOD_NOT_FOUND, `${method} is not supported by Tacet`);
    }
  }

  #askApproval(
    s: Session,
    kind: PendingApproval['kind'],
    params: Obj,
    view: { summary: string; toolName: string; grant: unknown },
  ): Promise<unknown> {
    if (s.closing || s.ended) return Promise.resolve(toCodexDecision(kind, params, CANCEL));
    const id = `approval-${randomUUID()}`;
    return new Promise((resolve) => {
      s.approvals.set(id, { kind, params, resolve });
      this.#emit(s, {
        t: 'approval.request',
        id,
        summary: view.summary,
        toolName: view.toolName,
        options: kind === 'elicitation' ? ['allow_once', 'reject', 'cancel'] : ALL_OPTIONS,
        requestedGrant: view.grant,
      });
    });
  }

  #denyPending(s: Session): void {
    for (const a of s.approvals.values()) a.resolve(toCodexDecision(a.kind, a.params, CANCEL));
    s.approvals.clear();
  }

  #onExit(s: Session): void {
    s.ended = true;
    this.#denyPending(s);
    s.rpc.fail(new Error('app-server exited'));
    if (s.closing) return;
    this.#setState(
      s,
      s.turn ? 'error' : 'done',
      s.turn ? 'app-server exited during a turn' : undefined,
    );
    s.turn = undefined;
    s.events.end();
  }
}

const CANCEL: ApprovalDecision = { kind: 'cancel', persist: false };

/**
 * Map a Tacet decision to the Codex response for that request kind (spike #58). `allow_always`
 * is session-scoped (`acceptForSession`) unless `persist` asks for Codex's proposed execpolicy
 * amendment, which writes a rule. Denying a permissions request returns an empty grant.
 */
export function toCodexDecision(
  kind: PendingApproval['kind'],
  params: Obj,
  d: ApprovalDecision,
): unknown {
  switch (kind) {
    case 'command': {
      const amendment = params.proposedExecpolicyAmendment;
      const decision =
        d.kind === 'allow_once'
          ? 'accept'
          : d.kind === 'allow_always'
            ? d.persist && Array.isArray(amendment)
              ? { acceptWithExecpolicyAmendment: { execpolicy_amendment: amendment } }
              : 'acceptForSession'
            : d.kind === 'cancel'
              ? 'cancel'
              : 'decline';
      return { decision };
    }
    case 'fileChange':
      return {
        decision:
          d.kind === 'allow_once'
            ? 'accept'
            : d.kind === 'allow_always'
              ? 'acceptForSession'
              : d.kind === 'cancel'
                ? 'cancel'
                : 'decline',
      };
    case 'permissions': {
      const allow = d.kind === 'allow_once' || d.kind === 'allow_always';
      return {
        permissions: allow ? (d.grant ?? params.permissions ?? {}) : {},
        scope: d.kind === 'allow_always' ? 'session' : 'turn',
      };
    }
    case 'elicitation':
      return d.kind === 'allow_once' || d.kind === 'allow_always'
        ? { action: 'accept', content: d.updatedInput ?? {}, _meta: null }
        : { action: d.kind === 'cancel' ? 'cancel' : 'decline', content: null, _meta: null };
  }
}

function toolName(item: Obj): string {
  switch (item.type) {
    case 'commandExecution':
      return 'shell';
    case 'fileChange':
      return 'apply_patch';
    case 'mcpToolCall':
      return `${str(item.server) ?? 'mcp'}.${str(item.tool) ?? 'tool'}`;
    case 'dynamicToolCall':
      return str(item.tool) ?? 'dynamic_tool';
    default:
      return str(item.type) ?? 'tool';
  }
}

function toolInput(item: Obj): unknown {
  switch (item.type) {
    case 'commandExecution':
      return { command: item.command, cwd: item.cwd };
    case 'fileChange':
      return { changes: item.changes };
    case 'mcpToolCall':
    case 'dynamicToolCall':
      return item.arguments;
    default: {
      const { id: _id, type: _type, ...rest } = item;
      return rest;
    }
  }
}

/** Signal the process group `proc` leads (POSIX), or just `proc`. Already-gone is fine. */
function signalTree(proc: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (proc.pid !== undefined && process.platform !== 'win32') process.kill(-proc.pid, signal);
    else proc.kill(signal);
  } catch {
    // ESRCH: nothing left to signal.
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
