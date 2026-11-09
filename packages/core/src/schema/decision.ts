import { z } from 'zod';
import { Id, Timestamp, Ulid } from './common.js';

/** Where a decision applies (ADR-003 §6): `task` only, or `repo`, as precedent for the repo. */
export const DecisionScope = z.enum(['task', 'repo']);
export type DecisionScope = z.infer<typeof DecisionScope>;

/**
 * Who made the decision. `policy`, `precedent`, `mini` and `user` match the `source` of the MCP
 * `escalate` result (ADR-003 §6); `worker` is a task-scope decision a Worker recorded itself
 * through MCP `record_decision`.
 */
export const DecisionSource = z.enum(['policy', 'precedent', 'mini', 'user', 'worker']);
export type DecisionSource = z.infer<typeof DecisionSource>;

/**
 * A recorded answer that later escalations can reuse as precedent (ARCHITECTURE.md §2.2).
 * Not to be confused with an adapter's answer to a tool-approval request.
 */
export const Decision = z.object({
  id: Ulid,
  escalationId: Ulid.optional().describe('The escalation this answers, if any'),
  taskId: Id.optional(),
  repo: z.string().min(1).optional(),
  topic: z.string().min(1),
  decision: z.string().min(1).describe('The chosen option or answer'),
  rationale: z.string().optional(),
  scope: DecisionScope,
  source: DecisionSource,
  tags: z
    .array(z.string().min(1))
    .default([])
    .describe('Precedent tags used to match future escalations'),
  decidedAt: Timestamp,
  supersedes: Ulid.optional().describe('An earlier decision this one replaces'),
});
export type Decision = z.infer<typeof Decision>;

/** The user's answer on an A2A SendMessage that resumes an INPUT_REQUIRED task (ADR-003 §4). */
export const DecisionExt = z.object({
  escalationId: Ulid,
  choice: z.string().min(1),
  rationale: z.string().optional(),
  scope: DecisionScope,
});
export type DecisionExt = z.infer<typeof DecisionExt>;

export const DECISION_EXT_URI = 'urn:tacet:a2a-ext:decision:v1';
