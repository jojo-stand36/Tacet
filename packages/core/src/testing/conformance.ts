import type {
  AdapterCapabilities,
  AgentAdapter,
  SendOptions,
  SessionHandle,
  SessionOptions,
} from '../adapter/types.js';
import { AgentEvent, type SessionState } from '../schema/agent-event.js';
import { KNOWN_EFFORTS } from '../schema/profile.js';

/**
 * Conformance bench for `AgentAdapter` implementations, after Omnigent's harness test bench
 * (ADR-001): each probe compares what the adapter declares in `capabilities()` with what it
 * does, and reports `drift` when they disagree. P0 probes gate CI; P1 probes only report.
 * Adapters run it against recorded fixtures or a local mock, never live vendor calls in CI.
 */

export type Verdict = 'pass' | 'fail' | 'drift' | 'skip';

export interface ProbeResult {
  id: string;
  priority: 'P0' | 'P1';
  verdict: Verdict;
  detail: string;
}

/** How to drive a particular adapter through the probes. */
export interface ConformanceScenario {
  /** Session options for every probe session. */
  session: SessionOptions;
  /** A prompt that produces a short streamed reply (at least `minDeltas` deltas if streaming). */
  replyPrompt: string;
  /** A prompt that makes the agent call a tool needing approval. */
  approvalPrompt: string;
  /** A prompt that produces a long-running turn, for interrupt probes. */
  slowPrompt: string;
  /** Prompt whose reply reveals the model and injected context (P1 probes); optional. */
  echoPrompt?: string;
  /** A model to switch to in the model-switch probe. */
  altModel?: string;
  /** An effort the scenario's model accepts, for the effort probe (#110). */
  altEffort?: string;
  /**
   * The effort the vendor received in its latest model request for `prompt`, e.g. read from a
   * mock API's request log. Without it the effort probe is skipped: adapter events do not carry it.
   */
  sentEffort?: (prompt: string) => unknown;
  /**
   * How to check that the first listed context window is applied, not only accepted. `session`
   * is merged into `session` (e.g. a model the window is offered for); `applied(prompt)` says
   * whether the vendor's latest request for `prompt` used it. Without it, only refusal of an
   * unlisted window is checked.
   */
  contextWindow?: { session?: Partial<SessionOptions>; applied: (prompt: string) => boolean };
  /**
   * Whether the vendor has begun the slow turn, e.g. from a mock API's request log. A
   * non-streaming adapter shows no text mid-turn, so the interrupt probe waits for this before it
   * interrupts. Without it, it waits a fixed moment after `running`.
   */
  slowTurnStarted?: () => boolean;
  minDeltas?: number;
  timeoutMs?: number;
}

const TURN_END: ReadonlySet<SessionState> = new Set(['idle', 'cancelled', 'error', 'done']);

/** Collects a session's events and lets probes wait for specific ones. */
export class EventTap {
  readonly events: AgentEvent[] = [];
  readonly invalid: unknown[] = [];
  #ended = false;
  #listeners: (() => void)[] = [];
  readonly done: Promise<void>;

  constructor(source: AsyncIterable<AgentEvent>) {
    this.done = (async () => {
      for await (const e of source) {
        const parsed = AgentEvent.safeParse(e);
        if (parsed.success) this.events.push(parsed.data);
        else this.invalid.push(e);
        this.#notify();
      }
      this.#ended = true;
      this.#notify();
    })();
  }

  get ended(): boolean {
    return this.#ended;
  }

  #notify(): void {
    const ls = this.#listeners;
    this.#listeners = [];
    for (const l of ls) l();
  }

  /** Resolve with the first event at or after `from` that matches, or reject after `timeoutMs`. */
  async waitFor(
    pred: (e: AgentEvent) => boolean,
    timeoutMs: number,
    from = 0,
  ): Promise<{ event: AgentEvent; index: number }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.events.findIndex((e, i) => i >= from && pred(e));
      const event = this.events[index];
      if (index >= 0 && event) return { event, index };
      if (this.#ended) throw new Error('event stream ended');
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('timed out');
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.#listeners.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }
}

interface Ctx {
  adapter: AgentAdapter;
  caps: AdapterCapabilities;
  sc: ConformanceScenario;
  timeout: number;
}

