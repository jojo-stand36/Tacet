import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
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
  DeltaScrubber,
  findSecrets,
  type InterruptResult,
  mcpHeaderSecrets,
  redactSecrets,
  type SendOptions,
  type SessionHandle,
  type SessionOptions,
  type SessionState,
  scrubbedEvents,
  scrubLiterals,
  type UserInput,
} from '@tacet/core';
import {
  defaultStateDir,
  repoStateDir,
  SAFE_GIT_ARGS,
  trustedGitEnv,
  type WorkerWorktree,
  workerGitEnv,
  workerWorktree,
} from '@tacet/core/node';
import { AuthRoutingError, type CodexAuthRoute, codexLaunch } from './auth.js';
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
  /**
   * Who the session is for (#116). Default `unattended`: a Worker nobody is watching. It must use
   * the `api_key` route (#65), gets its own `CODEX_HOME` at `<stateDir>/<repo-hash>/codex`
   * (so the user's `~/.codex/config.toml`, MCP servers and logins never apply) and runs with
   * Codex plugins off. In a linked git worktree it is checked out detached and commits into the
   * worktree's own object store; the only writable git path is that worktree's git dir, and the
   * Mini-conductor integrates the commits (see `workerGitEnv`). `interactive`: the user's own
   * `CODEX_HOME`, config and checkout, untouched.
   */
  mode?: 'unattended' | 'interactive';
  /**
   * The repo (main worktree) the Worker belongs to. It keys the Worker's state directory like the
   * event log does, and is the trusted anchor its worktree is checked against. Required for an
   * unattended Worker in a git checkout; a directory outside git is keyed by itself.
   */
  repoRoot?: string;
  /** Tacet state directory (config `events.state_dir`). Default `<HOME>/.tacet/state`. */
  stateDir?: string;
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
  /** Scrubs message text across delta boundaries (#109); made on the first event. */
  deltas?: DeltaScrubber;
  exited: Promise<void>;
  /** Set synchronously on exit; after that the process group must never be signalled. */
  exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
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
    const unattended = (this.#opts.mode ?? 'unattended') === 'unattended';
    if (unattended && route !== 'api_key') {
      throw new AuthRoutingError('unattended Codex Workers must use the api_key route (#65)');
    }
    const launch = codexLaunch(
      route,
      { ...(this.#opts.baseEnv ?? process.env), ...opts.env },
      this.#opts.apiBaseUrl !== undefined ? { baseUrl: this.#opts.apiBaseUrl } : {},
    );
    const home = launch.env.HOME ?? homedir();
    let codexHome: string;
    if (unattended) {
      // Nothing inherited may point a Worker's git somewhere else.
      for (const k of GIT_LOCATION_VARS) delete launch.env[k];
      // Nobody can answer a prompt: git fails instead of waiting for a terminal or an editor.
      launch.env.GIT_TERMINAL_PROMPT = '0';
      launch.env.GIT_EDITOR = 'true';
      // No unsupervised background work in the Worker's object store: a commit would otherwise
      // start a detached `git maintenance run --auto` (seen on macOS CI, #124).
      addGitConfig(launch.env, { 'maintenance.auto': 'false', 'gc.auto': '0' });
      // Tacet's own CODEX_HOME: Codex state, logs and config for this repo's Workers stay out of
      // the user's ~/.codex, and the user's config.toml cannot change a Worker (#116).
      codexHome = join(
        repoStateDir(
          workerRepoRoot(opts.cwd, this.#opts.repoRoot),
          this.#opts.stateDir ?? defaultStateDir(home),
        ),
        'codex',
      );
      privateDir(codexHome);
      launch.env.CODEX_HOME = codexHome;
    } else {
      codexHome = launch.env.CODEX_HOME ?? join(home, '.codex');
      // Codex refuses to start when CODEX_HOME does not exist.
      mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    }

    const extra = [
      ...configArgs(this.#opts.config),
      // After the caller's overrides, so they cannot turn plugins back on: no plugin sync from
      // GitHub when a Worker starts (#116).
      ...(unattended ? ['-c', 'features.plugins=false'] : []),
    ];
    // Unattended Worker in a linked worktree (#116, option B): it commits on a detached HEAD into
    // its own object store, and the only writable git path is its own worktree git dir. The
    // Mini-conductor integrates the commits outside the sandbox (see `workerGitEnv`).
    // A Worker can write its worktree git dir, so everything in it is untrusted: it is checked
    // against the repo root before any git command runs outside the sandbox.
    const wt =
      unattended && this.#opts.repoRoot !== undefined
        ? workerWorktree(opts.cwd, this.#opts.repoRoot)
        : undefined;
    if (wt) {
      mkdirSync(join(wt.gitDir, 'objects'), { recursive: true });
      Object.assign(launch.env, workerGitEnv(wt));
      detachHead(opts.cwd, wt, launch.env);
    }
    const gitDir = wt?.gitDir;
    const secrets = [
      ...mcpHeaderSecrets(opts.mcpServers),
      // The key never leaves the environment, but if it shows up in output it is scrubbed too.
      ...['OPENAI_API_KEY', 'CODEX_API_KEY'].flatMap((k) => {
        const v = launch.env[k];
        return v && v.length >= 8 ? [v] : [];
      }),
    ].sort((a, b) => b.length - a.length);
    // Its own process group, so close() can end Codex's children too (e.g. its background
    // plugin `git` sync, which outlives app-server otherwise).
    const proc = spawn(
      process.execPath,
      // The auth route's overrides come last, so nothing earlier can replace them.
      [this.#opts.codexPath ?? defaultCodexPath(), 'app-server', ...extra, ...launch.args],
      {
        cwd: opts.cwd,
        env: launch.env,
        stdio: ['pipe', 'pipe', 'ignore'],
        detached: process.platform !== 'win32',
      },
    );
    const exitInfo: { value: Session['exit'] } = { value: undefined };
    const exited = new Promise<void>((resolve) =>
      proc.once('exit', (code, signal) => {
        exitInfo.value = { code, signal };
        // Codex's children (e.g. its plugin `git` sync) keep the group alive, so signalling it
        // here, synchronously on exit, cannot reach a reused group id. Later code never does.
        signalGroup(proc, 'SIGTERM');
        resolve();
      }),
    );
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
    // EPIPE when Codex closed its input: fail the peer instead of crashing the host process.
    proc.stdin?.on('error', (err) => rpc.fail(err));

    try {
      await rpc.request('initialize', { clientInfo: CLIENT_INFO, capabilities: null });
      rpc.notify('initialized');
      const threadParams = {
        cwd: opts.cwd,
        approvalPolicy: this.#opts.approvalPolicy ?? 'on-request',
        sandbox: this.#opts.sandbox ?? 'workspace-write',
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        ...(opts.systemPrompt !== undefined ? { developerInstructions: opts.systemPrompt } : {}),
        config: {
          // Per-session MCP servers travel over stdin as thread config, so the Worker token is
          // never on the command line or on disk (verified on 0.167.0, #12).
          ...(opts.mcpServers?.length
            ? {
                mcp_servers: Object.fromEntries(
                  opts.mcpServers.map((m) => [
                    m.name,
                    { url: m.url, ...(m.headers ? { http_headers: m.headers } : {}) },
                  ]),
                ),
              }
            : {}),
          ...(opts.effort !== undefined ? { model_reasoning_effort: opts.effort } : {}),
          // Codex keeps a linked worktree's git dir read-only; the Worker's own one is made
          // writable, and nothing else of the repo's .git (#116). Thread config keys are dotted
          // override paths, so this sets only `writable_roots` and keeps the rest of the table.
          ...(gitDir !== undefined ? { 'sandbox_workspace_write.writable_roots': [gitDir] } : {}),
        },
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
        secrets,
        exited,
        get exit() {
          return exitInfo.value;
        },
      };
    } catch (err) {
      rpc.fail(new Error('start failed'));
      proc.stdin?.end();
      await this.#terminate(proc, exited, () => exitInfo.value !== undefined);
      // Codex's error text can quote the thread config, which holds the MCP headers.
      throw new Error(
        `codex app-server failed to start the session: ${scrubLiterals(redactSecrets(errorMessage(err)), secrets)}`,
      );
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
    if (decision.kind !== 'cancel') return;
    s.interrupting = true;
    // Codex's command and file-change `cancel` interrupts the turn itself; a permissions or
    // elicitation answer does not, so interrupt explicitly.
    if (pending.kind === 'permissions' || pending.kind === 'elicitation') {
      // The reply above is written on a later tick; let it reach Codex before the interrupt, so
      // Codex sees the denial first and then the interrupt.
      await new Promise((r) => setImmediate(r));
      await this.interrupt(h);
    }
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
    await this.#terminate(s.proc, s.exited, () => s.exit !== undefined);
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

  /**
   * End a Codex process: end of input asks it to finish; then SIGTERM to its group (the npm
   * wrapper forwards it to the native binary), then SIGKILL. Signals are sent only while the
   * process is still running, so a long-dead group id is never signalled.
   */
  async #terminate(proc: ChildProcess, exited: Promise<void>, hasExited: () => boolean) {
    const within = (ms: number) =>
      Promise.race([
        exited.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), ms).unref()),
      ]);
    const timeout = this.#opts.killTimeoutMs ?? 5000;
    if (await within(Math.min(500, timeout))) return;
    if (!hasExited()) signalGroup(proc, 'SIGTERM');
    if (await within(timeout)) return;
    if (!hasExited()) signalGroup(proc, 'SIGKILL');
    await exited;
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

  #startNext(s: Session): void {
    if (s.ended || s.rpc.closed) return;
    const next = s.queue.shift();
    if (!next) return;
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
          if (next.model !== undefined) s.model = next.model;
          return id;
        })
        .catch((err: unknown) => {
          // A dead process is reported once, by #onExit.
          if (s.turn === turn && !s.rpc.closed) {
            this.#endTurn(s, 'error', scrubLiterals(redactSecrets(errorMessage(err)), s.secrets));
          }
          return undefined;
        }),
    };
    s.turn = turn;
  }

  #endTurn(s: Session, state: SessionState, message?: string): void {
    s.turn = undefined;
    s.interrupting = false;
    this.#setState(s, state, message);
    if (s.queue.length > 0) this.#startNext(s);
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
        // While `turn/start` has not answered, the id is unknown; one turn runs at a time, so
        // the completion is ours.
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
    // Any exit we did not ask for is a crash (adapter rules), during a turn or not.
    const how = s.exit?.signal ? `signal ${s.exit.signal}` : `code ${s.exit?.code ?? '?'}`;
    this.#setState(
      s,
      'error',
      `app-server exited unexpectedly (${how})${s.turn ? ' during a turn' : ''}`,
    );
    s.turn = undefined;
    s.events.end();
  }
}

