import type { Projection } from '../events/projection.js';
import { Usage } from '../schema/agent-event.js';
import {
  BudgetExceeded,
  BudgetRaised,
  type BudgetScope,
  BudgetThreshold,
  BudgetUnpriced,
} from '../schema/budget.js';
import type { EventEnvelope } from '../schema/envelope.js';
import { WorkerProfile, WorkerStarted } from '../schema/worker.js';
import { costOf, type PricingTable, priceOn } from './pricing.js';

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
  /** Worker session id → its session profile (`profileKey`), from its latest `worker.profile`. */
  sessionProfiles: Record<string, string>;
  /**
   * `profileKey` → spend of the Worker sessions that ran on that profile (#356): what each
   * model, effort and context window cost. Sessions with no `worker.profile` (the planner, the
   * gate's reasoning, the reviewer) are not in it. A reported cost goes to the session's latest
   * profile. The key is for display: not a stable API.
   */
  profiles: Record<string, Spend>;
  /** `scope:key` → the soft thresholds the user was already told about. */
  thresholds: Record<string, number[]>;
  /** Model → the latest question about running it with no known cost, and its answer. */
  unpriced: Record<string, BudgetUnpriced>;
  /**
   * Worker session id → what its usage added since the session last reported a cost: priced
   * estimates and unpriced tokens. A later reported cost replaces them (it covers the same calls),
   * so an adapter that sends tokens per call and the cost per turn (claude-sdk, ACP) is not
   * counted twice.
   */
  provisional: Record<string, Provisional[]>;
}

/**
 * A session's provisional estimates in one set of buckets (root task and UTC day, so month, and
 * its profile at the time).
 */
interface Provisional {
  root: string;
  day: string;
  month: string;
  profile?: string | undefined;
  usd: number;
  tokens: number;
}

/**
 * The key a session profile's spend is kept under (#356): model, effort and context window, each
 * `default` when the profile left it to the vendor.
 */
export function profileKey(p: {
  model?: string | undefined;
  effort?: string | undefined;
  contextWindow?: number | undefined;
}): string {
  return `${p.model ?? 'default model'} / effort ${p.effort ?? 'default'} / window ${p.contextWindow ?? 'default'}`;
}

/** Config's `budget` caps, as `capOf` reads them. */
export interface BudgetCaps {
  per_task_usd?: number | undefined;
  per_day_usd?: number | undefined;
  api_key_per_month_usd?: number | undefined;
}

/**
 * The cap on one budget (#35, #356), or undefined when there is none: a raise the user made
 * (`budget.raised`) wins, then for a task its own budget (`taskBudgetUsd`, `task.budget.usd` of
 * the root task), then config's. One rule for the hard caps and the escalation gate.
 */
