import { z } from 'zod';
import { Id, Timestamp, Ulid } from './common.js';

export const SourceKind = z.enum(['worker', 'mini', 'conductor', 'adapter']);
export type SourceKind = z.infer<typeof SourceKind>;

/** Event type namespaces (ADR-003 §1). */
export const EVENT_NAMESPACES = [
  'agent',
  'task',
  'escalation',
  'decision',
  'handoff',
  'worker',
  'budget',
] as const;

/** Dotted event type, e.g. `agent.message.delta`, in one of the known namespaces. */
export const EventType = z
  .string()
  .regex(
    new RegExp(`^(${EVENT_NAMESPACES.join('|')})(\\.[a-z][a-z0-9_]*)+$`),
    'expected a dotted event type in a known namespace',
  );

/**
 * Wraps every state change before it is stored or forwarded (ADR-003 §1). `data` is validated
 * per `type` by the receiver; unknown types and fields must be ignored, not rejected.
 */
export const EventEnvelope = z.object({
  v: z.literal(1),
  id: Ulid.describe('Unique and sortable; also the idempotency key'),
  ts: Timestamp,
  source: z.object({ kind: SourceKind, id: Id }),
  repo: z.string().min(1).optional(),
  taskId: Id.optional(),
  sessionId: Id.optional(),
  correlationId: z.string().min(1).optional(),
  causationId: Ulid.optional(),
  type: EventType,
  data: z.unknown(),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;