const CANCEL: ApprovalDecision = { kind: 'cancel', persist: false };

/**
 * Map a Tacet decision to the Codex response for that request kind (spike #58). `allow_always`
 * is session-scoped (`acceptForSession`) unless `persist` asks for Codex's proposed execpolicy
 * amendment, which writes a rule. Denying a permissions request returns an empty grant, and a
 * granted profile is cut down to what Codex asked for. Codex's decision types have no field for a
 * reason, so `decision.message` is not forwarded (0.167.0 schema).
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
        permissions: allow
          ? d.grant === undefined
            ? (params.permissions ?? {})
            : (grantSubset(params.permissions, d.grant) ?? {})
          : {},
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

/**
 * The part of `granted` that `requested` covers, so a Decision can narrow a permissions request
 * but never widen it: objects keep only requested keys (recursively), arrays only requested
 * elements, and other values only when equal to the request or `false`.
 */
export function grantSubset(requested: unknown, granted: unknown): unknown {
  if (isObj(requested) && isObj(granted)) {
    const out: Obj = {};
    for (const [k, v] of Object.entries(granted)) {
      if (!(k in requested)) continue;
      const sub = grantSubset(requested[k], v);
      if (sub !== undefined) out[k] = sub;
    }
    return out;
  }
  if (Array.isArray(requested) && Array.isArray(granted)) {
    const allowed = new Set(requested.map((x) => JSON.stringify(x)));
    return granted.filter((x) => allowed.has(JSON.stringify(x)));
  }
  if (granted === false || JSON.stringify(granted) === JSON.stringify(requested)) return granted;
  return undefined;
}