type Probe = {
  id: string;
  priority: 'P0' | 'P1';
  run: (ctx: Ctx) => Promise<Omit<ProbeResult, 'id' | 'priority'>>;
};

const pass = (detail: string) => ({ verdict: 'pass' as const, detail });
const fail = (detail: string) => ({ verdict: 'fail' as const, detail });
const drift = (detail: string) => ({ verdict: 'drift' as const, detail });
const skip = (detail: string) => ({ verdict: 'skip' as const, detail });

/** Start a session, run `body`, and always close it. */
async function withSession<T>(
  ctx: Ctx,
  body: (h: SessionHandle, tap: EventTap) => Promise<T>,
  opts: SessionOptions = ctx.sc.session,
): Promise<T> {
  const h = await ctx.adapter.start(opts);
  const tap = new EventTap(ctx.adapter.events(h));
  try {
    return await body(h, tap);
  } finally {
    await ctx.adapter.close(h).catch(() => {});
  }
}

/** Send `text` and wait for the turn to end. Returns the events of that turn. */
async function turn(ctx: Ctx, h: SessionHandle, tap: EventTap, text: string, opts?: SendOptions) {
  const from = tap.events.length;
  await ctx.adapter.send(h, { text }, opts);
  const running = await tap.waitFor(
    (e) => e.t === 'status' && e.state === 'running',
    ctx.timeout,
    from,
  );
  const end = await tap.waitFor(
    (e) => e.t === 'status' && TURN_END.has(e.state),
    ctx.timeout,
    running.index + 1,
  );
  return tap.events.slice(from, end.index + 1);
}

/** How long the interrupt probe lets a non-streaming adapter's slow turn run first. */
const NON_STREAMING_SETTLE_MS = 2000;

