import { z } from 'zod';
import { Id, Timestamp, Ulid } from './common.js';

export const SourceKind = z.enum(['worker', 'mini', 'conductor', 'adapter']);
export type SourceKind = z.infer<typeof SourceKind>;

/** Event type namespaces known in protocol v1 (ADR-003 §1). Informational, not a whitelist. */
export const EVENT_NAMESPACES = [
  'agent',
  'task',
  'escalation',
  'decision',
  'handoff',
  'worker',
  'budget',
] as const;

/**
 * Dotted event type, e.g. `agent.message.delta`. Only the shape is checked: a new namespace is
 * an additive change, so receivers must accept and ignore types they do not know (ADR-003 §2).
 */
export const EventType = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, 'expected a dotted lowercase event type');

/** True if `type` belongs to a namespace this version of Tacet knows. */
export function isKnownEventNamespace(type: string): boolean {
  const ns = type.split('.', 1)[0];
  return (EVENT_NAMESPACES as readonly string[]).includes(ns ?? '');
}

/**
 * Wraps every state change before it is stored or forwarded (ADR-003 §1). `data` is validated
 * per `type` by the receiver; unknown types and fields must be ignored, not rejected.
 */
export const EventEnvelope = z.object({
  v: z.literal(1),
  id: Ulid.describe('Unique and sortable; also the idempotency key'),
  ts: Timestamp,
  source: z.object({ kind: SourceKind, id: Id }),
  repo: Id.optional(),
  taskId: Id.optional(),
  sessionId: Id.optional(),
  correlationId: Id.optional(),
  causationId: Ulid.optional(),
  type: EventType,
  data: z.unknown(),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;