const RESERVED_CONFIG =
  /^(model_providers?|mcp_servers|openai_base_url|cli_auth_credentials_store|forced_login_method)(\.|$)|token|key|secret|auth|header|password|credential/i;

/**
 * `-c` arguments for `CodexAdapterOptions.config`. Anything that could change the auth route,
 * the MCP servers or carry a credential is refused: these values end up on the command line.
 */
export function configArgs(
  config: Record<string, string | number | boolean> | undefined,
): string[] {
  const entries = Object.entries(config ?? {});
  for (const [k, v] of entries) {
    if (RESERVED_CONFIG.test(k) || findSecrets(v).length > 0) {
      throw new AuthRoutingError(
        `config override "${k}" is not allowed: it could change auth or carry a credential`,
      );
    }
  }
  return entries.flatMap(([k, v]) => [
    '-c',
    `${k}=${typeof v === 'string' ? JSON.stringify(v) : String(v)}`,
  ]);
}

/** Append `-c`-style settings through `GIT_CONFIG_COUNT`, keeping any the caller already set. */
function addGitConfig(env: Record<string, string>, settings: Record<string, string>): void {
  const parsed = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10);
  let n = Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
  for (const [key, value] of Object.entries(settings)) {
    env[`GIT_CONFIG_KEY_${n}`] = key;
    env[`GIT_CONFIG_VALUE_${n}`] = value;
    n += 1;
  }
  env.GIT_CONFIG_COUNT = String(n);
}

