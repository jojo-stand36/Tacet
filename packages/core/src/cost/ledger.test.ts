import { describe, expect, it } from 'vitest';
import { project } from '../events/projection.js';
import type { EventEnvelope } from '../schema/envelope.js';
import { budgetKey, costLedgerProjection, rootTaskId } from './ledger.js';
import { BUILTIN_PRICES, costOf, priceFor } from './pricing.js';

describe('priceFor (#35)', () => {
  it('matches an id exactly, without a context suffix, and a dated snapshot with its alias', () => {
    expect(priceFor('claude-sonnet-5-5', BUILTIN_PRICES)).toEqual({
      inputPerMTok: 2,
      outputPerMTok: 10,
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
    const tier = (input: number, output: number) => ({
      aboveInputTokens: 200_000,
      inputPerMTok: input,
      outputPerMTok: output,
    });
    for (const [model, price] of Object.entries({
      'gemini-3.8-flash': { inputPerMTok: 0.75, outputPerMTok: 3.75, until: '2026-12-31' },
      'gemini-3.5-flash-lite': { inputPerMTok: 0.3, outputPerMTok: 2.5 },
      'gemini-3.1-flash-lite': { inputPerMTok: 0.25, outputPerMTok: 1.5 },
      'gemini-3.1-pro-preview': { inputPerMTok: 2, outputPerMTok: 12, longContext: tier(4, 18) },
      'gemini-3.1-pro-preview-customtools': {
        inputPerMTok: 2,
        outputPerMTok: 12,
        longContext: tier(4, 18),
      },
      'gemini-3-flash-preview': { inputPerMTok: 0.5, outputPerMTok: 3 },
      'gemini-2.5-pro': {
        inputPerMTok: 1.25,
        outputPerMTok: 10,
        longContext: tier(2.5, 15),
        until: '2026-11-30',
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
      // 3.8 Flash's introductory price holds through 2026-12-31; 2.5 Pro is billed as 3.8 Flash
      // from 2026-12-01, so its own price holds through 2026-11-30.
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
    expect(l.tasks.B).toMatchObject({ usd: 0, unpricedTokens: 1_000_000 });
    expect(l.tasks.C?.usd).toBe(0.125);
    expect(l.tasks.D).toMatchObject({ usd: 0, unpricedTokens: 100_000 });
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
