import { z } from 'zod';
import { Id, Timestamp, Ulid } from './common.js';
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

export const VerificationStatus = z.enum(['passed', 'failed', 'partial', 'not_run']);
export type VerificationStatus = z.infer<typeof VerificationStatus>;

export const Verification = z.object({
  status: VerificationStatus,
  commands: z.array(z.string().min(1)).default([]).describe('Commands that verify the work'),
  notes: z.string().optional(),
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
