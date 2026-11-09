import { z } from 'zod';
import { Id, openEnum, Timestamp } from './common.js';
import { Verification } from './handoff.js';

/** How a (sub-)task ended. Unknown values fall back to `failed`, so nothing reads as done. */
export const SummaryOutcome = openEnum(['completed', 'failed', 'partial', 'blocked'], 'failed');
export type SummaryOutcome = z.infer<typeof SummaryOutcome>;

/**
 * The result of a (sub-)task, rolled up instead of a transcript (ARCHITECTURE.md §2.1 step 4):
 * payload of `task.result`, and the A2A Artifact with media type
 * `application/vnd.tacet.summary+json` when it goes up to the Conductor (ADR-003 §4, §7).
 */
export const SummaryPacket = z.object({
  v: z.literal(1),
  taskId: Id,
  sessionId: Id.optional().describe('The Worker session that produced it, if one did'),
  createdAt: Timestamp,
  outcome: SummaryOutcome,
  summary: z.string().min(1).describe('What was done, in a few sentences'),
  filesTouched: z.array(z.string().min(1)).default([]),
  commits: z
    .array(z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, 'expected a full commit id'))
    .default([]),
  verification: Verification,
  openQuestions: z.array(z.string().min(1)).default([]),
});
export type SummaryPacket = z.infer<typeof SummaryPacket>;

export const SUMMARY_MEDIA_TYPE = 'application/vnd.tacet.summary+json';