const PROBES: Probe[] = [
  {
    id: 'start',
    priority: 'P0',
    run: (ctx) =>
      withSession(ctx, async (h) => {
        const state = ctx.adapter.status(h);
        if (state !== 'idle' && state !== 'running') return fail(`status after start is ${state}`);
        return pass('session is ready after start()');
      }),
  },
  {
    id: 'events-valid',
    priority: 'P0',
    run: (ctx) =>
      withSession(ctx, async (h, tap) => {
        await turn(ctx, h, tap, ctx.sc.replyPrompt);
        if (tap.invalid.length > 0)
          return fail(`${tap.invalid.length} event(s) are not valid AgentEvents`);
        return pass(`${tap.events.length} events, all valid`);
      }),
  },
  {
    id: 'stream',
    priority: 'P0',
    run: (ctx) =>
      withSession(ctx, async (h, tap) => {
        const events = await turn(ctx, h, tap, ctx.sc.replyPrompt);
        const deltas = events.filter((e) => e.t === 'message.delta').length;
        if (deltas === 0) return fail('no message.delta in the reply');
        const streamed = deltas >= (ctx.sc.minDeltas ?? 2);
        if (ctx.caps.streaming && !streamed)
          return drift(`declares streaming but sent ${deltas} delta(s)`);
        if (!ctx.caps.streaming && streamed)
          return drift(`declares no streaming but sent ${deltas} deltas`);
        return pass(`${deltas} delta(s), streaming=${ctx.caps.streaming}`);
      }),
  },
  {
    id: 'usage',
    priority: 'P0',
    run: (ctx) =>
      withSession(ctx, async (h, tap) => {
        const events = await turn(ctx, h, tap, ctx.sc.replyPrompt);
        const usage = events.filter((e) => e.t === 'usage');
        const u = ctx.caps.usage;
        if (u.live && usage.length === 0)
          return drift('declares live usage but sent no usage event');
        if (!u.live)
          return usage.length > 0
            ? drift('declares no live usage but sent usage')
            : pass('no live usage, as declared');
        const withContext = usage.every(
          (e) => e.t === 'usage' && e.contextUsed !== undefined && e.contextMax !== undefined,
        );
        if (u.context && !withContext)
          return drift('declares context usage but contextUsed/contextMax missing');
        const withCost = usage.some((e) => e.t === 'usage' && e.costUsd !== undefined);
        if (u.cost !== 'none' && !withCost)
          return drift(`declares cost=${u.cost} but sent no costUsd`);
        return pass(`${usage.length} usage event(s)`);
      }),
  },
  {
    id: 'approval-roundtrip',
    priority: 'P0',
    run: async (ctx) => {
      if (ctx.caps.approvals !== 'roundtrip') return skip(`approvals=${ctx.caps.approvals}`);
      const decide = (kind: 'allow_once' | 'reject') =>
        withSession(ctx, async (h, tap) => {
          const from = tap.events.length;
          await ctx.adapter.send(h, { text: ctx.sc.approvalPrompt });
          let req: Awaited<ReturnType<EventTap['waitFor']>>;
          try {
            req = await tap.waitFor((e) => e.t === 'approval.request', ctx.timeout, from);
          } catch {
            return 'no-request' as const;
          }
          if (req.event.t !== 'approval.request') return 'no-request' as const;
          await ctx.adapter.respond(h, req.event.id, { kind, persist: false });
          const result = await tap.waitFor((e) => e.t === 'tool.result', ctx.timeout, req.index);
          await tap.waitFor(
            (e) => e.t === 'status' && TURN_END.has(e.state),
            ctx.timeout,
            result.index,
          );
          return result.event.t === 'tool.result' && result.event.ok
            ? ('ran' as const)
            : ('blocked' as const);
        });
      const allowed = await decide('allow_once');
      if (allowed === 'no-request')
        return drift('declares approval round-trip but sent no approval.request');
      const rejected = await decide('reject');
      if (allowed !== 'ran') return fail('allow_once did not run the tool');
      if (rejected !== 'blocked') return fail('reject did not block the tool');
      return pass('allow_once ran the tool; reject blocked it');
    },
  },
  {
    id: 'interrupt',
    priority: 'P0',
    run: async (ctx) => {
      const mode = ctx.caps.interrupt;
      if (mode === 'none' || mode === 'kill') return skip(`interrupt=${mode}`);
      return withSession(ctx, async (h, tap) => {
        const from = tap.events.length;
        await ctx.adapter.send(h, { text: ctx.sc.slowPrompt });
        const running = await tap.waitFor(
          (e) => e.t === 'status' && e.state === 'running',
          ctx.timeout,
          from,
        );
        // Mid-reply: a streaming adapter shows it with a delta. A non-streaming one (PTY) sends
        // its text only when the turn ends, so it is interrupted a moment after it starts.
        if (ctx.caps.streaming) {
          await tap.waitFor((e) => e.t === 'message.delta', ctx.timeout, running.index);
        } else if (ctx.sc.slowTurnStarted) {
          const until = Date.now() + ctx.timeout;
          while (!ctx.sc.slowTurnStarted()) {
            if (Date.now() > until) return fail('the slow turn never reached the vendor');
            await new Promise((r) => setTimeout(r, 50));
          }
        } else {
          await new Promise((r) => setTimeout(r, NON_STREAMING_SETTLE_MS));
        }
        const result = await ctx.adapter.interrupt(h);
        let end: Awaited<ReturnType<EventTap['waitFor']>>;
        try {
          end = await tap.waitFor(
            (e) => e.t === 'status' && TURN_END.has(e.state),
            ctx.timeout,
            running.index + 1,
          );
        } catch {
          return drift('declares interrupt but the turn did not end');
        }
        if (end.event.t !== 'status' || end.event.state !== 'cancelled') {
          return drift(
            `declares interrupt but the turn ended as ${end.event.t === 'status' ? end.event.state : '?'}`,
          );
        }
        if (mode === 'receipt' && !Array.isArray(result.stillQueued)) {
          return drift('declares an interrupt receipt but returned no stillQueued');
        }
        return pass('turn ended as cancelled');
      });
    },
  },
  {
    id: 'close',
    priority: 'P0',
    run: async (ctx) => {
      const h = await ctx.adapter.start(ctx.sc.session);
      const tap = new EventTap(ctx.adapter.events(h));
      await ctx.adapter.close(h);
      const ended = await Promise.race([
        tap.done.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), ctx.timeout)),
      ]);
      if (!ended) return fail('events() did not complete after close()');
      if (ctx.adapter.status(h) !== 'done')
        return fail(`status after close is ${ctx.adapter.status(h)}`);
      return pass('events completed and status is done');
    },
  },
  {
    id: 'live-input',
    priority: 'P1',
    run: async (ctx) => {
      if (!ctx.caps.liveInput) return skip('liveInput=false');
      return withSession(ctx, async (h, tap) => {
        const from = tap.events.length;
        await ctx.adapter.send(h, { text: ctx.sc.replyPrompt });
        try {
          await ctx.adapter.send(h, { text: ctx.sc.replyPrompt });
        } catch (err) {
          return drift(`declares live input but send() during a turn failed: ${String(err)}`);
        }
        const running = await tap.waitFor(
          (e) => e.t === 'status' && e.state === 'running',
          ctx.timeout,
          from,
        );
        let idles = 0;
        for (let i = running.index; idles < 2; ) {
          const end = await tap.waitFor(
            (e) => e.t === 'status' && e.state === 'idle',
            ctx.timeout,
            i,
          );
          idles++;
          i = end.index + 1;
        }
        return pass('second input ran after the first');
      });
    },
  },
  {
    id: 'resume',
    priority: 'P1',
    run: async (ctx) => {
      if (!ctx.caps.resume) return skip('resume=false');
      const vendorSessionId = await withSession(ctx, async (h, tap) => {
        await turn(ctx, h, tap, ctx.sc.replyPrompt);
        return h.vendorSessionId;
      });
      if (!vendorSessionId) return drift('declares resume but the handle has no vendorSessionId');
      return withSession(
        ctx,
        async (h) =>
          h.vendorSessionId === vendorSessionId
            ? pass('resumed the same vendor session')
            : drift('resume returned a different vendor session'),
        { ...ctx.sc.session, resume: { vendorSessionId } },
      );
    },
  },
  {
    id: 'inject-context',
    priority: 'P1',
    run: async (ctx) => {
      if (!ctx.caps.injectContext) return skip('injectContext=false');
      if (!ctx.adapter.injectContext || !ctx.sc.echoPrompt) {
        return ctx.adapter.injectContext
          ? skip('no echoPrompt in scenario')
          : drift('declares injectContext but does not implement it');
      }
      return withSession(ctx, async (h, tap) => {
        await ctx.adapter.injectContext?.(h, 'probe-context-7');
        const events = await turn(ctx, h, tap, ctx.sc.echoPrompt ?? '');
        const text = events.map((e) => (e.t === 'message.delta' ? e.text : '')).join('');
        return text.includes('probe-context-7')
          ? pass('injected context visible')
          : drift('injected context not visible');
      });
    },
  },
  {
    id: 'model-switch',
    priority: 'P1',
    run: async (ctx) => {
      if (ctx.caps.modelSwitch === 'launch-only') return skip('modelSwitch=launch-only');
      if (!ctx.sc.altModel || !ctx.sc.echoPrompt) return skip('no altModel/echoPrompt in scenario');
      return withSession(ctx, async (h, tap) => {
        const from = tap.events.length;
        const model = ctx.sc.altModel;
        if (!model) return skip('no altModel in scenario');
        await ctx.adapter.send(h, { text: ctx.sc.echoPrompt ?? '' }, { model });
        await tap.waitFor((e) => e.t === 'status' && e.state === 'running', ctx.timeout, from);
        const end = await tap.waitFor(
          (e) => e.t === 'status' && TURN_END.has(e.state),
          ctx.timeout,
          from + 1,
        );
        const usage = tap.events.slice(from, end.index + 1).filter((e) => e.t === 'usage');
        const models = usage.map((e) => (e.t === 'usage' ? e.model : undefined)).filter(Boolean);
        if (models.length === 0) return skip('usage events carry no model');
        return models.includes(ctx.sc.altModel)
          ? pass('switched model')
          : drift('model did not change');
      });
    },
  },
  {
    id: 'effort',
    priority: 'P1',
    run: async (ctx) => {
      const mode = ctx.caps.effortSwitch;
      if (!mode) return skip('no effortSwitch declared');
      const effort = ctx.sc.altEffort;
      const sentEffort = ctx.sc.sentEffort;
      if (!effort || !sentEffort) return skip('no altEffort/sentEffort in scenario');
      const prompt = ctx.sc.replyPrompt;
      const sent = () => sentEffort(prompt);
      // A baseline first, so an adapter that ignores effort cannot pass on the vendor's default.
      const before = await withSession(ctx, async (h, tap) => {
        await turn(ctx, h, tap, prompt);
        return sent();
      });
      if (before === effort) {
        return skip(`the vendor default is already ${effort}; choose another altEffort`);
      }
      if (mode === 'per-session') {
        // Applied at launch; a turn-level change must be refused, not ignored.
        return withSession(
          ctx,
          async (h, tap) => {
            await turn(ctx, h, tap, prompt);
            if (sent() !== effort) return drift(`vendor got ${JSON.stringify(sent())} at launch`);
            try {
              const other = KNOWN_EFFORTS.find((e) => e !== effort) ?? 'low';
              await ctx.adapter.send(h, { text: prompt }, { effort: other });
              return drift('per-session adapter accepted a turn-level effort');
            } catch (err) {
              return isProfileRefusal(err)
                ? pass('effort applied at launch; turn-level change refused')
                : drift(`expected ProfileRefusedError, got ${String(err)}`);
            }
          },
          { ...ctx.sc.session, effort },
        );
      }
      // per-turn: a turn-level change must reach the vendor on that turn.
      return withSession(ctx, async (h, tap) => {
        await turn(ctx, h, tap, prompt);
        await turn(ctx, h, tap, prompt, { effort });
        return sent() === effort
          ? pass(`effort changed from ${JSON.stringify(before)} to ${effort} on the turn`)
          : drift(`vendor got effort ${JSON.stringify(sent())}, not ${effort}`);
      });
    },
  },
  {
    id: 'context-sizes',
    priority: 'P1',
    run: async (ctx) => {
      // An adapter refuses a window it does not list instead of silently using the default.
      const sizes = ctx.caps.contextSizes ?? [];
      let unlisted = 1_234_567;
      while (sizes.includes(unlisted)) unlisted += 1;
      try {
        const h = await ctx.adapter.start({ ...ctx.sc.session, contextWindow: unlisted });
        await ctx.adapter.close(h).catch(() => {});
        return drift(`started with unlisted contextWindow ${unlisted}`);
      } catch (err) {
        if (!isProfileRefusal(err))
          return drift(`expected ProfileRefusedError, got ${String(err)}`);
      }
      // And one it lists is applied, not merely accepted.
      const window = sizes[0];
      const check = ctx.sc.contextWindow;
      if (window === undefined) return pass('unlisted window refused; none listed');
      if (!check)
        return pass('unlisted window refused; listed window not checked (no scenario hook)');
      const prompt = ctx.sc.replyPrompt;
      return withSession(
        ctx,
        async (h, tap) => {
          await turn(ctx, h, tap, prompt);
          return check.applied(prompt)
            ? pass(`unlisted window refused; ${window} applied`)
            : drift(`started with contextWindow ${window} but the vendor did not use it`);
        },
        { ...ctx.sc.session, ...check.session, contextWindow: window },
      );
    },
  },
];

