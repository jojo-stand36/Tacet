import { describe, expect, it } from 'vitest';
import { project } from '../events/projection.js';
import type { EventEnvelope } from '../schema/envelope.js';
import { budgetKey, capOf, costLedgerProjection, profileKey, rootTaskId } from './ledger.js';
import { BUILTIN_PRICES, costOf, type PricingTable, priceFor, priceOn } from './pricing.js';

describe('priceFor (#35)', () => {
  it('matches an id exactly, without a context suffix, and a dated snapshot with its alias', () => {
    expect(priceFor('claude-sonnet-5-5', BUILTIN_PRICES)).toEqual({
      inputPerMTok: 2,
      outputPerMTok: 10,
      cacheReadPerMTok: 0.1,
      cacheWritePerMTok: 2.5,
    });
    expect(priceFor('claude-opus-5-5[1m]', BUILTIN_PRICES)?.inputPerMTok).toBe(4);
    // The table holds the dated id; Claude Code may report the undated alias.
    expect(priceFor('claude-haiku-4-5', BUILTIN_PRICES)?.inputPerMTok).toBe(1);
    expect(priceFor('claude-haiku-4-5-20251001', BUILTIN_PRICES)?.inputPerMTok).toBe(1);
  });

  it('has no price for a model it does not name, rather than a neighbour', () => {
    for (const m of [
      undefined,
      '',
      'sonnet',
      'claude-sonnet',
      'claude-sonnet-5-5-fast',
      'gemini-3-pro-preview',
    ]) {
      expect(priceFor(m, BUILTIN_PRICES), String(m)).toBeUndefined();
    }
  });
});

describe('costOf with the cache (#355)', () => {
  it('prices a cache-heavy claude-sdk usage sequence within 5% of the list-price bill', () => {
    // An agent loop on Opus 5.5: each call reads the conversation so far from the cache, writes
    // the newest turn to it, and sends a little uncached input. Usage as claude-sdk reports it:
    // `inputTokens` counts all three, the cache fields say how much of it was cache.
    const calls = Array.from({ length: 40 }, (_, i) => ({
      uncached: 300,
      read: 20_000 + i * 2_500,
      write: 2_500,
      output: 800,
    }));
    const l = project(
      costLedgerProjection(BUILTIN_PRICES),
      calls.map((c) =>
        usage(
          {
            inputTokens: c.uncached + c.read + c.write,
            outputTokens: c.output,
            cacheReadTokens: c.read,
            cacheWriteTokens: c.write,
            model: 'claude-opus-5-5',
          },
          { taskId: 'T/1', sessionId: 's' },
        ),
      ),
    );
    // The bill at list price: $4 input, $0.20 cache read, $5 cache write (5 minutes), $20 output.
    const bill = calls.reduce(
      (sum, c) => sum + (c.uncached * 4 + c.read * 0.2 + c.write * 5 + c.output * 20) / 1e6,
      0,
    );
    const priced = l.tasks.T?.usd ?? 0;
    expect(Math.abs(priced - bill) / bill).toBeLessThan(0.05);
    // Without the split it would be several times the bill.
    const flat = calls.reduce(
      (sum, c) => sum + ((c.uncached + c.read + c.write) * 4 + c.output * 20) / 1e6,
      0,
    );
    expect(flat / bill).toBeGreaterThan(3);
  });

  it('charges cache at the input rate where the price has no cache rate, and never more cache than input', () => {
    const plain = { inputPerMTok: 1, outputPerMTok: 2 };
    expect(costOf(plain, 1_000_000, 0, { read: 900_000, write: 50_000 })).toBeCloseTo(1, 9);
    const p = { inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25 };
    // A malformed report: more cache than input. The input is all cache read, no write.
    expect(costOf(p, 100, 0, { read: 500, write: 500 })).toBeCloseTo((100 * 0.1) / 1e6, 12);
    // Negative counts are no cache.
    expect(costOf(p, 100, 0, { read: -5 })).toBeCloseTo(100 / 1e6, 12);
    // The long-context tier has its own cache rate (OpenAI: above 272,000 input tokens).
    const sol = priceFor('gpt-6.1-sol', BUILTIN_PRICES);
    if (!sol) throw new Error('no price');
    expect(costOf(sol, 300_000, 0, { read: 200_000 })).toBeCloseTo(
      (100_000 * 4 + 200_000 * 0.2) / 1e6,
      9,
    );
  });
});

