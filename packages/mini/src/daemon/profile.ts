import {
  type AdapterCapabilities,
  EFFORT_LEVELS,
  effortRank,
  type ProfileField,
  type ProfileReasons,
  type TierConfig,
} from '@tacet/core';

/** What the policy chose for one Worker session, and why (the `worker.profile` event). */
export interface ChosenProfile {
  model?: string;
  effort?: string;
  contextWindow?: number;
  reasons: ProfileReasons;
}

export interface ProfileInput {
  /** The tier's role in config, e.g. `worker` or `review`; for messages. */
  role: string;
  tier: TierConfig;
  capabilities: AdapterCapabilities;
  /** Failed attempts of this sub-task so far. */
  failedAttempts: number;
  /** The planner marked the sub-task as one that cannot be handed off cleanly part-way. */
  indivisible: boolean;
}

/** A profile outside the configured bounds: refused before launch. */
export class ProfileOutOfBoundsError extends Error {
  override readonly name = 'ProfileOutOfBoundsError';
}

/**
 * Choose a Worker session's model, effort and context window within the tier's bounds (#110).
 *
 * - Model: the tier's `model`, else the first of `models`, else the adapter's default.
 * - Effort: the tier's `effort`. With `escalate_effort_on_retry` (off by default; the retry policy
 *   itself is #34) it rises one level per failed attempt, up to `max_effort`. An adapter that
 *   declares no `effortSwitch` gets none, and the reason says so.
 * - Context window: the default, so Tacet hands off at the threshold. A larger one only for an
 *   indivisible sub-task, when `max_context_window` allows it: the largest size the adapter lists
 *   that fits.
 *
 * Budget headroom is not an input yet: the cost ledger is #35.
 */
export function chooseProfile(i: ProfileInput): ChosenProfile {
  const { role, tier } = i;
  const at = `tiers.${role}`;
  const out: Omit<ChosenProfile, 'reasons'> = {};

  let modelWhy: string;
  const model = tier.model ?? tier.models?.[0];
  if (model !== undefined) {
    if (tier.models && !tier.models.includes(model)) {
      throw new ProfileOutOfBoundsError(`model ${model} is not in ${at}.models`);
    }
    out.model = model;
    modelWhy = tier.model !== undefined ? `${at}.model` : `first of ${at}.models`;
  } else {
    modelWhy = "the adapter's default";
  }

  let effortWhy: string;
  const max = tier.max_effort !== undefined ? effortRank(tier.max_effort) : undefined;
  if (tier.effort !== undefined) {
    const base = effortRank(tier.effort);
    if (base === undefined) throw new ProfileOutOfBoundsError(`unknown effort ${tier.effort}`);
    if (max !== undefined && base > max) {
      throw new ProfileOutOfBoundsError(`effort ${tier.effort} is above ${at}.max_effort`);
    }
    let rank = base;
    effortWhy = `${at}.effort`;
    if (tier.escalate_effort_on_retry && i.failedAttempts > 0) {
      if (max === undefined) {
        // Config validation rejects this combination; kept for direct callers.
        effortWhy += `; not raised after ${i.failedAttempts} failed attempt(s): no ${at}.max_effort`;
      } else {
        rank = Math.min(base + i.failedAttempts, max);
        effortWhy =
          rank > base
            ? `raised from ${tier.effort} after ${i.failedAttempts} failed attempt(s) (${at}.max_effort ${tier.max_effort})`
            : `${at}.effort; already at ${at}.max_effort`;
      }
    }
    const effort = EFFORT_LEVELS[rank] as string;
    if (i.capabilities.effortSwitch) {
      out.effort = effort;
    } else {
      effortWhy = `none; the adapter cannot set effort (${effort} not sent)`;
    }
  } else {
    effortWhy = "the model's default";
  }

  let windowWhy: string;
  if (!i.indivisible) {
    windowWhy = 'default; hand off at the threshold';
  } else if (tier.max_context_window === undefined) {
    windowWhy = `default; indivisible, but ${at}.max_context_window is not set`;
  } else {
    const cap = tier.max_context_window;
    const fits = (i.capabilities.contextSizes ?? []).filter((n) => n <= cap);
    if (fits.length === 0) {
      windowWhy = `default; indivisible, but the adapter offers no window up to ${cap}`;
    } else {
      out.contextWindow = Math.max(...fits);
      windowWhy = `the sub-task cannot be handed off cleanly (${at}.max_context_window ${cap})`;
    }
  }
  return { ...out, reasons: { model: modelWhy, effort: effortWhy, contextWindow: windowWhy } };
}

/**
 * The profile to try after the adapter refused `field` of `p` (`ProfileRefusedError`), or
 * `undefined` when there is none: a refused model is not something a retry can fix.
 *
 * - Effort: the next lower level, down to the tier's own `effort`, so a refused raise falls back
 *   within the bounds. When even that is refused, the model's default effort: a cost lever is not
 *   worth failing the sub-task over. That default is the vendor's and is not checked against
 *   `max_effort`.
 * - Context window: the default; Tacet hands off at the threshold instead.
 */
export function afterRefusal(
  p: ChosenProfile,
  field: ProfileField,
  role: string,
  tier: TierConfig,
): ChosenProfile | undefined {
  const at = `tiers.${role}`;
  if (field === 'effort' && p.effort !== undefined) {
    const { effort: refused, ...rest } = p;
    const rank = effortRank(refused);
    const floor = tier.effort !== undefined ? effortRank(tier.effort) : undefined;
    if (rank !== undefined && floor !== undefined && rank > floor) {
      const lower = EFFORT_LEVELS[rank - 1] as string;
      return {
        ...rest,
        effort: lower,
        reasons: {
          ...p.reasons,
          effort: `${lower}; the adapter refused ${refused} (floor ${at}.effort)`,
        },
      };
    }
    return {
      ...rest,
      reasons: {
        ...p.reasons,
        effort: `the model's default; the adapter refused ${refused}, and nothing lower is within ${at}`,
      },
    };
  }
  if (field === 'contextWindow' && p.contextWindow !== undefined) {
    const { contextWindow: refused, ...rest } = p;
    return {
      ...rest,
      reasons: {
        ...p.reasons,
        contextWindow: `default; the adapter refused ${refused}; hand off at the threshold`,
      },
    };
  }
  return undefined;
}
