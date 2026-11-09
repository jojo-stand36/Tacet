import { z } from 'zod';
import { Id, Timestamp, Ulid, Urgency } from './common.js';

/** Optional routing category, borrowed from Gas Town's escalation design (ADR-001). */
export const EscalationCategory = z.enum([
  'decision',
  'help',
  'blocked',
  'failed',
  'emergency',
  'gate_timeout',
  'lifecycle',
]);
export type EscalationCategory = z.infer<typeof EscalationCategory>;

export const EscalationStatus = z.enum(['pending', 'resolved', 'expired', 'cancelled']);
export type EscalationStatus = z.infer<typeof EscalationStatus>;

/** A question a Worker or Mini-conductor could not resolve on its own (ARCHITECTURE.md §2.2). */
export const Escalation = z.object({
  id: Ulid,
  taskId: Id.optional(),
  sessionId: Id.optional().describe('Worker session that raised it'),
  repo: z.string().min(1).optional(),
  question: z.string().min(1),
  options: z.array(z.string().min(1)).optional(),
  urgency: Urgency,
  category: EscalationCategory.optional(),
  context: z.string().optional().describe('Short free-text context from the Worker'),
  contextRef: z.string().min(1).optional().describe('Pointer to larger context, e.g. a file path'),
  blockedWorkers: z.number().int().nonnegative().default(0),
  status: EscalationStatus.default('pending'),
  createdAt: Timestamp,
  staleAfterSeconds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Re-escalate if still pending after this many seconds'),
  maxReescalations: z.number().int().nonnegative().optional(),
  reescalations: z.number().int().nonnegative().default(0),
});
export type Escalation = z.infer<typeof Escalation>;

/** Escalation metadata on an INPUT_REQUIRED A2A task status (ADR-003 §4). */
export const EscalationExt = z.object({
  escalationId: Ulid,
  options: z.array(z.string().min(1)).optional(),
  urgency: Urgency,
  blockedWorkers: z.number().int().nonnegative(),
  contextRef: z.string().min(1).optional(),
});
export type EscalationExt = z.infer<typeof EscalationExt>;

export const ESCALATION_EXT_URI = 'urn:tacet:a2a-ext:escalation:v1';
