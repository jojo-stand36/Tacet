import { z } from 'zod';
import { TokenCount } from './common.js';

/**
 * Effort levels the verified vendors use (capability matrix, #110). Claude: `low`..`max`;
 * Codex adds `none`, `minimal`, `ultra` and `persistent`; OpenCode variants are named per model.
 */
export const KNOWN_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
  'persistent',
] as const;

/**
 * Reasoning effort a Worker session runs at (#110). An open vocabulary kept verbatim: vendors
 * advertise their levels per model (Codex `model/list`), and reading an unknown level as some
 * fallback would misreport cost (`none` read as `medium`). Adapters refuse a level their model
 * cannot take (`ProfileRefusedError`) rather than pass it on.
 */
export const Effort = z.string().min(1).max(64);
export type Effort = (typeof KNOWN_EFFORTS)[number] | (string & {});

/**
 * The known levels from least to most effort, for config bounds such as `max_effort` (#110).
 * Codex's `persistent` is left out: where it sits in that order is not documented.
 */
export const EFFORT_LEVELS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Position of `effort` in `EFFORT_LEVELS`, or `undefined` for a level outside it. */
export function effortRank(effort: string): number | undefined {
  const i = (EFFORT_LEVELS as readonly string[]).indexOf(effort);
  return i < 0 ? undefined : i;
}

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