describe('costOf', () => {
  it('prices input and output, and the long-context rate above its threshold', () => {
    const sonnet = priceFor('claude-sonnet-5-5', BUILTIN_PRICES);
    if (!sonnet) throw new Error('no price');
    expect(costOf(sonnet, 1_000_000, 100_000)).toBeCloseTo(3, 9);
    const haiku = priceFor('claude-haiku-5-5', BUILTIN_PRICES);
    if (!haiku) throw new Error('no price');
    expect(costOf(haiku, 100_000, 0)).toBeCloseTo(0.01, 9);
    expect(costOf(haiku, 100_001, 0)).toBeCloseTo(0.0500005, 9);
  });
});

let seq = 0;
const env = (
  type: string,
  data: unknown,
  extra: { taskId?: string; sessionId?: string; ts?: string } = {},
): EventEnvelope => ({
  v: 1,
  id: `01J${String(++seq).padStart(23, '0')}`,
  ts: extra.ts ?? '2026-11-16T10:00:00.000Z',
  source: { kind: 'mini', id: 'm' },
  type,
  data,
  ...(extra.taskId ? { taskId: extra.taskId } : {}),
  ...(extra.sessionId ? { sessionId: extra.sessionId } : {}),
});
const usage = (data: Record<string, unknown>, extra: Parameters<typeof env>[2]) =>
  env(
    'agent.usage',
    { t: 'usage', source: 'reported', inputTokens: 0, outputTokens: 0, ...data },
    extra,
  );

