import { z } from 'zod';
import { Id, openEnum, TokenCount } from './common.js';
import { Effort } from './profile.js';

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
  baseCommit: z
    .string()
    .regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/)
    .optional()
    .describe(
      "Commit a new checkout started at: its dependencies' combined work (#134); absent for the main branch",
    ),
});
export type WorkerStarted = z.infer<typeof WorkerStarted>;

/**
 * Payload of `worker.profile`: the session profile the Mini-conductor's policy chose for a Worker
 * session, and why (#110). Written before the session starts, after `worker.started`. A profile
 * the adapter refused is recorded with `refused`; a retry gets its own event.
 */
export const WorkerProfile = z.object({
  sessionId: Id,
  model: z.string().min(1).optional(),
  effort: Effort.optional(),
  contextWindow: TokenCount.positive().optional(),
  reasons: z.array(z.string().min(1)).min(1).describe('Why each part was chosen, in order'),
  refused: z
    .object({
      field: z.string().min(1).describe('model, effort or contextWindow'),
      message: z.string(),
    })
    .optional()
    .describe('The adapter refused this profile (ProfileRefusedError)'),
});
export type WorkerProfile = z.infer<typeof WorkerProfile>;

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
 * Unknown values fall back to `failed`, and so count. (Owner decision, 2026-11-09.)
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
  workspaceRefused: z
    .boolean()
    .optional()
    .describe('Its checkout failed the integrity checks; the next run gets a fresh one (#119)'),
});
export type WorkerEnded = z.infer<typeof WorkerEnded>;

/** Payload of `worker.nudged`: health checks prodded a silent Worker (Gas Town's nudge). */
export const WorkerNudged = z.object({
  sessionId: Id,
  silentForMs: z.number().int().nonnegative(),
});
export type WorkerNudged = z.infer<typeof WorkerNudged>;

/**
 * Payload of `worker.integrated`: the Mini-conductor brought the Worker's commit into the repo's
 * shared object store and pointed the sub-task's branch at it (#119).
 */
export const WorkerIntegrated = z.object({
  sessionId: Id,
  commit: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, 'expected a full commit id'),
  ref: z.string().regex(/^refs\/heads\/\S+$/, 'expected a branch ref'),
});
export type WorkerIntegrated = z.infer<typeof WorkerIntegrated>;

/**
 * Payload of `worker.throttled`: a Worker went over the Mini-conductor's limit for an MCP tool
 * (#121). Written once per window; the calls over the limit get a tool error and change nothing.
 */
export const WorkerThrottled = z.object({
  sessionId: Id,
  tool: z.string().min(1),
  limit: z.number().int().positive().describe('Calls allowed per window'),
  windowMs: z.number().int().positive(),
});
export type WorkerThrottled = z.infer<typeof WorkerThrottled>;
