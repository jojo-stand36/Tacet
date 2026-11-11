import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AdapterCapabilities,
  AgentAdapter,
  AgentEvent,
  AgentTerminal,
  ApprovalDecision,
  SessionHandle,
  SessionOptions,
  SessionState,
  UserInput,
} from '@tacet/core';
import { Channel, MOCK_CAPABILITIES } from '@tacet/core/testing';
import type { Workspace, Workspaces } from './ports.js';

/**
 * What a scripted Worker does with one input. `reply` ends the turn idle with that text;
 * `error` ends the session in error; `hold` keeps the turn running until `release()`; `tool-hold` starts a tool call that never ends;
 * `approval` asks for an approval first, then replies with whether it was granted.
 */
export type Script =
  | { do: 'reply'; text: string }
  | { do: 'error'; message: string }
  | { do: 'hold' }
  | { do: 'vanish' }
  | { do: 'tool-hold' }
  | { do: 'auth' }
  | { do: 'approval'; toolName?: string; grant?: unknown };

interface FakeSession {
  handle: SessionHandle;
  opts: SessionOptions;
  events: Channel<AgentEvent>;
  state: SessionState;
  inputs: string[];
  held?: (() => void) | undefined;
  approvals: Map<string, (d: ApprovalDecision) => void>;
}

/** A scripted adapter for daemon tests: no vendor, deterministic, records everything. */
export class ScriptedAdapter implements AgentAdapter {
  readonly id: string;
  readonly sessions: FakeSession[] = [];
  readonly approvalsAnswered: ApprovalDecision[] = [];
  /** Highest number of sessions open at once. */
  maxConcurrent = 0;
  /** Milliseconds `close()` takes, like a vendor process that exits slowly. */
  closeDelayMs = 0;
  /** Make the next `send()` calls throw. */
  failSends = 0;
  /** Milliseconds `start()` takes. */
  startDelayMs = 0;
  /** When set, `start()` waits for it: a test decides when a session finishes starting. */
  startGate: Promise<void> | undefined;
  readonly #script: (input: string, session: FakeSession) => Script;
  readonly #open = new Set<FakeSession>();
  #n = 0;

  constructor(id: string, script: (input: string, session: FakeSession) => Script) {
    this.id = id;
    this.#script = script;
  }

  capabilities(): AdapterCapabilities {
    return structuredClone(MOCK_CAPABILITIES);
  }

  /** Make every resume fail, as for a vendor session that can no longer be found. */
  failResumes = false;

  async start(opts: SessionOptions): Promise<SessionHandle> {
    if (this.startDelayMs > 0) await new Promise((r) => setTimeout(r, this.startDelayMs));
    if (this.startGate) await this.startGate;
    if (this.failResumes && opts.resume) throw new Error('no such session to resume');
    const n = ++this.#n;
    const handle: SessionHandle = {
      id: `${this.id}-${n}`,
      vendorSessionId: opts.resume?.vendorSessionId ?? `vendor-${this.id}-${n}`,
    };
    const s: FakeSession = {
      handle,
      opts,
      events: new Channel(),
      state: 'idle',
      inputs: [],
      approvals: new Map(),
    };
    this.sessions.push(s);
    this.#open.add(s);
    this.maxConcurrent = Math.max(this.maxConcurrent, this.#open.size);
    this.#emit(s, { t: 'status', state: 'idle' });
    return handle;
  }

  async send(h: SessionHandle, input: UserInput): Promise<void> {
    const s = this.#get(h);
    if (this.failSends > 0) {
      this.failSends -= 1;
      throw new Error('send failed');
    }
    s.inputs.push(input.text);
    queueMicrotask(() => void this.#turn(s, input.text));
  }

  async interrupt() {
    return {};
  }

  async respond(h: SessionHandle, id: string, decision: ApprovalDecision): Promise<void> {
    const s = this.#get(h);
    this.approvalsAnswered.push(decision);
    s.approvals.get(id)?.(decision);
    s.approvals.delete(id);
  }

  async close(h: SessionHandle): Promise<void> {
    const s = this.sessions.find((x) => x.handle.id === h.id);
    if (!s || !this.#open.has(s)) return;
    if (this.closeDelayMs > 0) await new Promise((r) => setTimeout(r, this.closeDelayMs));
    this.#open.delete(s);
    s.held?.();
    this.#emit(s, { t: 'status', state: 'done' });
    s.events.end();
  }

  events(h: SessionHandle): AsyncIterable<AgentEvent> {
    return this.#get(h).events;
  }

  /** Sessions the Mini-conductor said will never be resumed (#153). */
  readonly discarded: { vendorSessionId: string; cwd: string }[] = [];

  async discard(vendorSessionId: string, cwd: string): Promise<void> {
    this.discarded.push({ vendorSessionId, cwd });
  }

  status(h: SessionHandle): SessionState {
    return this.sessions.find((x) => x.handle.id === h.id)?.state ?? 'done';
  }

  /** Let every held turn finish with `text`. */
  release(text = 'done after hold'): void {
    for (const s of this.#open) {
      const held = s.held;
      if (held) {
        s.held = undefined;
        held();
        this.#emit(s, { t: 'message.delta', text });
        this.#emit(s, { t: 'status', state: 'idle' });
      }
    }
  }

  get open(): number {
    return this.#open.size;
  }

  async #turn(s: FakeSession, input: string): Promise<void> {
    if (!this.#open.has(s)) return;
    this.#emit(s, { t: 'status', state: 'running' });
    const step = this.#script(input, s);
    if (step.do === 'reply') {
      for (const part of step.text.match(/\S+\s*/g) ?? [step.text]) {
        this.#emit(s, { t: 'message.delta', text: part });
      }
      this.#emit(s, { t: 'usage', inputTokens: 10, outputTokens: 2, source: 'estimated' });
      this.#emit(s, { t: 'status', state: 'idle' });
    } else if (step.do === 'error') {
      this.#emit(s, { t: 'status', state: 'error', message: step.message });
    } else if (step.do === 'vanish') {
      // The vendor process went away: the stream ends without an error event.
      this.#open.delete(s);
      s.events.end();
    } else if (step.do === 'auth') {
      this.#emit(s, { t: 'status', state: 'auth_required', message: 'invalid API key' });
    } else if (step.do === 'tool-hold') {
      this.#emit(s, {
        t: 'tool.call',
        id: `tool-${s.handle.id}`,
        name: 'Bash',
        input: { command: 'pnpm test' },
      });
      await new Promise<void>((resolve) => {
        s.held = resolve;
      });
    } else if (step.do === 'hold') {
      await new Promise<void>((resolve) => {
        s.held = resolve;
      });
    } else {
      const id = `appr-${s.handle.id}`;
      const decision = await new Promise<ApprovalDecision>((resolve) => {
        s.approvals.set(id, resolve);
        this.#emit(s, {
          t: 'approval.request',
          id,
          summary: 'Run: rm -rf build',
          toolName: step.toolName ?? 'Bash',
          ...(step.grant !== undefined ? { requestedGrant: step.grant } : {}),
        });
      });
      if (!this.#open.has(s)) return;
      this.#emit(s, { t: 'message.delta', text: `approval ${decision.kind}` });
      this.#emit(s, { t: 'status', state: 'idle' });
    }
  }

