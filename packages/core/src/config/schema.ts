import { z } from 'zod';

/**
 * Tacet configuration (ARCHITECTURE.md §4). Config is written by people, so enums here are
 * strict: a typo is an error, not a silent fallback (unlike wire-protocol enums). Keys use
 * snake_case, as in the YAML files.
 */

const Fraction = z.number().gt(0).lt(1);
const NonEmpty = z.string().min(1);

export const TierConfig = z.strictObject({
  adapter: NonEmpty,
  model: NonEmpty,
  effort: z.enum(['low', 'medium', 'high']).optional(),
  cross_vendor: z.boolean().optional(),
});
export type TierConfig = z.infer<typeof TierConfig>;

/** A secret is never written into config; it is referenced from the environment or keychain. */
export const SecretRef = z.union([
  z.strictObject({
    env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'expected an environment variable name'),
  }),
  z.strictObject({ keychain: NonEmpty.describe('service/account in the OS keychain') }),
]);
export type SecretRef = z.infer<typeof SecretRef>;

/**
 * An agent the user can run as a Worker. `acp` agents are used through the generic ACP adapter
 * as `acp:<slug>` (Omnigent's custom ACP agents); `pty` presets drive a CLI through the PTY
 * adapter (Gas Town's provider presets).
 */
export const AgentPreset = z.strictObject({
  kind: z.enum(['acp', 'pty']),
  command: z.array(NonEmpty).min(1).describe('argv; the first element is the executable'),
  env: z.record(z.string(), SecretRef).optional().describe('Environment from secret references'),
  ready_prompt: z.string().optional().describe('PTY: text that shows the CLI is ready for input'),
  resume_flag: z.string().optional().describe('PTY: flag that resumes the last session'),
  process_name: z.string().optional().describe('PTY: process name to watch'),
});
export type AgentPreset = z.infer<typeof AgentPreset>;

/**
 * Policy rule (Omnigent's ALLOW/DENY/ASK model). Rules from every layer are kept; evaluation
 * (#25) checks task, then local, then repo, then user rules, and a `deny` anywhere wins.
 */
export const PolicyRule = z.strictObject({
  tool: NonEmpty.optional().describe('Tool name, e.g. Bash'),
  match: NonEmpty.optional().describe('Glob on the tool input summary, e.g. "rm -rf *"'),
  decision: z.enum(['allow', 'deny', 'ask']),
  reason: z.string().optional(),
});
export type PolicyRule = z.infer<typeof PolicyRule>;

export const TacetConfig = z.strictObject({
  tiers: z.record(NonEmpty, TierConfig).optional(),
  escalation: z
    .strictObject({
      autonomy: z.enum(['low', 'medium', 'high']).optional(),
      always_ask: z.array(NonEmpty).optional(),
    })
    .optional(),
  handoff: z
    .strictObject({ warn: Fraction, handoff: Fraction, hard: Fraction })
    .partial()
    .optional(),
  verify: z.array(NonEmpty).optional(),
  budget: z
    .strictObject({
      per_task_usd: z.number().nonnegative(),
      per_day_usd: z.number().nonnegative(),
      api_key_per_month_usd: z.number().nonnegative(),
    })
    .partial()
    .optional(),
  /**
   * Owner rule (2026-11-09): API key for parallel or unattended Workers, own login for interactive
   * use. `unattended` accepts only `api_key` (owner decision on #65): Tacet never runs parallel or
   * unattended Workers on a subscription login.
   */
  auth: z
    .strictObject({
      unattended: z.literal('api_key', {
        error:
          'auth.unattended must be "api_key": parallel or unattended Workers never use a subscription login (owner decision, issue #65). Set auth.interactive to use your own login for interactive sessions.',
      }),
      interactive: z.enum(['api_key', 'subscription']),
    })
    .partial()
    .optional(),
  agents: z
    .record(
      z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'agent slugs are lowercase-kebab'),
      AgentPreset,
    )
    .optional(),
  policies: z.array(PolicyRule).optional(),
  /** Event log (#6): where it lives and how long transcript-grade events are kept. */
  events: z
    .strictObject({
      state_dir: NonEmpty.optional().describe(
        'Defaults to ~/.tacet/state; the DB is <state_dir>/<repo-hash>/events.db',
      ),
      retention: z
        .strictObject({ transcript_days: z.number().int().positive() })
        .partial()
        .optional(),
    })
    .optional(),
  secrets: z.record(NonEmpty, SecretRef).optional(),
});
/** One config file as written: every key is optional. */
export type TacetConfig = z.infer<typeof TacetConfig>;

/** Built-in defaults: the lowest layer. */
export const DEFAULT_CONFIG = {
  escalation: { autonomy: 'medium', always_ask: [] },
  handoff: { warn: 0.55, handoff: 0.7, hard: 0.85 },
  verify: [],
  budget: { api_key_per_month_usd: 200 },
  auth: { unattended: 'api_key', interactive: 'subscription' },
  policies: [],
  events: { retention: { transcript_days: 30 } },
} satisfies TacetConfig;

/** Checks that only make sense on the merged result. */
export function validateEffective(config: TacetConfig): string[] {
  const errors: string[] = [];
  const h = config.handoff;
  if (h?.warn !== undefined && h.handoff !== undefined && h.hard !== undefined) {
    if (!(h.warn < h.handoff && h.handoff < h.hard)) {
      errors.push('handoff: expected warn < handoff < hard');
    }
  }
  return errors;
}
