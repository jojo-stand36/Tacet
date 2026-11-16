import type { Projection } from '../events/projection.js';
import { Usage } from '../schema/agent-event.js';
import { BudgetExceeded, BudgetRaised, type BudgetScope } from '../schema/budget.js';
import type { EventEnvelope } from '../schema/envelope.js';
import { WorkerProfile, WorkerStarted } from '../schema/worker.js';
import { costOf, type PricingTable, priceFor } from './pricing.js';

/** Spend in one ledger bucket. */
export interface Spend {
  /** Known spend: costs adapters reported, plus tokens priced from the table. Micro-dollars. */
  usd: number;
  /** The part of `usd` Tacet priced itself (the adapter reported no cost). */
  estimatedUsd: number;
  /** Tokens with no known cost: no reported cost and no price for their model. */
  unpricedTokens: number;
  /** The models those tokens ran on (`unknown` when the event named none). */
  unpricedModels: string[];
}

/** The cost ledger (#35): spend per root task, per UTC day and per month, and the caps raised. */
export interface CostLedger {
  /** Root task id → spend of the task, its sub-tasks and its planner. */
  tasks: Record<string, Spend>;
  /** `YYYY-MM-DD` (UTC) → spend. */
  days: Record<string, Spend>;
  /** `YYYY-MM` (UTC) → spend. */
  months: Record<string, Spend>;
  /** `scope:key` → the cap the user last raised it to. */
  raised: Record<string, number>;
  /** `scope:key` → the latest `budget.exceeded` for it, until a later raise. */
  exceeded: Record<string, BudgetExceeded>;
  /** Worker session id → the model it ran on, for usage events that name none. */
  sessionModels: Record<string, string>;
}

/** The ledger key for a cap: `task:<root>`, `day:<YYYY-MM-DD>` or `month:<YYYY-MM>`. */
export function budgetKey(scope: BudgetScope, key: string): string {
  return `${scope}:${key}`;
}

/** The root task of a task id: sub-task ids are `<root>/<n>` (#17). */
export function rootTaskId(taskId: string): string {
  const slash = taskId.indexOf('/');
  return slash < 0 ? taskId : taskId.slice(0, slash);
}

const empty = (): Spend => ({ usd: 0, estimatedUsd: 0, unpricedTokens: 0, unpricedModels: [] });
/** Micro-dollars, so float addition order cannot change a total. */
const micro = (n: number) => Math.round(n * 1e6) / 1e6;

function add(
  prev: Spend | undefined,
  usd: number,
  estimated: number,
  unpriced: number,
  model?: string,
): Spend {
  const s = prev ?? empty();
  return {
    usd: micro(s.usd + usd),
    estimatedUsd: micro(s.estimatedUsd + estimated),
    unpricedTokens: s.unpricedTokens + unpriced,
    unpricedModels:
      unpriced > 0 && !s.unpricedModels.includes(model ?? 'unknown')
        ? [...s.unpricedModels, model ?? 'unknown']
        : s.unpricedModels,
  };
}

/**
 * The ledger as a projection over the event log, priced with `table` (pure: the same events and
 * table always give the same ledger). Each `agent.usage` event costs what the adapter reported;
 * when it reported nothing, its tokens are priced from the table by the event's model, else the
 * session's (`worker.profile`, `worker.started`); when that model has no price, the tokens are
 * counted as unpriced, never guessed. Days and months are UTC, by the event's timestamp.
 */
export function costLedgerProjection(table: PricingTable): Projection<CostLedger> {
  return {
    name: 'cost-ledger',
    initial: () => ({
      tasks: {},
      days: {},
      months: {},
      raised: {},
      exceeded: {},
      sessionModels: {},
    }),
    apply(state, e: EventEnvelope) {
      switch (e.type) {
        case 'worker.started':
        case 'worker.profile': {
          const d = (e.type === 'worker.started' ? WorkerStarted : WorkerProfile).safeParse(e.data);
          if (!d.success || !d.data.model) return state;
          return {
            ...state,
            sessionModels: { ...state.sessionModels, [d.data.sessionId]: d.data.model },
          };
        }
        case 'agent.usage': {
          const u = Usage.safeParse(e.data);
          if (!u.success || !e.taskId) return state;
          const { inputTokens, outputTokens, costUsd } = u.data;
          const model =
            u.data.model ?? (e.sessionId ? state.sessionModels[e.sessionId] : undefined);
          let usd = 0;
          let estimated = 0;
          let unpriced = 0;
          if (costUsd !== undefined) usd = costUsd;
          else {
            const price = priceFor(model, table);
            if (price) {
              estimated = costOf(price, inputTokens, outputTokens);
              usd = estimated;
            } else unpriced = inputTokens + outputTokens;
          }
          if (usd === 0 && unpriced === 0) return state;
          const root = rootTaskId(e.taskId);
          const day = e.ts.slice(0, 10);
          const month = e.ts.slice(0, 7);
          return {
            ...state,
            tasks: {
              ...state.tasks,
              [root]: add(state.tasks[root], usd, estimated, unpriced, model),
            },
            days: { ...state.days, [day]: add(state.days[day], usd, estimated, unpriced, model) },
            months: {
              ...state.months,
              [month]: add(state.months[month], usd, estimated, unpriced, model),
            },
          };
        }
        case 'budget.exceeded': {
          const d = BudgetExceeded.safeParse(e.data);
          if (!d.success) return state;
          return {
            ...state,
            exceeded: { ...state.exceeded, [budgetKey(d.data.scope, d.data.key)]: d.data },
          };
        }
        case 'budget.raised': {
          const d = BudgetRaised.safeParse(e.data);
          if (!d.success) return state;
          const k = budgetKey(d.data.scope, d.data.key);
          const { [k]: _done, ...exceeded } = state.exceeded;
          return { ...state, raised: { ...state.raised, [k]: d.data.capUsd }, exceeded };
        }
        default:
          return state;
      }
    },
  };
}
