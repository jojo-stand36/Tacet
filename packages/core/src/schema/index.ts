import type { z } from 'zod';
import { AgentEvent, ApprovalDecision } from './agent-event.js';
import { Decision, DecisionExt } from './decision.js';
import { EventEnvelope } from './envelope.js';
import { Escalation, EscalationExt } from './escalation.js';
import { HandoffPacket } from './handoff.js';
import { Task, TaskExt } from './task.js';

export * from './agent-event.js';
export * from './common.js';
export * from './decision.js';
export * from './envelope.js';
export * from './escalation.js';
export * from './handoff.js';
export * from './task.js';

/** Schema major version; JSON Schemas live in `schema/v1/`. */
export const SCHEMA_VERSION = 1;

/**
 * Schemas exported as JSON Schema 2020-12 for non-TypeScript consumers. Each gets
 * `$id: urn:tacet:schema:<name>:v1` (ADR-003 §2).
 */
export const jsonSchemas = {
  envelope: { schema: EventEnvelope, title: 'Tacet event envelope' },
  'agent-event': { schema: AgentEvent, title: 'Tacet AgentEvent' },
  'approval-decision': { schema: ApprovalDecision, title: 'Tacet ApprovalDecision' },
  task: { schema: Task, title: 'Tacet Task' },
  'task-ext': { schema: TaskExt, title: 'Tacet A2A task extension (urn:tacet:a2a-ext:task:v1)' },
  escalation: { schema: Escalation, title: 'Tacet Escalation' },
  'escalation-ext': {
    schema: EscalationExt,
    title: 'Tacet A2A escalation extension (urn:tacet:a2a-ext:escalation:v1)',
  },
  decision: { schema: Decision, title: 'Tacet Decision' },
  'decision-ext': {
    schema: DecisionExt,
    title: 'Tacet A2A decision extension (urn:tacet:a2a-ext:decision:v1)',
  },
  'handoff-packet': { schema: HandoffPacket, title: 'Tacet HandoffPacket' },
} satisfies Record<string, { schema: z.ZodType; title: string }>;

export type JsonSchemaName = keyof typeof jsonSchemas;

/**
 * Input types: what a producer may send. Fields with defaults are optional here, unlike the
 * parsed (output) types exported next to each schema.
 */
export type TaskInput = z.input<typeof Task>;
export type EscalationInput = z.input<typeof Escalation>;
export type DecisionInput = z.input<typeof Decision>;
export type HandoffPacketInput = z.input<typeof HandoffPacket>;
export type ApprovalDecisionInput = z.input<typeof ApprovalDecision>;
