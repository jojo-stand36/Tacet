import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import {
  type ClientConnection,
  client,
  type InitializeResponse,
  type McpServer,
  type NewSessionResponse,
  ndJsonStream,
  type PermissionOption,
  RequestError,
  type RequestPermissionOutcome,
  type RequestPermissionRequest,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import {
  type AdapterCapabilities,
  type AgentAdapter,
  type AgentEvent,
  type ApprovalDecision,
  AsyncQueue,
  DeltaScrubber,
  type InterruptResult,
  type McpServerConfig,
  mcpHeaderSecrets,
  ProfileRefusedError,
  redactSecrets,
  type SendOptions,
  type SessionHandle,
  type SessionOptions,
  type SessionState,
  scrubbedEvents,
  scrubLiterals,
  type UserInput,
  type WorkerEnvPolicy,
  workerEnv,
} from '@tacet/core';
import type { AcpAgentSpec } from './agents.js';
import {
  approvalChoices,
  newTurnState,
  permissionOutcome,
  stopState,
  type TurnState,
  turnUsage,
  updateToEvents,
} from './turn-v1.js';

/** The ACP protocol version this adapter speaks (v2 is tracked in #85). */
export const ACP_PROTOCOL_VERSION = 1;

/** Version of `@agentclientprotocol/sdk` the adapter is built and tested against. */
export const ACP_SDK_VERSION = '2.4.0';

/** ACP's "authentication required" error code. */
const AUTH_REQUIRED = -32000;
/** JSON-RPC "request cancelled" (RFD `request-cancellation`). */
const REQUEST_CANCELLED = -32800;

export class AuthRoutingError extends Error {
  override name = 'AuthRoutingError';
}

export interface AcpAdapterOptions {
  /** The agent to run. */
  agent: AcpAgentSpec;
  /**
   * Replaces the program (the first word of `agent.command`), keeping the agent's arguments, e.g.
   * to run a pinned package's entry point with this Node: `[process.execPath, '<path>/gemini.js']`.
   */
  executable?: string[];
  /** The user's environment, which the Worker gets an allowlist of. Default `process.env`. */
  baseEnv?: Record<string, string | undefined>;
  /**
   * Which of `baseEnv` the Worker gets (#147). Default: the allowlist (`workerEnv`) with the
   * agent's own variables. Interactive sessions may pass `{ inherit: 'all' }`.
   */
  envPolicy?: WorkerEnvPolicy;
  /** Told the names (never values) of the variables left out of each session's environment. */
  onEnvDropped?: (names: string[]) => void;
  /** Milliseconds to wait for the agent to exit after SIGTERM before SIGKILL. Default 5000. */
  killTimeoutMs?: number;
  /** Receives the agent's stderr (free-form logging; ACP keeps stdout for messages). Scrubbed. */
  stderr?: (text: string, h: SessionHandle) => void;
  /**
   * Values resolved from secret references for this agent (e.g. a key in `agent.env`, #149):
   * scrubbed from every event and from stderr, as are the values of the agent's `apiKeyEnv`.
   * Values shorter than four characters are not.
   */
  secrets?: string[];
}

interface PendingApproval {
  options: PermissionOption[];
  resolve: (o: RequestPermissionOutcome) => void;
}

interface Session {
  handle: SessionHandle;
  proc: ChildProcess;
  conn: ClientConnection;
  acpSessionId: string;
  init: InitializeResponse;
  events: AsyncQueue<AgentEvent>;
  state: SessionState;
  secrets: string[];
  deltas: DeltaScrubber;
  turn: TurnState;
  approvals: Map<string, PendingApproval>;
  /** Input sent while a turn ran: the next turns, in order. */
  queue: string[];
  turning: boolean;
  /** Replayed history of `session/load` is not this session's output. */
  loading: boolean;
  /** The config option that selects the model, when the agent has one. */
  modelOption?: string;
  exited: Promise<void>;
  exit?: { code: number | null; signal: NodeJS.Signals | null };
  stderrTail: string;
  closing: boolean;
  ended: boolean;
}

/**
 * One adapter for every Agent Client Protocol agent (#13): newline-delimited JSON-RPC over the
 * agent's stdio, through the official TypeScript SDK. Each session is its own agent process, in
 * its own process group, with the Worker's checkout as its working directory. The Worker's MCP
 * server (and its token) goes to the agent in `session/new` over stdin: never on the command line
 * or on disk.
 *
 * Auth is API key only (owner decision 2026-11-09): a session starts only when one of the agent's
 * key variables is set, and `authenticate` is called only with an API-key method the agent offers,
 * never with a subscription or browser login.
 */
export class AcpAdapter implements AgentAdapter {
  readonly id: string;
  readonly #opts: AcpAdapterOptions;
  readonly #sessions = new Map<string, Session>();

  constructor(opts: AcpAdapterOptions) {
    this.#opts = opts;
    this.id = opts.agent.id;
  }

  capabilities(): AdapterCapabilities {
    return structuredClone(this.#opts.agent.capabilities);
  }

  async start(opts: SessionOptions): Promise<SessionHandle> {
    const spec = this.#opts.agent;
    const caps = spec.capabilities;
    if (opts.effort !== undefined) {
      throw new ProfileRefusedError('effort', `${spec.id} over ACP has no effort setting`);
    }
    if (opts.contextWindow !== undefined) {
      throw new ProfileRefusedError('contextWindow', `${spec.id} over ACP has one context size`);
    }
    if (opts.resume && !caps.resume) throw new Error(`${spec.id} does not resume sessions`);
    if (opts.resume?.fork)
      throw new Error(`${spec.id}: forking over ACP is not supported yet (#146)`);

    const env = this.#env(opts);
    const command = [
      ...(this.#opts.executable ?? spec.command.slice(0, 1)),
      ...spec.command.slice(1),
    ];
    if (opts.model !== undefined && spec.modelArgs) command.push(...spec.modelArgs(opts.model));
    const [cmd, ...args] = command as [string, ...string[]];
    // Its own process group, so close() ends the agent's children too.
    const proc = spawn(cmd, args, {
      cwd: opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    // Longest first, so a secret that starts another does not leave that one's end showing.
    const secrets = [
      ...new Set([
        ...mcpHeaderSecrets(opts.mcpServers),
        ...(this.#opts.secrets ?? []),
        ...spec.apiKeyEnv.flatMap((name) => env[name] ?? []),
      ]),
    ]
      .filter((v) => v.length >= 4)
      .sort((a, b) => b.length - a.length);
    const handle: SessionHandle = { id: randomUUID() };
    let s: Session | undefined;
    const exitInfo: { value?: Session['exit'] } = {};
    const exited = new Promise<void>((resolve) => {
      proc.once('exit', (code, signal) => {
        exitInfo.value = { code, signal };
        if (s) s.exit = exitInfo.value;
        signalGroup(proc, 'SIGTERM');
        resolve();
        // Messages still buffered on stdout (a last prompt response) are read first.
        void drained(proc).then(() => {
          flushStderr();
          if (s) this.#onExit(s);
        });
      });
      proc.on('error', () => resolve());
    });
    let stderrTail = '';
    // Scrubbed a line at a time for known key formats, and across chunks for this session's own
    // secrets, so a token split between two reads is still caught.
    const stderrSecrets = new DeltaScrubber(secrets);
    let stderrLine = '';
    const stderrOut = (raw: string, last = false) => {
      const text = stderrSecrets.push(redactSecrets(raw)) + (last ? stderrSecrets.flush() : '');
      if (!text) return;
      stderrTail = (stderrTail + text).slice(-4000);
      if (s) s.stderrTail = stderrTail;
      this.#opts.stderr?.(text, handle);
    };
    const flushStderr = () => {
      stderrOut(stderrLine, true);
      stderrLine = '';
    };
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (chunk: string) => {
      stderrLine += chunk;
      // A line with no end is passed on once long; key formats are best effort there.
      const cut =
        stderrLine.length > 64 * 1024 ? stderrLine.length : stderrLine.lastIndexOf('\n') + 1;
      if (cut > 0) {
        stderrOut(stderrLine.slice(0, cut));
        stderrLine = stderrLine.slice(cut);
      }
    });
    const stream = ndJsonStream(
      Writable.toWeb(proc.stdin as NonNullable<typeof proc.stdin>) as WritableStream<Uint8Array>,
      Readable.toWeb(proc.stdout as NonNullable<typeof proc.stdout>) as ReadableStream<Uint8Array>,
    );
    const app = client({ name: 'tacet' })
      .onRequest('session/request_permission', ({ params }) =>
        s ? this.#onPermission(s, params) : Promise.resolve({ outcome: { outcome: 'cancelled' } }),
      )
      .onNotification('session/update', ({ params }) => {
        if (s) this.#onUpdate(s, params);
      });
    const conn = app.connect(stream);
    try {
      const init = await conn.agent.request('initialize', {
        protocolVersion: ACP_PROTOCOL_VERSION,
        // The agent works in its own checkout: no client file system or terminal.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'tacet', version: '0.0.0' },
      });
      if (init.protocolVersion !== ACP_PROTOCOL_VERSION) {
        throw new Error(
          `${spec.id} speaks ACP ${init.protocolVersion}, not ${ACP_PROTOCOL_VERSION}`,
        );
      }
      const offered = new Set((init.authMethods ?? []).map((m) => m.id));
      const method = spec.apiKeyAuthMethods.find((id) => offered.has(id));
      if (method) await conn.agent.request('authenticate', { methodId: method });

      const mcpServers = this.#mcpServers(init, opts.mcpServers);
      s = {
        handle,
        proc,
        conn,
        acpSessionId: '',
        init,
        events: new AsyncQueue(),
        state: 'idle',
        secrets,
        deltas: new DeltaScrubber(secrets),
        turn: newTurnState(),
        approvals: new Map(),
        queue: [],
        turning: false,
        loading: false,
        exited,
        ...(exitInfo.value ? { exit: exitInfo.value } : {}),
        stderrTail,
        closing: false,
        ended: false,
      };
      const created = await this.#openSession(s, opts, mcpServers);
      s.acpSessionId = created.sessionId;
      handle.vendorSessionId = created.sessionId;
      const modelOption = (created.configOptions ?? []).find((o) => o.category === 'model');
      if (modelOption) s.modelOption = modelOption.id;
      if (opts.model !== undefined && !spec.modelArgs) await this.#setModel(s, opts.model);
    } catch (err) {
      s = undefined;
      conn.close();
      proc.stdin?.end();
      await this.#terminate(proc, exited, () => exitInfo.value !== undefined);
      flushStderr();
      if (err instanceof ProfileRefusedError || err instanceof AuthRoutingError) throw err;
      if (err instanceof RequestError && err.code === AUTH_REQUIRED) {
        throw new AuthRoutingError(
          `${spec.id} needs authentication, and Workers only use an API key: set ${spec.apiKeyEnv.join(' or ') || 'its API key'}`,
        );
      }
      throw new Error(
        `${spec.id} failed to start a session: ${this.#scrub(errorMessage(err), secrets)}${stderrTail ? ` (stderr: ${this.#scrub(stderrTail.slice(-500), secrets)})` : ''}`,
      );
    }
    this.#sessions.set(handle.id, s);
    if (s.exit) this.#onExit(s);
    else this.#emit(s, { t: 'status', state: 'idle' });
    return handle;
  }

  async send(h: SessionHandle, input: UserInput, opts: SendOptions = {}): Promise<void> {
    const s = this.#live(h);
    if (opts.effort !== undefined) {
      throw new ProfileRefusedError('effort', `${this.id} over ACP has no effort setting`);
    }
    if (opts.model !== undefined) await this.#setModel(s, opts.model);
    s.queue.push(input.text);
    if (!s.turning) void this.#runTurns(s);
  }

  async interrupt(h: SessionHandle): Promise<InterruptResult> {
    const s = this.#live(h);
    s.queue.length = 0;
    if (!s.turning) return {};
    // The spec's cancel flow: notify, then answer every open permission request `cancelled`.
    await s.conn.agent.notify('session/cancel', { sessionId: s.acpSessionId });
    this.#cancelApprovals(s);
    return {};
  }

  async respond(h: SessionHandle, requestId: string, decision: ApprovalDecision): Promise<void> {
    const s = this.#live(h);
    const pending = s.approvals.get(requestId);
    if (!pending) throw new Error(`no pending approval ${requestId}`);
    if (decision.kind === 'cancel') {
      // Cancelling one request cancels the turn: the same flow as interrupt().
      s.queue.length = 0;
      await s.conn.agent.notify('session/cancel', { sessionId: s.acpSessionId });
      this.#cancelApprovals(s);
      return;
    }
    s.approvals.delete(requestId);
    pending.resolve(permissionOutcome(pending.options, decision));
  }

  async close(h: SessionHandle): Promise<void> {
    const s = this.#sessions.get(h.id);
    if (!s || s.closing) return;
    s.closing = true;
    s.queue.length = 0;
    this.#cancelApprovals(s);
    if (!s.ended && s.init.agentCapabilities?.sessionCapabilities?.close) {
      await Promise.race([
        s.conn.agent.request('session/close', { sessionId: s.acpSessionId }).catch(() => {}),
        new Promise((r) => setTimeout(r, 1000).unref()),
      ]);
    }
    s.conn.close();
    s.proc.stdin?.end();
    await this.#terminate(s.proc, s.exited, () => s.exit !== undefined);
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
   * The agent's environment: the allowlist of the user's (#147), then the agent's fixed additions
   * and the session's own variables, unfiltered.
   */
  #env(opts: SessionOptions): Record<string, string> {
    const spec = this.#opts.agent;
    const filtered = workerEnv(
      this.#opts.baseEnv ?? process.env,
      {
        prefixes: spec.envAllow?.prefixes ?? [],
        names: [...(spec.envAllow?.names ?? []), ...spec.apiKeyEnv],
      },
      this.#opts.envPolicy,
    );
    // Reported before the key check below: a missing key is when the names help most.
    this.#opts.onEnvDropped?.(filtered.dropped);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...filtered.env, ...spec.env, ...opts.env })) {
      if (v !== undefined) env[k] = v;
    }
    if (spec.apiKeyEnv.length > 0 && !spec.apiKeyEnv.some((k) => env[k])) {
      throw new AuthRoutingError(
        `${spec.id}: Workers use an API key only; set ${spec.apiKeyEnv.join(' or ')}`,
      );
    }
    return env;
  }

  #mcpServers(init: InitializeResponse, servers: McpServerConfig[] | undefined): McpServer[] {
    if (!servers?.length) return [];
    if (!init.agentCapabilities?.mcpCapabilities?.http) {
      throw new Error(`${this.id} does not take HTTP MCP servers`);
    }
    return servers.map((m) => ({
      type: 'http' as const,
      name: m.name,
      url: m.url,
      headers: Object.entries(m.headers ?? {}).map(([name, value]) => ({ name, value })),
    }));
  }

  /** `session/new`, or for a resume `session/resume` or `session/load`, as the agent offers. */
  async #openSession(
    s: Session,
    opts: SessionOptions,
    mcpServers: McpServer[],
  ): Promise<NewSessionResponse> {
    const caps = s.init.agentCapabilities;
    const vendorId = opts.resume?.vendorSessionId;
    if (vendorId === undefined) {
      return s.conn.agent.request('session/new', { cwd: opts.cwd, mcpServers });
    }
    if (caps?.sessionCapabilities?.resume) {
      const r = await s.conn.agent.request('session/resume', {
        sessionId: vendorId,
        cwd: opts.cwd,
        mcpServers,
      });
      return { ...r, sessionId: vendorId };
    }
    if (caps?.loadSession) {
      // The agent replays the history as updates before it answers: not this session's output.
      s.loading = true;
      try {
        const r = await s.conn.agent.request('session/load', {
          sessionId: vendorId,
          cwd: opts.cwd,
          mcpServers,
        });
        return { ...(r ?? {}), sessionId: vendorId };
      } finally {
        s.loading = false;
      }
    }
    throw new Error(`${this.id} offers neither session/resume nor session/load`);
  }

  async #setModel(s: Session, model: string): Promise<void> {
    if (!s.modelOption) {
      throw new ProfileRefusedError(
        'model',
        `${this.id} over ACP has no model config option; the model is chosen at launch`,
      );
    }
    await s.conn.agent.request('session/set_config_option', {
      sessionId: s.acpSessionId,
      configId: s.modelOption,
      value: model,
    });
  }

  /** Run queued input as prompt turns, one at a time. */
  async #runTurns(s: Session): Promise<void> {
    s.turning = true;
    try {
      for (let text = s.queue.shift(); text !== undefined; text = s.queue.shift()) {
        if (s.ended || s.closing) return;
        this.#setState(s, 'running');
        let state: SessionState = 'idle';
        let message: string | undefined;
        try {
          const r = await s.conn.agent.request('session/prompt', {
            sessionId: s.acpSessionId,
            prompt: [{ type: 'text', text }],
          });
          const usage = turnUsage(r, s.turn);
          if (usage) this.#emit(s, usage);
          ({ state, message } = stopState(r.stopReason));
        } catch (err) {
          if (!(err instanceof RequestError)) {
            // The connection broke: if the agent died, its exit is the one error to report.
            await Promise.race([s.exited, new Promise((r) => setTimeout(r, 1000).unref())]);
            if (s.exit) return;
          }
          if (s.ended || s.closing) return;
          if (err instanceof RequestError && err.code === REQUEST_CANCELLED) {
            state = 'cancelled';
          } else {
            state = 'error';
            message = this.#scrub(errorMessage(err), s.secrets);
          }
        }
        if (s.ended || s.closing) return;
        this.#cancelApprovals(s);
        this.#setState(s, state, message);
      }
    } finally {
      s.turning = false;
    }
  }

  #onUpdate(s: Session, n: SessionNotification): void {
    if (s.loading || s.ended || n.sessionId !== s.acpSessionId) return;
    for (const e of updateToEvents(n.update, s.turn)) this.#emit(s, e);
  }

  #onPermission(
    s: Session,
    req: RequestPermissionRequest,
  ): Promise<{ outcome: RequestPermissionOutcome }> {
    if (s.ended || s.closing || req.sessionId !== s.acpSessionId) {
      return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    }
    const id = `perm-${randomUUID()}`;
    return new Promise((resolve) => {
      s.approvals.set(id, {
        options: req.options,
        resolve: (outcome) => resolve({ outcome }),
      });
      const tc = req.toolCall;
      this.#emit(s, {
        t: 'approval.request',
        id,
        summary: tc.title || tc.name || tc.kind || 'tool call',
        toolName: tc.name || tc.kind || 'tool',
        options: approvalChoices(req.options),
        ...(tc.rawInput !== undefined ? { requestedGrant: { input: tc.rawInput } } : {}),
      });
    });
  }

  /** Answer every open permission request `cancelled`, as the cancel flow requires. */
  #cancelApprovals(s: Session): void {
    for (const p of s.approvals.values()) p.resolve({ outcome: 'cancelled' });
    s.approvals.clear();
  }

  #onExit(s: Session): void {
    if (s.closing || s.ended) return;
    s.ended = true;
    this.#cancelApprovals(s);
    const code = s.exit?.signal ?? s.exit?.code;
    const tail = s.stderrTail ? `: ${s.stderrTail.slice(-500)}` : '';
    this.#setState(s, 'error', `${this.id} exited (${code ?? 'unknown'})${tail}`);
    s.events.end();
  }

  /**
   * Every event leaves through here: known key formats and this session's secrets are scrubbed,
   * across streamed deltas too (#109).
   */
  #emit(s: Session, e: AgentEvent): void {
    for (const out of scrubbedEvents(s.deltas, s.secrets, e)) s.events.push(out);
  }

  #setState(s: Session, state: SessionState, message?: string): void {
    s.state = state;
    this.#emit(s, { t: 'status', state, ...(message !== undefined ? { message } : {}) });
  }

  #scrub(text: string, secrets: readonly string[]): string {
    return scrubLiterals(redactSecrets(text), secrets);
  }

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

  #live(h: SessionHandle): Session {
    const s = this.#sessions.get(h.id);
    if (!s || s.closing) throw new Error(`unknown or closed session ${h.id}`);
    if (s.ended) throw new Error(`session ${h.id} has ended (${s.state})`);
    return s;
  }
}

/** Resolves once the agent's stdout has ended (or after a second, if a grandchild holds it). */
function drained(proc: ChildProcess): Promise<void> {
  const out = proc.stdout;
  if (!out || out.readableEnded || out.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, 1000);
    t.unref();
    out.once('close', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
