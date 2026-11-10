import type { AdapterCapabilities, TierConfig } from '@tacet/core';
import { describe, expect, it } from 'vitest';
import { chooseProfile, type ProfileInput, ProfileOutOfBoundsError } from './profile.js';

const caps: AdapterCapabilities = {
  streaming: true,
  liveInput: true,
  approvals: 'roundtrip',
  interrupt: 'receipt',
  resume: true,
  fork: 'native',
  usage: { live: true, context: true, cost: 'estimated' },
  modelSwitch: 'mid-session',
  injectContext: false,
  effortSwitch: 'per-turn',
  contextSizes: [1_000_000],
};

const input = (tier: TierConfig, more: Partial<ProfileInput> = {}): ProfileInput => ({
  role: 'worker',
  tier,
  capabilities: caps,
  failedAttempts: 0,
  indivisible: false,
  ...more,
});

describe('chooseProfile (#110)', () => {
  it('uses the tier defaults and keeps the default window, with a reason for each part', () => {
    const p = chooseProfile(input({ adapter: 'claude-sdk', model: 'm1', effort: 'medium' }));
    expect(p).toEqual({
      model: 'm1',
      effort: 'medium',
      reasons: [
        'model: tiers.worker.model',
        'effort: medium, tiers.worker.effort',
        'contextWindow: default; hand off at the threshold',
      ],
    });
  });

  it('takes the first allowed model when no default is set, and the adapter default otherwise', () => {
    expect(chooseProfile(input({ adapter: 'x', models: ['a', 'b'] })).model).toBe('a');
    const none = chooseProfile(input({ adapter: 'x' }));
    expect(none.model).toBeUndefined();
    expect(none.reasons).toContain("model: the adapter's default");
  });

  it('refuses a profile outside the bounds before launch', () => {
    expect(() => chooseProfile(input({ adapter: 'x', model: 'c', models: ['a', 'b'] }))).toThrow(
      ProfileOutOfBoundsError,
    );
    expect(() => chooseProfile(input({ adapter: 'x', effort: 'max', max_effort: 'high' }))).toThrow(
      /above tiers\.worker\.max_effort/,
    );
  });

  it('does not raise effort on retry unless config turns it on (#34 owns the retry policy)', () => {
    const tier: TierConfig = { adapter: 'x', effort: 'low', max_effort: 'high' };
    expect(chooseProfile(input(tier, { failedAttempts: 2 })).effort).toBe('low');
    const on = { ...tier, escalate_effort_on_retry: true };
    expect(chooseProfile(input(on, { failedAttempts: 1 })).effort).toBe('medium');
    const capped = chooseProfile(input(on, { failedAttempts: 5 }));
    expect(capped.effort).toBe('high');
    expect(capped.reasons[1]).toMatch(/raised from low after 5 failed attempt/);
    // Without a ceiling it is never raised.
    const noMax = chooseProfile(
      input({ adapter: 'x', effort: 'low', escalate_effort_on_retry: true }, { failedAttempts: 1 }),
    );
    expect(noMax.effort).toBe('low');
    expect(noMax.reasons[1]).toMatch(/not raised .* no tiers\.worker\.max_effort/);
  });

  it('sends no effort to an adapter that declares none, and says so', () => {
    const { effortSwitch: _, ...noEffort } = caps;
    const p = chooseProfile(
      input({ adapter: 'x', effort: 'high' }, { capabilities: noEffort as AdapterCapabilities }),
    );
    expect(p.effort).toBeUndefined();
    expect(p.reasons[1]).toMatch(/cannot set effort/);
  });

  it('opts into a larger window only for an indivisible sub-task that config allows', () => {
    const allowed: TierConfig = { adapter: 'x', max_context_window: 1_000_000 };
    // Not by default: the cap is absent.
    const off = chooseProfile(input({ adapter: 'x' }, { indivisible: true }));
    expect(off.contextWindow).toBeUndefined();
    expect(off.reasons[2]).toMatch(/max_context_window is not set/);
    // Not for work that can be handed off.
    expect(chooseProfile(input(allowed)).contextWindow).toBeUndefined();
    // Allowed and indivisible: the largest listed size within the cap, with the reason.
    const on = chooseProfile(input(allowed, { indivisible: true }));
    expect(on.contextWindow).toBe(1_000_000);
    expect(on.reasons[2]).toMatch(/cannot be handed off cleanly/);
    // A cap below every listed size keeps the default.
    const small = chooseProfile(
      input({ adapter: 'x', max_context_window: 500_000 }, { indivisible: true }),
    );
    expect(small.contextWindow).toBeUndefined();
    expect(small.reasons[2]).toMatch(/offers no window up to 500000/);
  });
});
