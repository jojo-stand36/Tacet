import { z } from 'zod';
import { Id, openEnum, Ulid, Usd } from './common.js';

/**
 * What a budget cap applies to (#35): one root task (`task.budget.usd`, else
 * `budget.per_task_usd`), one UTC day of this repo's spend (`budget.per_day_usd`), or one calendar
 * month (`budget.api_key_per_month_usd`). Unknown values read as `task`, the narrowest.
 */
export const BudgetScope = openEnum(['task', 'day', 'month'], 'task');
export type BudgetScope = z.infer<typeof BudgetScope>;

/**
 * Payload of `budget.exceeded` (#35): the spend in `scope` reached its cap, so the
 * Mini-conductor stopped the Workers it covers and starts none until the cap is raised.
 * `key` names the instance: the root task id, the UTC day (`YYYY-MM-DD`) or the month (`YYYY-MM`).
 */
export const BudgetExceeded = z.object({
  scope: BudgetScope,
  key: Id,
  capUsd: Usd,
  spentUsd: Usd,
  /**
   * Tokens whose cost is not known (a model with no price and no reported cost): the spend may be
   * higher than `spentUsd`.
   */
  unpricedTokens: z.number().int().nonnegative().optional(),
  escalationId: Ulid.optional().describe('The Escalation that asks the user to raise the cap'),
});
export type BudgetExceeded = z.infer<typeof BudgetExceeded>;

/**
 * Payload of `budget.raised` (#35): the user's answer to a `budget.exceeded` Escalation set a new
 * cap for that scope and key. Only the user raises a cap; nothing else writes this event.
 */
export const BudgetRaised = z.object({
  scope: BudgetScope,
  key: Id,
  capUsd: Usd,
  escalationId: Ulid.optional(),
});
export type BudgetRaised = z.infer<typeof BudgetRaised>;
