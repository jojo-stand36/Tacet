import { z } from 'zod';
import { Id, openEnum } from './common.js';

/**
 * The Mini-conductor's own upkeep (`maintenance.*`, #254): failures of the work it does unattended,
 * recorded so the user sees them (`tacet run`, `tacet status`). Local to the Mini-conductor, like
 * `workspace.*`: never forwarded to the Conductor, and never a path in a field of its own.
 */

/**
 * Which upkeep failed: the start-time worktree `reconcile` (#126, including removing planner
 * checkouts a crash left, #238, and clearing the sandbox placeholders a crashed Claude session left
 * in its checkout, #285), the `landed` sweep (#210), idle `gc` (#238), or deleting finished tasks'
 * pin refs (`unpin`, #247). Unknown values read as `other`.
 */
export const MaintenanceOp = openEnum(['reconcile', 'landed', 'gc', 'unpin', 'other'], 'other');
export type MaintenanceOp = z.infer<typeof MaintenanceOp>;

/**
 * Payload of `maintenance.problem`. `message` is the error as text with the repo, worktree and
 * home directories replaced by `<repo>`, `<worktrees>` and `~`, and secrets redacted. The envelope
 * carries `taskId` when the problem is about one task.
 */
export const MaintenanceProblem = z.object({
  op: MaintenanceOp,
  message: z.string().min(1).max(2000),
  workspaceId: Id.optional(),
});
export type MaintenanceProblem = z.infer<typeof MaintenanceProblem>;