describe('costLedgerProjection (#35)', () => {
  const ledger = (events: EventEnvelope[]) => project(costLedgerProjection(BUILTIN_PRICES), events);

  it('sums reported and priced costs per root task, UTC day and month', () => {
    const l = ledger([
      // The planner's usage is on the root task; a Worker's on its sub-task.
      usage({ inputTokens: 10, outputTokens: 10, costUsd: 0.5 }, { taskId: 'T1' }),
      env('worker.started', { sessionId: 's1', model: 'claude-sonnet-5-5' }, { taskId: 'T1/1' }),
      // No reported cost and no model on the event: priced by the session's model.
      usage({ inputTokens: 1_000_000, outputTokens: 0 }, { taskId: 'T1/1', sessionId: 's1' }),
      usage(
        { inputTokens: 0, outputTokens: 0, costUsd: 0.25 },
        { taskId: 'T2', ts: '2026-11-17T00:00:01.000Z' },
      ),
    ]);
    expect(l.tasks.T1).toEqual({
      usd: 2.5,
      estimatedUsd: 2,
      unpricedTokens: 0,
      unpricedModels: [],
    });
    expect(l.tasks.T2?.usd).toBe(0.25);
    expect(l.days['2026-11-16']?.usd).toBe(2.5);
    expect(l.days['2026-11-17']?.usd).toBe(0.25);
    expect(l.months['2026-11']?.usd).toBe(2.75);
  });

  it('lets a cost the session reports later replace its estimates, as claude-sdk and ACP send them', () => {
    const l = ledger([
      env('worker.started', { sessionId: 's', model: 'claude-opus-5-5' }, { taskId: 'T/1' }),
      // Per call: tokens and model, no cost (priced provisionally: $1 each).
      usage({ inputTokens: 200_000, outputTokens: 10_000 }, { taskId: 'T/1', sessionId: 's' }),
      usage({ inputTokens: 200_000, outputTokens: 10_000 }, { taskId: 'T/1', sessionId: 's' }),
      // Turn end: the real cost of those calls, with no tokens.
      usage({ inputTokens: 0, outputTokens: 0, costUsd: 0.7 }, { taskId: 'T/1', sessionId: 's' }),
      // The next call is provisional again, on top of what was reported.
      usage({ inputTokens: 200_000, outputTokens: 10_000 }, { taskId: 'T/1', sessionId: 's' }),
    ]);
    expect(l.tasks.T).toMatchObject({ usd: 1.7, estimatedUsd: 1 });
    expect(l.days['2026-11-16']?.usd).toBe(1.7);
    // Estimates are kept as one running sum per bucket, however many calls a session makes.
    const many = ledger(
      Array.from({ length: 50 }, () =>
        usage(
          { inputTokens: 1000, outputTokens: 0, model: 'claude-opus-5-5' },
          { taskId: 'T/1', sessionId: 's' },
        ),
      ),
    );
    expect(many.provisional.s).toHaveLength(1);
    expect(many.provisional.s?.[0]?.usd).toBeCloseTo(many.tasks.T?.estimatedUsd ?? -1, 9);
    // A report also settles tokens that had no price.
    const settled = ledger([
      usage(
        { inputTokens: 5, outputTokens: 5, model: 'gemini-x' },
        { taskId: 'T', sessionId: 'g' },
      ),
      usage({ inputTokens: 0, outputTokens: 0, costUsd: 0.01 }, { taskId: 'T', sessionId: 'g' }),
    ]);
    expect(settled.tasks.T).toMatchObject({ usd: 0.01, unpricedTokens: 0 });
  });

  it('counts tokens of a model with no price as unpriced, never guessed', () => {
    const l = ledger([
      usage(
        { inputTokens: 700, outputTokens: 300, model: 'gemini-3-pro-preview' },
        { taskId: 'T/1' },
      ),
      usage({ inputTokens: 5, outputTokens: 5 }, { taskId: 'T/1', sessionId: 'unknown-session' }),
    ]);
    expect(l.tasks.T).toEqual({
      usd: 0,
      estimatedUsd: 0,
      unpricedTokens: 1010,
      unpricedModels: ['gemini-3-pro-preview', 'unknown'],
    });
  });

  it('prices a promotional rate only through its last day', () => {
    const l = ledger([
      usage(
        { inputTokens: 100_000, outputTokens: 0, model: 'gpt-5.6-sol' },
        { taskId: 'A', ts: '2026-11-30T23:59:59.000Z' },
      ),
      usage(
        { inputTokens: 100_000, outputTokens: 0, model: 'gpt-5.6-sol' },
        { taskId: 'B', ts: '2026-12-01T00:00:00.000Z' },
      ),
    ]);
    expect(l.tasks.A?.usd).toBe(0.4);
    expect(l.tasks.B).toMatchObject({
      usd: 0,
      unpricedTokens: 100_000,
      unpricedModels: ['gpt-5.6-sol'],
    });
  });

  it('applies the OpenAI long-context rate above 272,000 input tokens', () => {
    const sol = priceFor('gpt-6.1-sol', BUILTIN_PRICES);
    if (!sol) throw new Error('no price');
    expect(costOf(sol, 272_000, 0)).toBeCloseTo(0.544, 9);
    expect(costOf(sol, 272_001, 0)).toBeCloseTo(1.088004, 9);
  });

  it('prices the Gemini models on Google’s page, with their tiers and end dates (#357)', () => {
    const pro = priceFor('gemini-3.1-pro-preview', BUILTIN_PRICES);
    if (!pro) throw new Error('no price');
    // $2 / $12 up to 200,000 prompt tokens, $4 / $18 above.
    expect(costOf(pro, 200_000, 1_000_000)).toBeCloseTo(12.4, 9);
    expect(costOf(pro, 200_001, 1_000_000)).toBeCloseTo(18.800004, 9);
    // Every entry as transcribed from the page's Standard tab, paid tier.
    const tier = (input: number, output: number, read: number) => ({
      aboveInputTokens: 200_000,
      inputPerMTok: input,
      outputPerMTok: output,
      cacheReadPerMTok: read,
    });
    for (const [model, price] of Object.entries({
      'gemini-3.8-flash': {
        inputPerMTok: 0.75,
        outputPerMTok: 3.75,
        cacheReadPerMTok: 0.075,
        until: '2026-12-31',
        later: [
          {
            from: '2027-01-01',
            price: { inputPerMTok: 1.5, outputPerMTok: 7.5, cacheReadPerMTok: 0.15 },
          },
        ],
      },
      'gemini-3.5-flash-lite': { inputPerMTok: 0.3, outputPerMTok: 2.5, cacheReadPerMTok: 0.03 },
      'gemini-3.1-flash-lite': { inputPerMTok: 0.25, outputPerMTok: 1.5, cacheReadPerMTok: 0.025 },
      'gemini-3.1-pro-preview': {
        inputPerMTok: 2,
        outputPerMTok: 12,
        cacheReadPerMTok: 0.2,
        longContext: tier(4, 18, 0.4),
      },
      'gemini-3.1-pro-preview-customtools': {
        inputPerMTok: 2,
        outputPerMTok: 12,
        cacheReadPerMTok: 0.2,
        longContext: tier(4, 18, 0.4),
      },
      'gemini-3-flash-preview': { inputPerMTok: 0.5, outputPerMTok: 3, cacheReadPerMTok: 0.05 },
      'gemini-2.5-pro': {
        inputPerMTok: 1.25,
        outputPerMTok: 10,
        cacheReadPerMTok: 0.125,
        longContext: tier(2.5, 15, 0.25),
        until: '2026-11-30',
        later: [{ from: '2026-12-01', billedAs: 'gemini-3.8-flash' }],
      },
    })) {
      expect(priceFor(model, BUILTIN_PRICES), model).toEqual(price);
    }
    // Gemini CLI 0.67.0 models the page does not list stay unpriced.
    for (const m of [
      'gemini-3-pro-preview',
      'gemini-3.5-flash',
      'gemini-3-flash',
      'gemma-4-31b-it',
    ]) {
      expect(priceFor(m, BUILTIN_PRICES), m).toBeUndefined();
    }
    const l = ledger([
      // 3.8 Flash's introductory price holds through 2026-12-31, its later one from 2027-01-01;
      // 2.5 Pro is billed as 3.8 Flash from 2026-12-01 (#363).
      usage(
        { inputTokens: 1_000_000, outputTokens: 0, model: 'gemini-3.8-flash' },
        { taskId: 'A', ts: '2026-12-31T23:59:59.000Z' },
      ),
      usage(
        { inputTokens: 1_000_000, outputTokens: 0, model: 'gemini-3.8-flash' },
        { taskId: 'B', ts: '2027-01-01T00:00:00.000Z' },
      ),
      usage(
        { inputTokens: 100_000, outputTokens: 0, model: 'gemini-2.5-pro' },
        { taskId: 'C', ts: '2026-11-30T12:00:00.000Z' },
      ),
      usage(
        { inputTokens: 100_000, outputTokens: 0, model: 'gemini-2.5-pro' },
        { taskId: 'D', ts: '2026-12-01T00:00:00.000Z' },
      ),
    ]);
    expect(l.tasks.A?.usd).toBe(0.75);
    expect(l.tasks.B).toMatchObject({ usd: 1.5, unpricedTokens: 0 });
    expect(l.tasks.C?.usd).toBe(0.125);
    expect(l.tasks.D).toMatchObject({ usd: 0.075, unpricedTokens: 0 });
  });

  it('takes the price in force on the day: a later price, or the model it is billed as (#363)', () => {
    // Acceptance: 3.8 Flash on 2027-01-01 at $1.50 / $7.50.
    expect(priceOn('gemini-3.8-flash', '2026-12-31', BUILTIN_PRICES)).toEqual({
      inputPerMTok: 0.75,
      outputPerMTok: 3.75,
      cacheReadPerMTok: 0.075,
    });
    expect(priceOn('gemini-3.8-flash', '2027-01-01', BUILTIN_PRICES)).toEqual({
      inputPerMTok: 1.5,
      outputPerMTok: 7.5,
      cacheReadPerMTok: 0.15,
    });
    // Acceptance: 2.5 Pro from 2026-12-01 at 3.8 Flash's rate for that day, which itself changes.
    expect(priceOn('gemini-2.5-pro', '2026-11-30', BUILTIN_PRICES)?.inputPerMTok).toBe(1.25);
    expect(priceOn('gemini-2.5-pro', '2026-12-01', BUILTIN_PRICES)).toEqual({
      inputPerMTok: 0.75,
      outputPerMTok: 3.75,
      cacheReadPerMTok: 0.075,
    });
    expect(priceOn('gemini-2.5-pro', '2027-02-01', BUILTIN_PRICES)?.outputPerMTok).toBe(7.5);
    // Acceptance: a price whose later rate is not known still ends on its last day.
    expect(priceOn('gpt-5.6-sol', '2026-11-30', BUILTIN_PRICES)?.inputPerMTok).toBe(4);
    expect(priceOn('gpt-5.6-sol', '2026-12-01', BUILTIN_PRICES)).toBeUndefined();
    // A later step before its `from`, a model billed as one with no price, and a loop.
    const table: PricingTable = {
      a: { inputPerMTok: 1, outputPerMTok: 1, later: [{ from: '2027-01-01', billedAs: 'b' }] },
      b: { inputPerMTok: 2, outputPerMTok: 2, later: [{ from: '2027-01-01', billedAs: 'a' }] },
      c: { inputPerMTok: 3, outputPerMTok: 3, later: [{ from: '2027-01-01', billedAs: 'none' }] },
    };
    expect(priceOn('a', '2026-12-31', table)?.inputPerMTok).toBe(1);
    expect(priceOn('a', '2027-01-01', table)).toBeUndefined();
    expect(priceOn('c', '2027-01-01', table)).toBeUndefined();
    // A user price for the model billed as replaces it there too.
    expect(
      priceOn('gemini-2.5-pro', '2026-12-01', {
        ...BUILTIN_PRICES,
        'gemini-3.8-flash': { inputPerMTok: 9, outputPerMTok: 9 },
      })?.inputPerMTok,
    ).toBe(9);
  });

  it('keeps every later price in date order, after the entry it follows', () => {
    for (const [model, price] of Object.entries(BUILTIN_PRICES)) {
      const froms = (price.later ?? []).map((l) => l.from);
      expect(froms, model).toEqual([...froms].sort());
      if (price.until !== undefined && froms[0] !== undefined) {
        expect(froms[0] > price.until, model).toBe(true);
      }
      for (const l of price.later ?? []) {
        if ('billedAs' in l) expect(priceFor(l.billedAs, BUILTIN_PRICES), model).toBeDefined();
      }
    }
  });

  it('takes a cap from a raise, then the task budget, then config (#356)', () => {
    const caps = { per_task_usd: 3, per_day_usd: 20, api_key_per_month_usd: 200 };
    const none = ledger([]);
    expect(capOf(none, 'task', 'T', caps)).toBe(3);
    expect(capOf(none, 'task', 'T', caps, 1.5)).toBe(1.5);
    expect(capOf(none, 'task', 'T', undefined)).toBeUndefined();
    expect(capOf(none, 'day', '2026-11-16', caps)).toBe(20);
    expect(capOf(none, 'month', '2026-11', caps)).toBe(200);
    const raised = ledger([env('budget.raised', { scope: 'task', key: 'T', capUsd: 9 })]);
    expect(capOf(raised, 'task', 'T', caps, 1.5)).toBe(9);
    expect(capOf(raised, 'task', 'U', caps, 1.5)).toBe(1.5);
  });

  it('keeps spend per session profile, with reported costs replacing estimates (#356)', () => {
    const fast = { model: 'claude-sonnet-5-5', effort: 'low' };
    const deep = { model: 'claude-opus-5-5', effort: 'high', contextWindow: 1_000_000 };
    const R = { model: 'm', effort: 'e', contextWindow: 'w' };
    const l = ledger([
      env('worker.profile', { sessionId: 'a', ...fast, reasons: R }, { taskId: 'T/1' }),
      env('worker.profile', { sessionId: 'b', ...deep, reasons: R }, { taskId: 'T/2' }),
      // a: two calls priced from the table ($2 each), then the turn's real cost.
      usage({ inputTokens: 1_000_000, outputTokens: 0 }, { taskId: 'T/1', sessionId: 'a' }),
      usage({ inputTokens: 1_000_000, outputTokens: 0 }, { taskId: 'T/1', sessionId: 'a' }),
      // A session with no profile recorded: in the task's spend only.
      usage({ inputTokens: 0, outputTokens: 0, costUsd: 3 }, { taskId: 'T/1', sessionId: 'b2' }),
      usage({ inputTokens: 0, outputTokens: 0, costUsd: 3.5 }, { taskId: 'T/1', sessionId: 'a' }),
      // b: one estimate, no report: $4.
      usage({ inputTokens: 1_000_000, outputTokens: 0 }, { taskId: 'T/2', sessionId: 'b' }),
      // The planner has no profile: in the task's spend, not in a profile's.
      usage({ inputTokens: 0, outputTokens: 0, costUsd: 1 }, { taskId: 'T' }),
    ]);
    expect(profileKey(fast)).toBe('claude-sonnet-5-5 / effort low / window default');
    expect(l.profiles[profileKey(fast)]).toMatchObject({ usd: 3.5, estimatedUsd: 0 });
    expect(l.profiles[profileKey(deep)]).toMatchObject({ usd: 4, estimatedUsd: 4 });
    expect(Object.keys(l.profiles)).toHaveLength(2);
    expect(l.tasks.T?.usd).toBe(11.5);
  });

  it('keeps the latest exceeded cap until the user raises it', () => {
    const k = budgetKey('task', 'T');
    const exceeded = ledger([
      env('budget.exceeded', { scope: 'task', key: 'T', capUsd: 2, spentUsd: 2.1 }),
    ]);
    expect(exceeded.exceeded[k]).toMatchObject({ capUsd: 2, spentUsd: 2.1 });
    const raised = ledger([
      env('budget.exceeded', { scope: 'task', key: 'T', capUsd: 2, spentUsd: 2.1 }),
      env('budget.raised', { scope: 'task', key: 'T', capUsd: 5 }),
    ]);
    expect(raised.exceeded[k]).toBeUndefined();
    expect(raised.raised[k]).toBe(5);
  });

  it('forgets an answer about an unpriced model when it is withdrawn (#361)', () => {
    const asked = env('budget.unpriced', {
      model: 'm',
      escalationId: '01JZZZZZZZZZZZZZZZZZZZZZZ1',
    });
    const refused = env('budget.unpriced', {
      model: 'm',
      escalationId: '01JZZZZZZZZZZZZZZZZZZZZZZ1',
      allowed: false,
    });
    const other = env('budget.unpriced', { model: 'n', allowed: true });
    const withdrawn = env('budget.unpriced', { model: 'm', withdrawn: true });
    expect(ledger([asked, refused, other]).unpriced.m).toMatchObject({ allowed: false });
    const l = ledger([asked, refused, other, withdrawn]);
    expect(l.unpriced.m).toBeUndefined();
    expect(l.unpriced.n).toMatchObject({ allowed: true });
    // Asked and answered again after it: the new answer stands.
    const again = ledger([
      asked,
      refused,
      withdrawn,
      { ...refused, data: { model: 'm', allowed: true } },
    ]);
    expect(again.unpriced.m).toMatchObject({ allowed: true });
    // `withdrawn` is only ever true.
    expect(
      ledger([refused, env('budget.unpriced', { model: 'm', withdrawn: false })]).unpriced.m,
    ).toMatchObject({ allowed: false });
  });

  it('ignores malformed events', () => {
    const l = ledger([
      env('agent.usage', { t: 'usage', inputTokens: -1 }, { taskId: 'T' }),
      env('budget.raised', { scope: 'task' }),
    ]);
    expect(l.tasks).toEqual({});
    expect(l.raised).toEqual({});
  });

  it('names the root of a sub-task', () => {
    expect(rootTaskId('01JROOT/3')).toBe('01JROOT');
    expect(rootTaskId('01JROOT')).toBe('01JROOT');
  });
});
