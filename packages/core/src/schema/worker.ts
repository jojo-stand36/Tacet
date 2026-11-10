import { z } from 'zod';
import { Id, openEnum, TokenCount } from './common.js';
import { ReviewStatus, VerifyCommandStatus } from './handoff.js';
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

/** A part of a session profile. Unknown values fall back to `model`, the one a retry cannot fix. */
export const ProfileField = openEnum(['model', 'effort', 'contextWindow'], 'model');
export type ProfileField = z.infer<typeof ProfileField>;

/**
 * Why each part of a profile was chosen, keyed by part so a reader never parses free text: the
 * config path or rule it came from, or why a part was left at the vendor's default.
 */
export const ProfileReasons = z.object({
  model: z.string().min(1),
  effort: z.string().min(1),
  contextWindow: z.string().min(1),
});
export type ProfileReasons = z.infer<typeof ProfileReasons>;

/**
 * Payload of `worker.profile`: the session profile the Mini-conductor's policy chose for a Worker
 * session, and why (#110). Written with `worker.started`, before the session starts. If the
 * adapter refuses it, it is written again with `refused`, and the profile the session then runs
 * on gets its own event: the last one for a session is the one in force, unless it is the
 * refused one, when no session ran (a refused model fails the sub-task).
 */
export const WorkerProfile = z.object({
  sessionId: Id,
  model: z.string().min(1).optional(),
  effort: Effort.optional(),
  contextWindow: TokenCount.positive().optional(),
  reasons: ProfileReasons,
  refused: z
    .object({ field: ProfileField, message: z.string() })
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
 * Payload of `worker.verification`: one `verify` command finished on a Worker's sub-task (#19).
 * Summary-grade: never the command's output (it is in the Worker's feedback and, short and
 * redacted, in `SummaryPacket.verification.notes`). `round` counts the fix rounds of the session:
 * 0 for the first check, then one more each time the failure went back to the Worker.
 */
export const WorkerVerification = z.object({
  sessionId: Id,
  round: z.number().int().nonnegative(),
  command: z.string().min(1),
  status: VerifyCommandStatus,
  exitCode: z.number().int().optional(),
  signal: z.string().min(1).optional(),
  durationMs: z.number().int().nonnegative(),
  commit: z
    .string()
    .regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, 'expected a full commit id')
    .optional()
    .describe('The integrated commit the checkout was verified at'),
});
export type WorkerVerification = z.infer<typeof WorkerVerification>;

/**
 * Payload of `worker.review`: a reviewer agent judged a Worker's sub-task (#19). Summary-grade:
 * counts only, never the findings' text, which goes to the Worker as its feedback. `round` is
 * shared with `worker.verification`: the check the review belongs to.
 */
export const WorkerReview = z.object({
  sessionId: Id.describe("The author Worker's session"),
  reviewerSessionId: Id.optional(),
  round: z.number().int().nonnegative(),
  adapter: z.string().min(1),
  model: z.string().min(1).optional(),
  status: ReviewStatus,
  blockers: z.number().int().nonnegative(),
  majors: z.number().int().nonnegative(),
  minors: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  commit: z
    .string()
    .regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, 'expected a full commit id')
    .optional()
    .describe('The integrated commit that was reviewed'),
});
export type WorkerReview = z.infer<typeof WorkerReview>;

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

/**
 * Payload of `worker.approval`: an unattended Worker's approval request the Mini-conductor
 * refused (#200; the interim policy until #25). Summary-grade, kept and forwarded. An allowed
 * request is recorded with the same payload as transcript-grade `agent.approval.decision`, which
 * retention drops (owner decision, 2026-11-10). `reason` never holds a path outside the Worker's
 * checkout; the request itself, with the tool's input, is the transcript event before it.
 */
export const WorkerApproval = z.object({
  sessionId: Id,
  requestId: z.string().min(1).max(200).describe("The adapter's approval request id"),
  toolName: z.string().min(1).max(200).optional(),
  decision: openEnum(['allowed', 'refused'], 'refused'),
  reason: z.string().min(1).max(2000),
});
export type WorkerApproval = z.infer<typeof WorkerApproval>;