export function capOf(
  ledger: CostLedger,
  scope: BudgetScope,
  key: string,
  caps: BudgetCaps | undefined,
  taskBudgetUsd?: number,
): number | undefined {
  const raised = ledger.raised[budgetKey(scope, key)];
  if (raised !== undefined) return raised;
  if (scope === 'task') return taskBudgetUsd ?? caps?.per_task_usd;
  if (scope === 'day') return caps?.per_day_usd;
  return caps?.api_key_per_month_usd;
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

/** Take a provisional share back out of a bucket. */
function remove(prev: Spend | undefined, usd: number, tokens: number): Spend {
  const s = prev ?? empty();
  return {
    ...s,
    usd: micro(Math.max(0, s.usd - usd)),
    estimatedUsd: micro(Math.max(0, s.estimatedUsd - usd)),
    unpricedTokens: Math.max(0, s.unpricedTokens - tokens),
  };
}
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
 * counted as unpriced, never guessed. Those estimates are provisional per session: a cost the
 * session reports later replaces them. Days and months are UTC, by the event's timestamp.
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
      sessionProfiles: {},
      profiles: {},
      thresholds: {},
      unpriced: {},
      provisional: {},
    }),
    apply(state, e: EventEnvelope) {
      switch (e.type) {
        case 'worker.started':
        case 'worker.profile': {
          const d = (e.type === 'worker.started' ? WorkerStarted : WorkerProfile).safeParse(e.data);
          if (!d.success) return state;
          const p = e.type === 'worker.profile' ? WorkerProfile.safeParse(e.data) : undefined;
          const next = p?.success
            ? {
                ...state,
                sessionProfiles: {
                  ...state.sessionProfiles,
                  [p.data.sessionId]: profileKey(p.data),
                },
              }
            : state;
          if (!d.data.model) return next;
          return {
            ...next,
            sessionModels: { ...next.sessionModels, [d.data.sessionId]: d.data.model },
          };
        }
        case 'agent.usage': {
          const u = Usage.safeParse(e.data);
          if (!u.success || !e.taskId) return state;
          const { inputTokens, outputTokens, costUsd } = u.data;
          const sid = e.sessionId;
          const model = u.data.model ?? (sid ? state.sessionModels[sid] : undefined);
          let next = state;
          let usd = 0;
          let estimated = 0;
          let unpriced = 0;
          if (costUsd !== undefined) {
            usd = costUsd;
            // The reported cost covers the session's calls since its last report: take their
            // provisional estimates and unpriced tokens back out first.
            const back = sid ? state.provisional[sid] : undefined;
            if (sid && back) {
              const tasks = { ...state.tasks };
              const days = { ...state.days };
              const months = { ...state.months };
              const profiles = { ...state.profiles };
              for (const b of back) {
                tasks[b.root] = remove(tasks[b.root], b.usd, b.tokens);
                days[b.day] = remove(days[b.day], b.usd, b.tokens);
                months[b.month] = remove(months[b.month], b.usd, b.tokens);
                if (b.profile !== undefined) {
                  profiles[b.profile] = remove(profiles[b.profile], b.usd, b.tokens);
                }
              }
              const { [sid]: _settled, ...provisional } = state.provisional;
              next = { ...state, tasks, days, months, profiles, provisional };
            }
          } else {
            // The price in force on the event's UTC day: a promotion ends, a later price or
            // another model's takes over (#363).
            const price = priceOn(model, e.ts.slice(0, 10), table);
            if (price) {
              estimated = costOf(price, inputTokens, outputTokens, {
                read: u.data.cacheReadTokens,
                write: u.data.cacheWriteTokens,
              });
              usd = estimated;
            } else unpriced = inputTokens + outputTokens;
          }
          if (usd === 0 && unpriced === 0) return next;
          const root = rootTaskId(e.taskId);
          const day = e.ts.slice(0, 10);
          const month = e.ts.slice(0, 7);
          const profile = sid ? next.sessionProfiles[sid] : undefined;
          // Kept as running sums per bucket, so a long session's estimates stay a few entries.
          let provisional = next.provisional;
          if (sid && costUsd === undefined) {
            const shares = [...(next.provisional[sid] ?? [])];
            const i = shares.findIndex(
              (p) => p.root === root && p.day === day && p.profile === profile,
            );
            const prior = i < 0 ? undefined : shares[i];
            const share = {
              root,
              day,
              month,
              profile,
              usd: (prior?.usd ?? 0) + estimated,
              tokens: (prior?.tokens ?? 0) + unpriced,
            };
            if (i < 0) shares.push(share);
            else shares[i] = share;
            provisional = { ...next.provisional, [sid]: shares };
          }
          return {
            ...next,
            provisional,
            tasks: {
              ...next.tasks,
              [root]: add(next.tasks[root], usd, estimated, unpriced, model),
            },
            days: { ...next.days, [day]: add(next.days[day], usd, estimated, unpriced, model) },
            months: {
              ...next.months,
              [month]: add(next.months[month], usd, estimated, unpriced, model),
            },
            ...(profile !== undefined
              ? {
                  profiles: {
                    ...next.profiles,
                    [profile]: add(next.profiles[profile], usd, estimated, unpriced, model),
                  },
                }
              : {}),
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
        case 'budget.threshold': {
          const d = BudgetThreshold.safeParse(e.data);
          if (!d.success) return state;
          const k = budgetKey(d.data.scope, d.data.key);
          const told = state.thresholds[k] ?? [];
          if (told.includes(d.data.thresholdUsd)) return state;
          return {
            ...state,
            thresholds: { ...state.thresholds, [k]: [...told, d.data.thresholdUsd] },
          };
        }
        case 'budget.unpriced': {
          const d = BudgetUnpriced.safeParse(e.data);
          if (!d.success) return state;
          if (d.data.withdrawn) {
            // The answer is forgotten (#361): nothing recorded, so the model is asked about again.
            const { [d.data.model]: _gone, ...unpriced } = state.unpriced;
            return { ...state, unpriced };
          }
          return { ...state, unpriced: { ...state.unpriced, [d.data.model]: d.data } };
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
