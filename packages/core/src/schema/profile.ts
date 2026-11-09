import { z } from 'zod';
import { openEnum, TokenCount } from './common.js';

/**
 * Reasoning effort a Worker session runs at (#110). The known values are the union of the
 * vendors' levels (Claude: `low`..`max`; Codex adds `minimal`). Adapters pass the value to the
 * vendor unchanged and refuse one their model cannot take, so the fallback only matters for
 * events from newer versions: an unknown level is read as `medium`.
 */
export const Effort = openEnum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], 'medium');
export type Effort = z.infer<typeof Effort>;

/**
 * What a Worker session runs on (#110): the model, its reasoning effort and its context window.
 * Chosen per session by the Mini-conductor's policy within the bounds config sets, and recorded
 * with its reason in the `worker.profile` event.
 */
export const SessionProfile = z.object({
  model: z.string().min(1).max(256),
  effort: Effort.optional(),
  /**
   * Context window in tokens, when it is larger than the model's default (e.g. `1000000`).
   * Absent: the default window. A cost lever, off by default: Tacet hands off at the threshold
   * first and opts in only when config allows it and the task cannot be handed off cleanly.
   */
  contextWindow: TokenCount.positive().optional(),
});
export type SessionProfile = z.infer<typeof SessionProfile>;
