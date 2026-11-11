import { z } from 'zod';
import { Id, openEnum, Timestamp, Ulid } from './common.js';

/** Unknown values fall back to `worker`, the least trusted source. */
export const SourceKind = openEnum(['worker', 'mini', 'conductor', 'adapter'], 'worker');
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
  // Local to the Mini-conductor, never forwarded upward: its worktree registry (#126) and the
  // failures of its own upkeep (#254).
  'workspace',
  'maintenance',
] as const;

/**
 * Dotted event type, e.g. `agent.message.delta`. Only the shape is checked: a new namespace is
 * an additive change, so receivers must accept and ignore types they do not know (ADR-003 §2).
 */
export const EventType = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, 'expected a dotted lowercase event type');

/**
 * Namespaces that stay with the Mini-conductor (ADR-003 §1 addenda): the worktree registry (#126)
 * and the failures of its own upkeep (#254). Documentation: forwarding is decided by the §4
 * allowlist below, and these are not on it.
 */
export const LOCAL_EVENT_NAMESPACES = ['workspace', 'maintenance'] as const;

/**
 * The upward stream by default (ADR-003 §4, `tacet/event`): summary-grade namespaces sent to the
 * Conductor. Transcripts never are; of `agent.*`, only `agent.usage` (#256).
 */
export const UPWARD_EVENT_NAMESPACES = [
  'task',
  'escalation',
  'decision',
  'handoff',
  'worker',
] as const;
/** Single event types sent upward from namespaces that otherwise stay local (ADR-003 §4). */
export const UPWARD_EVENT_TYPES = ['agent.usage'] as const;

/**
 * True only for an event type the ADR-003 §4 allowlist sends upward to the Conductor (#256).
 * Everything else stays with the Mini-conductor: local namespaces, transcripts, a malformed type
 * and any namespace not on the list, including one added later, until the list says otherwise.
 */
export function isForwardable(type: string): boolean {
  if (!EventType.safeParse(type).success) return false;
  if ((UPWARD_EVENT_TYPES as readonly string[]).includes(type)) return true;
  return (UPWARD_EVENT_NAMESPACES as readonly string[]).includes(type.split('.', 1)[0] ?? '');
}

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
