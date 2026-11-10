import { z } from 'zod';
import { Id, openEnum, Timestamp, Ulid } from './common.js';
import { DecisionScope } from './decision.js';

/** A decision made during the session, carried forward so the next session does not reopen it. */
export const HandoffDecision = z.object({
  topic: z.string().min(1),
  decision: z.string().min(1),
  rationale: z.string().optional(),
  scope: DecisionScope.optional(),
});
export type HandoffDecision = z.infer<typeof HandoffDecision>;

export const CommandRun = z.object({
  command: z.string().min(1),
  exitCode: z.number().int().optional(),
  summary: z.string().optional().describe('One line on what the output showed'),
});
export type CommandRun = z.infer<typeof CommandRun>;

/** Unknown values fall back to `not_run`, so nothing is assumed verified. */
export const VerificationStatus = openEnum(['passed', 'failed', 'partial', 'not_run'], 'not_run');
export type VerificationStatus = z.infer<typeof VerificationStatus>;

/** How one `verify` command ended (#19). Unknown values fall back to `failed`. */
export const VerifyCommandStatus = openEnum(
  ['passed', 'failed', 'timed_out', 'aborted', 'not_run'],
  'failed',
);
export type VerifyCommandStatus = z.infer<typeof VerifyCommandStatus>;

/** One `verify` command's result (#19): no output. */
export const VerifyCommandResult = z.object({
  command: z.string().min(1),
  status: VerifyCommandStatus,
  exitCode: z.number().int().optional(),
  signal: z.string().min(1).optional(),
  durationMs: z.number().int().nonnegative().optional(),
});
export type VerifyCommandResult = z.infer<typeof VerifyCommandResult>;

export const Verification = z.object({
  status: VerificationStatus,
  commands: z.array(z.string().min(1)).default([]).describe('Commands that verify the work'),
  notes: z.string().optional(),
  /** Per command, as last run (#19). Optional: older producers and handoffs omit it. */
  results: z.array(VerifyCommandResult).optional(),
});
export type Verification = z.infer<typeof Verification>;

/**
 * Typed context handoff to a fresh session (RESEARCH.md §5, ARCHITECTURE.md §2.3).
 * A packet without a non-blank `nextAction` is invalid and must be regenerated; the list fields
 * default to empty so a packet that omits them is not rejected.
 */
export const HandoffPacket = z.object({
  v: z.literal(1),
  id: Ulid.optional().describe(
    'handoffId, minted by the Mini-conductor when it accepts the packet',
  ),
  taskId: Id,
  parentSession: Id.describe('The session that wrote this packet'),
  createdAt: Timestamp,
  goal: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)),
  stateSummary: z.string().min(1),
  decisions: z.array(HandoffDecision).default([]),
  filesTouched: z.array(z.string().min(1)).default([]),
  commandsRun: z.array(CommandRun).default([]),
  openQuestions: z.array(z.string().min(1)).default([]),
  nextAction: z.string().regex(/\S/, 'nextAction is required').describe('The very next step'),
  verification: Verification,
});
export type HandoffPacket = z.infer<typeof HandoffPacket>;
