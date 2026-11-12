import { z } from 'zod';
import { ENV_PASS_PATTERN } from '../adapter/env.js';
import { VENDORS } from '../adapter/vendor.js';
import { EFFORT_LEVELS, effortRank } from '../schema/profile.js';

/**
 * Tacet configuration (ARCHITECTURE.md §4). Config is written by people, so enums here are
 * strict: a typo is an error, not a silent fallback (unlike wire-protocol enums). Keys use
 * snake_case, as in the YAML files.
 */

const Fraction = z.number().gt(0).lt(1);
const NonEmpty = z.string().min(1);

export const TierConfig = z.strictObject({
  adapter: NonEmpty,
  /**
   * Required by adapters that choose a model per session (`claude-sdk`, `codex-app-server`); left
   * out for `acp:<slug>` and `pty:<slug>` agents, whose command fixes it (#149).
   */
  model: NonEmpty.optional(),
  /** Default effort; the policy may raise it up to `max_effort` (#110). */
  effort: z.enum(EFFORT_LEVELS).optional(),
  /**
   * `tiers.review`: the reviewer must run a different vendor's models than `tiers.worker` (#19).
   * Default true.
   */
  cross_vendor: z.boolean().optional(),
  /**
   * Whose models the adapter runs, for cross-vendor review (#19). Built-in adapters are known;
   * OpenCode and custom `acp:`/`pty:` agents need it to take part.
   */
  vendor: z.enum(VENDORS).optional(),
  /**
   * Bounds on what the session-profile policy may choose for a Worker tier (`worker`, `review`;
   * #110). A profile outside them is refused before launch. The task layer may not set them. The
   * planner's `mini` tier does not go through the policy and takes no bounds.
   */
  models: z
    .array(NonEmpty)
    .min(1)
    .optional()
    .describe('Models the policy may choose; `model` (the default) must be one of them'),
  max_effort: z.enum(EFFORT_LEVELS).optional().describe('Highest effort the policy may choose'),
  escalate_effort_on_retry: z
    .boolean()
    .optional()
    .describe(
      'Raise effort one level per failed attempt, up to max_effort (required with it). Off by default; the retry policy itself is #34',
    ),
  max_context_window: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Largest context window, in tokens, the policy may opt into, and only for a task marked indivisible. Absent: never more than the default window; Tacet hands off instead',
    ),
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
  capabilities: z
    .strictObject({
      mcp: z
        .boolean()
        .optional()
        .describe(
          "ACP: the agent connects the MCP servers passed in session/new, so its Workers get the Mini-conductor's MCP tools. Default false (#184): set it only once verified for that agent",
        ),
    })
    .optional()
    .describe('ACP: what the agent supports beyond the ACP baseline'),
  resume_flag: z
    .union([NonEmpty, z.array(NonEmpty).min(1)])
    .optional()
    .describe(
      "PTY: argument(s) added to the command to continue the CLI's last session in the Worker's checkout, e.g. [resume, --last] (Codex, whose command should also pass -c features.daemon_auto_start=false, #171) or [--resume, latest] (Gemini CLI), both checked per worktree (capability matrix, #168). Only for a CLI whose resume picks among the sessions of its working directory: otherwise a Worker could continue another Worker's session",
    ),
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
      autonomy: z
        .enum(['low', 'medium', 'high'])
        .optional()
        .describe(
          'What the escalation gate may answer (ADR-004 B). Only the user raises it: the repo and task layers may only lower it',
        ),
      always_ask: z.array(NonEmpty).optional(),
      gate_timeout_s: z
        .number()
        .positive()
        .max(240)
        .optional()
        .describe(
          'Longest the gate may take before `escalate` returns pending. Default 3 at autonomy low, 30 at medium and high; at most 240, inside every MCP client limit measured (spike #68)',
        ),
    })
    .optional(),
  handoff: z
    .strictObject({ warn: Fraction, handoff: Fraction, hard: Fraction })
    .partial()
    .optional(),
  /**
   * Commands that check a Worker's finished sub-task in its checkout (#19), run with `/bin/sh -c`
   * as Worker code: the Worker environment, no vendor keys. The task layer may not set it.
   */
  verify: z.array(NonEmpty).optional(),
  /**
   * A reviewer agent on `tiers.review` checks each sub-task's diff after its `verify` commands
   * pass (#19). Off by default. The task layer may turn it on, never off.
   */
  review: z.strictObject({ enabled: z.boolean() }).partial().optional(),
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
  /**
   * Worker pool (#17). Capacity governor after Gas Town's scheduler `max_polecats`
   * (`docs/design/scheduler.md`, ADR-001): `max` counts every running Worker of the repo,
   * `per_adapter` caps one adapter further. Health defaults after Gas Town's Deacon heartbeat
   * thresholds (5 min stale, 20 min very stale; `docs/concepts/heartbeats.md` @ 466aa41): a
   * silent Worker is nudged after `stuck_after_s` and, unlike Gas Town's poke, replaced after
   * `nudge_grace_s` more. A sub-task fails for good after `max_attempts` failed attempts (see
   * `WorkerEndReason` for what counts).
   */
  workers: z
    .strictObject({
      max: z.number().int().positive(),
      per_adapter: z.record(
        z
          .string()
          .regex(
            /^(claude-sdk|codex-app-server|opencode|acp|pty|(acp|pty):[a-z0-9][a-z0-9-]*)$/,
            'expected an adapter id: claude-sdk, codex-app-server, opencode, acp, pty, acp:<agent> or pty:<agent>',
          ),
        z.number().int().positive(),
      ),
      stuck_after_s: z.number().int().positive(),
      nudge_grace_s: z.number().int().positive(),
      max_attempts: z.number().int().positive(),
      /**
       * Handoffs one sub-task may request (#129). They never count as attempts, so this bounds a
       * chain of fresh sessions; past it `request_handoff` is refused and the Worker is told to
       * finish or escalate.
       */
      max_handoffs: z.number().int().positive(),
      /** Seconds one `verify` command may run before it is ended (#19). */
      verify_timeout_s: z.number().int().positive(),
      /**
       * Times a failed verification goes back to the same Worker session to fix before the attempt
       * fails (#19); 0 fails it at once.
       */
      verify_fix_attempts: z.number().int().nonnegative(),
      /**
       * Worker environment (#147). A Worker starts with an allowlist of the user's environment;
       * `pass` adds names, or prefixes ending in `*`. A prefix never passes a secret-looking
       * name (`*_TOKEN`, `*_KEY`, `AWS_*`, ...): name such a variable exactly, in the user or
       * local layer. Unioned across layers; the task layer may not set it.
       */
      env: z.strictObject({
        pass: z.array(
          z
            .string()
            .regex(
              ENV_PASS_PATTERN,
              'expected an environment variable name, or a prefix ending in * (e.g. MYAPP_*)',
            ),
        ),
      }),
    })
    .partial()
    .optional(),
  /**
   * Worker worktrees (#16). With `remove_merged` on, garbage collection may remove a worktree once
   * the event log records that its task's work landed in the target branch (merged or
   * squash-merged), even when no ref contains its commits (#210). Worktrees whose work never
   * landed are kept either way. Owner decision: on by default; `tacet init` asks. `idle_days`
   * (#238): a checkout none of whose Worker sessions has been active for that many days, and that
   * holds no unintegrated work or local files, is removed; 0 turns this off. The task layer may not
   * set either.
   */
  worktrees: z
    .strictObject({ remove_merged: z.boolean(), idle_days: z.number().int().min(0) })
    .partial()
    .optional(),
  /**
   * The Conductor (#23). With `autostart` on, `tacet up` starts a Mini-conductor (`tacet mini`)
   * for each registered repo that has none; one with unfinished tasks refuses to start and is not
   * retried. Off by default (owner decision on #23). Only the user layer may set it: a repo's
   * committed config must not make the user's Conductor start processes.
   */
  conductor: z.strictObject({ autostart: z.boolean() }).partial().optional(),
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
  workers: {
    max: 4,
    stuck_after_s: 300,
    nudge_grace_s: 900,
    max_attempts: 3,
    max_handoffs: 3,
    verify_timeout_s: 600,
    verify_fix_attempts: 2,
  },
  worktrees: { remove_merged: true, idle_days: 7 },
  conductor: { autostart: false },
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
  for (const [role, t] of Object.entries(config.tiers ?? {})) {
    if (t.models && t.model !== undefined && !t.models.includes(t.model)) {
      errors.push(`tiers.${role}.model: ${t.model} is not in tiers.${role}.models`);
    }
    const effort = t.effort !== undefined ? effortRank(t.effort) : undefined;
    const max = t.max_effort !== undefined ? effortRank(t.max_effort) : undefined;
    if (effort !== undefined && max !== undefined && effort > max) {
      errors.push(`tiers.${role}.effort: ${t.effort} is above tiers.${role}.max_effort`);
    }
    if (t.escalate_effort_on_retry && t.max_effort === undefined) {
      errors.push(`tiers.${role}.escalate_effort_on_retry: needs tiers.${role}.max_effort`);
    }
    if (role === 'mini') {
      for (const key of [
        'models',
        'max_effort',
        'max_context_window',
        'escalate_effort_on_retry',
      ] as const) {
        if (t[key] !== undefined) errors.push(`tiers.mini.${key}: only Worker tiers take bounds`);
      }
    }
  }
  const w = config.workers;
  for (const [id, cap] of Object.entries(w?.per_adapter ?? {})) {
    if (w?.max !== undefined && cap > w.max) {
      errors.push(`workers.per_adapter.${id}: ${cap} is more than workers.max (${w.max})`);
    }
  }
  return errors;
}
