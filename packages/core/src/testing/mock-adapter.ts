import { ProfileRefusedError } from '../adapter/errors.js';
import type {
  AdapterCapabilities,
  AgentAdapter,
  InterruptResult,
  SendOptions,
  SessionHandle,
  SessionOptions,
  UserInput,
} from '../adapter/types.js';
import type { AgentEvent, ApprovalDecision, SessionState } from '../schema/agent-event.js';
import { Channel } from './channel.js';

/** Declared capabilities of the default mock: everything supported. */
export const MOCK_CAPABILITIES: AdapterCapabilities = {
  streaming: true,
  liveInput: true,
  approvals: 'roundtrip',
  interrupt: 'receipt',
  resume: true,
  mcp: true,
  fork: 'native',
  usage: { live: true, context: true, cost: 'estimated' },
  modelSwitch: 'mid-session',
  injectContext: true,
  effortSwitch: 'per-turn',
  contextSizes: [1_000_000],
};

/** Behaviours the mock can silently drop while still declaring them, to test drift detection. */
export interface MockLies {
  streaming?: boolean;
  usage?: boolean;
  approvals?: boolean;
  interrupt?: boolean;
  /** Accepts `effort` but never applies it. */
  effort?: boolean;
  /** Starts with any `contextWindow`, even one it does not list, and never applies it. */
  contextWindow?: boolean;
}

export interface MockAdapterOptions {
  /** Overrides of the default capabilities; `undefined` removes an optional one. */
  capabilities?: { [K in keyof AdapterCapabilities]?: AdapterCapabilities[K] | undefined };
  lie?: MockLies;
  /** Delay between streamed chunks, in ms. */
  tickMs?: number;
}

interface MockSession {
  handle: SessionHandle;
  opts: SessionOptions;
  events: Channel<AgentEvent>;
  state: SessionState;
  queue: string[];
  busy: boolean;
  interrupted: boolean;
  model: string;
  effort: string | undefined;
  contextWindow: number | undefined;
  context: string[];
  approvals: Map<string, (d: ApprovalDecision) => void>;
}

let sessionCounter = 0;

/**
 * Scripted adapter for tests. Input directives:
 * - `SAY <words>`: streams `You said <words>.` then a usage event.
 * - `RUN_TOOL`: a `Bash` tool call that needs approval (if approvals are `roundtrip`).
 * - `SLOW`: streams for about `100 × tickMs`, so a test can interrupt it.
 * - `WHO`: replies with the current model and any injected context.
 */
export class MockAdapter implements AgentAdapter {
  readonly id = 'mock';
  readonly #caps: AdapterCapabilities;
  readonly #lie: MockLies;
  readonly #tick: number;
  readonly #sessions = new Map<string, MockSession>();
  /** The effort in force for the last turn any session ran (what a vendor would have got). */
  lastEffort: string | undefined;
  /** The context window in force for the last turn any session ran. */
  lastContextWindow: number | undefined;

  constructor(opts: MockAdapterOptions = {}) {
    const caps: Record<string, unknown> = {
      ...MOCK_CAPABILITIES,
      ...opts.capabilities,
      usage: { ...MOCK_CAPABILITIES.usage, ...opts.capabilities?.usage },
    };
    for (const k of Object.keys(caps)) if (caps[k] === undefined) delete caps[k];
    this.#caps = caps as unknown as AdapterCapabilities;
    this.#lie = opts.lie ?? {};
    this.#tick = opts.tickMs ?? 2;
  }