/** Matched by name, so a duplicate copy of `@tacet/core` still counts. */
function isProfileRefusal(err: unknown): boolean {
  return err instanceof Error && err.name === 'ProfileRefusedError';
}

/** Run every probe against `adapter`. Probes never throw; failures become verdicts. */
export async function runConformance(
  adapter: AgentAdapter,
  scenario: ConformanceScenario,
): Promise<ProbeResult[]> {
  const ctx: Ctx = {
    adapter,
    caps: adapter.capabilities(),
    sc: scenario,
    timeout: scenario.timeoutMs ?? 5000,
  };
  const results: ProbeResult[] = [];
  for (const p of PROBES) {
    try {
      results.push({ id: p.id, priority: p.priority, ...(await p.run(ctx)) });
    } catch (err) {
      results.push({ id: p.id, priority: p.priority, verdict: 'fail', detail: String(err) });
    }
  }
  return results;
}

/** Throw if any P0 probe did not pass or skip. P1 results are only reported. */
export function assertConformance(results: ProbeResult[]): void {
  const bad = results.filter(
    (r) => r.priority === 'P0' && r.verdict !== 'pass' && r.verdict !== 'skip',
  );
  if (bad.length > 0) {
    throw new Error(
      `conformance failed:\n${bad.map((r) => `  ${r.id}: ${r.verdict} (${r.detail})`).join('\n')}`,
    );
  }
}

/** One line per probe, for test output and PR descriptions. */
export function formatResults(results: ProbeResult[]): string {
  return results.map((r) => `${r.priority} ${r.verdict.padEnd(5)} ${r.id}: ${r.detail}`).join('\n');
}
