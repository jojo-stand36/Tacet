import { z } from 'zod';
import { Id, openEnum } from './common.js';

/**
 * Worker lifecycle events (`worker.*`, ARCHITECTURE.md §3). They are summary-grade: retention
 * keeps them, and a restarted Mini-conductor rebuilds its Worker pool from them. Paths are not
 * part of them, because `worker.*` events are forwarded to the Conductor; a workspace is named by
 * its id in the worktree registry (#16).
 */

/** Payload of `worker.started`. Written before the vendor session starts. */
export const WorkerStarted = z.object({
  sessionId: Id.describe('Tacet Worker session id'),
  adapter: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  workspaceId: Id.optional().describe('Worktree id in the worktree registry'),
  attempt: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Failed attempts so far plus one (see WorkerEndReason); 1 for the first run'),
  previousSessionId: Id.optional().describe(
    'The session this one replaces (restart, handoff or retry), like AG-UI parentRunId',
  ),
});
export type WorkerStarted = z.infer<typeof WorkerStarted>;

/** Payload of `worker.vendor_session`: the vendor's own session or thread id, once known. */
export const WorkerVendorSession = z.object({
  sessionId: Id,
  vendorSessionId: Id,
});
export type WorkerVendorSession = z.infer<typeof WorkerVendorSession>;

/**
 * Why a Worker session ended.
 * - `finished`: its turn ended normally. That is not "completed": the sub-task completes only
 *   once verified (`task.status completed`, ADR-003 §4).
 * - `failed`: it errored or its work failed verification. Counts as a failed attempt.
 * - `stuck`: health checks gave up on it. Counts as a failed attempt.
 * - `restart`: the Mini-conductor stopped while it ran. Does not count.
 * - `handoff`: replaced by a fresh session with a HandoffPacket. Does not count.
 * - `canceled`: the task was canceled. Does not count.
 * Unknown values fall back to `failed`, and so count.
 */
export const WorkerEndReason = openEnum(
  ['finished', 'failed', 'stuck', 'restart', 'canceled', 'handoff'],
  'failed',
);
export type WorkerEndReason = z.infer<typeof WorkerEndReason>;

/** Payload of `worker.ended`. `reason` is optional for events written before it existed. */
export const WorkerEnded = z.object({
  sessionId: Id,
  reason: WorkerEndReason.optional(),
  message: z.string().optional(),
});
export type WorkerEnded = z.infer<typeof WorkerEnded>;

/** Payload of `worker.nudged`: health checks prodded a silent Worker (Gas Town's nudge). */
export const WorkerNudged = z.object({
  sessionId: Id,
  silentForMs: z.number().int().nonnegative(),
});
export type WorkerNudged = z.infer<typeof WorkerNudged>;