const GIT_LOCATION_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
] as const;

/** Create `dir` (0700) if needed and refuse anything but a real directory owned by us. */
function privateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || (process.getuid && st.uid !== process.getuid())) {
    throw new Error(`Codex home ${dir} is not a private directory`);
  }
  chmodSync(dir, 0o700);
}

/**
 * The repo an unattended Worker belongs to. A git checkout needs the caller's `repoRoot` (the
 * Mini-conductor knows it): what `cwd` says about its repo is writable by the Worker and so not
 * trusted. A directory that is not a git checkout is keyed by itself.
 */
function workerRepoRoot(cwd: string, repoRoot: string | undefined): string {
  if (repoRoot !== undefined) return repoRoot;
  if (existsSync(join(cwd, '.git'))) {
    throw new Error('unattended Codex Workers in a git checkout need the repoRoot option (#116)');
  }
  return cwd;
}

/**
 * Detach the worktree's HEAD at its current commit without a checkout, so no hooks, filters or
 * index updates run. Git only resolves the commit (with `trustedGitEnv`: never the API key); the
 * new HEAD is written here by temp file and rename, because git would follow a `logs/HEAD`
 * symlink the Worker planted and append to its target. Throws when HEAD has no commit yet.
 */
function detachHead(cwd: string, wt: WorkerWorktree, env: Record<string, string>): void {
  let sha: string;
  try {
    sha = execFileSync('git', [...SAFE_GIT_ARGS, 'rev-parse', '--verify', '-q', 'HEAD^{commit}'], {
      cwd,
      env: trustedGitEnv(cwd, wt, env),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new Error(`worktree ${cwd} has no commit to start a Worker from`);
  }
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) throw new Error(`unexpected commit id ${sha}`);
  const tmp = join(wt.gitDir, `HEAD.tacet-${randomUUID()}`);
  // `wx`: never through a file or symlink that already exists at that name.
  writeFileSync(tmp, `${sha}\n`, { flag: 'wx', mode: 0o644 });
  renameSync(tmp, join(wt.gitDir, 'HEAD'));
}

/** Signal the process group `proc` leads (POSIX), or just `proc`. Already-gone is fine. */
function signalGroup(proc: ChildProcess, signal: NodeJS.Signals): void {
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
