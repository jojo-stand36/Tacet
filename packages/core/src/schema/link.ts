import { z } from 'zod';

/**
 * Events up the Conductor link (#24, ADR-003 §4 and its addendum on forwarding events, proposed).
 * `tacet/event` is a notification from the Mini-conductor; `tacet/event.resume` a request from
 * the Conductor, which starts forwarding.
 */
export const TACET_EVENT = 'tacet/event';
export const TACET_EVENT_RESUME = 'tacet/event.resume';

/** Envelopes in one `tacet/event` batch, at most. */
export const EVENT_BATCH_MAX = 200;
/** Bytes of one `tacet/event` frame, at most (its JSON text). */
export const EVENT_BATCH_MAX_BYTES = 256 * 1024;

/** A log's own id (`EventStore.logId`): random, made with the log. */
const LogId = z.string().min(1).max(64);

/**
 * `tacet/event` params: a batch of the Mini-conductor's forwardable envelopes, in log order.
 * `throughSeq` is the log `seq` the batch covers through (its last envelope's, or a later one
 * when the envelopes after it were not forwardable), the cursor the Conductor keeps. Each envelope
 * is checked on its own by the receiver: an unknown type is skipped, never the batch (ADR-003 §2).
 */
export const TacetEventParams = z.object({
  logId: LogId,
  throughSeq: z.number().int().nonnegative(),
  events: z.array(z.record(z.string(), z.unknown())).max(EVENT_BATCH_MAX),
});
export type TacetEventParams = z.infer<typeof TacetEventParams>;

/**
 * `tacet/event.resume` params: where the Conductor's replica of this repo stands. With the
 * Mini-conductor's own `logId`, forwarding goes on after `afterSeq`; with another, or none, it
 * starts from the beginning of the log.
 */
export const EventResumeParams = z.object({
  logId: LogId.optional(),
  afterSeq: z.number().int().nonnegative().optional(),
});
export type EventResumeParams = z.infer<typeof EventResumeParams>;

/** `tacet/event.resume` result: where forwarding starts. */
export const EventResumeResult = z.object({
  logId: LogId,
  afterSeq: z.number().int().nonnegative(),
});
export type EventResumeResult = z.infer<typeof EventResumeResult>;