  #emit(s: FakeSession, e: AgentEvent): void {
    if (e.t === 'status') s.state = e.state;
    s.events.push(e);
  }

  #get(h: SessionHandle): FakeSession {
    const s = this.sessions.find((x) => x.handle.id === h.id);
    if (!s || !this.#open.has(s)) throw new Error(`unknown or closed session ${h.id}`);
    return s;
  }
}

/** Temp-dir workspaces that survive a daemon restart (same object reused). */
export class TempWorkspaces implements Workspaces {
  readonly root = mkdtempSync(join(tmpdir(), 'tacet-mini-ws-'));
  readonly created: string[] = [];
  readonly #all = new Map<string, Workspace>();

  async create(workerId: string): Promise<Workspace> {
    const id = `ws-${workerId.replace(/[^\w.-]/g, '_')}`;
    const path = join(this.root, id);
    mkdirSync(path, { recursive: true });
    const ws = { id, path };
    this.#all.set(id, ws);
    this.created.push(id);
    return ws;
  }

  async get(id: string): Promise<Workspace | undefined> {
    return this.#all.get(id);
  }

  async remove(id: string): Promise<void> {
    const ws = this.#all.get(id);
    if (ws) rmSync(ws.path, { recursive: true, force: true });
    this.#all.delete(id);
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

/**
 * A Worker terminal a test writes to (#201), with the PTY adapter's viewer rules: `push` is the
 * Worker printing; `lag()` drops every viewer as one that fell too far behind is dropped, losing
 * what it had not read yet; `end()` is the session ending; a viewer's `return()` drops it.
 */
export class ScriptedTerminal implements AgentTerminal {
  readonly cols = 80;
  readonly rows = 24;
  #screen = '';
  #ended = false;
  readonly #viewers = new Set<{ chunks: string[]; ended: boolean; wake?: () => void }>();

  push(data: string): void {
    if (this.#ended) return;
    this.#screen += data;
    for (const v of this.#viewers) {
      v.chunks.push(data);
      v.wake?.();
    }
  }

  lag(): void {
    for (const v of [...this.#viewers]) this.#drop(v);
  }

  end(): void {
    this.#ended = true;
    this.lag();
  }

  /** Streams open now. */
  get viewers(): number {
    return this.#viewers.size;
  }

  scrollback(): string {
    return this.#screen;
  }

  output(): AsyncIterable<string> {
    const v: { chunks: string[]; ended: boolean; wake?: () => void } = {
      chunks: [],
      ended: this.#ended,
    };
    if (!this.#ended) this.#viewers.add(v);
    return {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<string>> => {
          while (v.chunks.length === 0 && !v.ended) {
            await new Promise<void>((r) => {
              v.wake = r;
            });
          }
          const chunk = v.chunks.shift();
          return chunk === undefined
            ? { value: undefined, done: true }
            : { value: chunk, done: false };
        },
        return: async (): Promise<IteratorResult<string>> => {
          this.#drop(v);
          return { value: undefined, done: true };
        },
      }),
    };
  }

  #drop(v: { chunks: string[]; ended: boolean; wake?: () => void }): void {
    v.ended = true;
    v.chunks.length = 0;
    this.#viewers.delete(v);
    v.wake?.();
  }
}

/** A `ScriptedAdapter` whose sessions have a terminal, as PTY Workers do (#201). */
export class ScriptedTerminalAdapter extends ScriptedAdapter {
  readonly #terms = new Map<string, ScriptedTerminal>();
  /** Whether closing a session ends its terminal. Off: a terminal that outlives its session. */
  endOnClose = true;

  terminal(h: SessionHandle): ScriptedTerminal {
    const t = this.#terms.get(h.id) ?? new ScriptedTerminal();
    this.#terms.set(h.id, t);
    return t;
  }

  override async close(h: SessionHandle): Promise<void> {
    await super.close(h);
    if (this.endOnClose) this.#terms.get(h.id)?.end();
  }
}