  capabilities(): AdapterCapabilities {
    return structuredClone(this.#caps);
  }

  async start(opts: SessionOptions): Promise<SessionHandle> {
    if (opts.resume && !this.#caps.resume) throw new Error('resume not supported');
    if (
      opts.contextWindow !== undefined &&
      !this.#lie.contextWindow &&
      !(this.#caps.contextSizes ?? []).includes(opts.contextWindow)
    ) {
      throw new ProfileRefusedError('contextWindow', `no ${opts.contextWindow}-token window`);
    }
    if (opts.effort !== undefined && !this.#caps.effortSwitch) {
      throw new ProfileRefusedError('effort', 'effort not supported');
    }
    const id = `mock-${++sessionCounter}`;
    const vendorSessionId =
      opts.resume && !opts.resume.fork ? opts.resume.vendorSessionId : `vendor-${id}`;
    const s: MockSession = {
      handle: { id, vendorSessionId },
      opts,
      events: new Channel(),
      state: 'idle',
      queue: [],
      busy: false,
      interrupted: false,
      model: opts.model ?? 'mock-model',
      effort: opts.effort,
      contextWindow: this.#lie.contextWindow ? undefined : opts.contextWindow,
      context: [],
      approvals: new Map(),
    };
    this.#sessions.set(id, s);
    this.#emit(s, { t: 'status', state: 'idle' });
    return s.handle;
  }

  async send(h: SessionHandle, input: UserInput, opts?: SendOptions): Promise<void> {
    const s = this.#session(h);
    if (s.busy && !this.#caps.liveInput) throw new Error('session is busy');
    if (opts?.model) {
      if (this.#caps.modelSwitch === 'launch-only') throw new Error('model is fixed at launch');
      s.model = opts.model;
    }
    if (opts?.effort !== undefined) {
      if (this.#caps.effortSwitch !== 'per-turn') {
        throw new ProfileRefusedError('effort', 'effort is fixed at launch');
      }
      if (!this.#lie.effort) s.effort = opts.effort;
    }
    s.queue.push(input.text);
    if (!s.busy) void this.#drain(s);
  }

  async interrupt(h: SessionHandle): Promise<InterruptResult> {
    const s = this.#session(h);
    if (this.#caps.interrupt === 'none') throw new Error('interrupt not supported');
    if (!this.#lie.interrupt) s.interrupted = true;
    return this.#caps.interrupt === 'receipt' ? { stillQueued: [...s.queue] } : {};
  }

  async respond(h: SessionHandle, requestId: string, decision: ApprovalDecision): Promise<void> {
    const s = this.#session(h);
    const resolve = s.approvals.get(requestId);
    if (!resolve) throw new Error(`no pending approval ${requestId}`);
    s.approvals.delete(requestId);
    resolve(decision);
  }

  async close(h: SessionHandle): Promise<void> {
    const s = this.#session(h);
    s.interrupted = true;
    for (const resolve of s.approvals.values()) resolve({ kind: 'cancel', persist: false });
    s.approvals.clear();
    this.#emit(s, { t: 'status', state: 'done' });
    s.events.end();
    this.#sessions.delete(h.id);
  }

  events(h: SessionHandle): AsyncIterable<AgentEvent> {
    return this.#session(h).events;
  }

  status(h: SessionHandle): SessionState {
    return this.#sessions.get(h.id)?.state ?? 'done';
  }

  async injectContext(h: SessionHandle, text: string): Promise<void> {
    if (!this.#caps.injectContext) throw new Error('injectContext not supported');
    this.#session(h).context.push(text);
  }

  #session(h: SessionHandle): MockSession {
    const s = this.#sessions.get(h.id);
    if (!s) throw new Error(`unknown or closed session ${h.id}`);
    return s;
  }

  #emit(s: MockSession, e: AgentEvent): void {
    if (e.t === 'status') s.state = e.state;
    s.events.push(e);
  }

  async #drain(s: MockSession): Promise<void> {
    s.busy = true;
    while (s.queue.length > 0 && this.#sessions.has(s.handle.id)) {
      const text = s.queue.shift() ?? '';
      s.interrupted = false;
      this.lastEffort = s.effort;
      this.lastContextWindow = s.contextWindow;
      this.#emit(s, { t: 'status', state: 'running' });
      const outcome = await this.#turn(s, text);
      if (!this.#sessions.has(s.handle.id)) break;
      this.#emit(s, { t: 'status', state: outcome === 'cancelled' ? 'cancelled' : 'idle' });
      if (outcome === 'cancelled') break;
    }
    s.busy = false;
  }

  async #turn(s: MockSession, text: string): Promise<'done' | 'cancelled'> {
    const say = /^SAY (.+)$/.exec(text);
    if (say) return this.#reply(s, `You said ${say[1]}.`, 2);
    if (text === 'WHO') return this.#reply(s, `model=${s.model} context=${s.context.join('|')}`, 1);
    if (text === 'SLOW') return this.#reply(s, 'slow '.repeat(100), 100);
    if (text === 'RUN_TOOL') return this.#tool(s);
    return this.#reply(s, 'ok', 1);
  }

  async #reply(s: MockSession, text: string, chunks: number): Promise<'done' | 'cancelled'> {
    const streaming = this.#caps.streaming && !this.#lie.streaming;
    const parts = streaming ? splitInto(text, chunks) : [text];
    for (const part of parts) {
      if (s.interrupted) return 'cancelled';
      await sleep(this.#tick);
      if (s.interrupted) return 'cancelled';
      this.#emit(s, { t: 'message.delta', text: part });
    }
    this.#usage(s, text.length);
    return 'done';
  }

  #usage(s: MockSession, outputChars: number): void {
    const u = this.#caps.usage;
    if (!u.live || this.#lie.usage) return;
    this.#emit(s, {
      t: 'usage',
      inputTokens: 100,
      outputTokens: Math.ceil(outputChars / 4),
      ...(u.context ? { contextUsed: 1000, contextMax: 200_000 } : {}),
      ...(u.cost !== 'none' ? { costUsd: 0.001 } : {}),
      model: s.model,
      source: u.cost === 'reported' ? 'reported' : 'estimated',
    });
  }

  async #tool(s: MockSession): Promise<'done' | 'cancelled'> {
    const callId = `call-${s.handle.id}-${Math.random().toString(36).slice(2, 8)}`;
    this.#emit(s, { t: 'tool.call', id: callId, name: 'Bash', input: { command: 'touch x' } });
    let allowed = true;
    if (this.#caps.approvals === 'roundtrip' && !this.#lie.approvals) {
      const requestId = `approval-${callId}`;
      const decision = await new Promise<ApprovalDecision>((resolve) => {
        s.approvals.set(requestId, resolve);
        this.#emit(s, {
          t: 'approval.request',
          id: requestId,
          summary: 'Run `touch x`',
          toolName: 'Bash',
          options: ['allow_once', 'allow_always', 'reject', 'cancel'],
        });
      });
      if (decision.kind === 'cancel') return 'cancelled';
      allowed = decision.kind === 'allow_once' || decision.kind === 'allow_always';
    }
    this.#emit(s, {
      t: 'tool.result',
      id: callId,
      ok: allowed,
      summary: allowed ? 'ran' : 'denied',
    });
    return this.#reply(s, allowed ? 'Tool finished.' : 'Tool was denied.', 1);
  }
}

function splitInto(text: string, n: number): string[] {
  const size = Math.max(1, Math.ceil(text.length / n));
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
