import { z } from 'zod';
import { Id, openEnum } from './common.js';

/**
 * Worker worktree lifecycle (`workspace.*`, #126): the Mini-conductor's registry of the checkouts
 * its worktree manager made, rebuilt from the log instead of state files. Local to the
 * Mini-conductor (never forwarded to the Conductor), and never a path: a checkout's path is
 * `<worktree root>/<workspaceId>` and its branch `tacet/<workspaceId>`.
 */

/**
 * Payload of `workspace.created`: written before the checkout is made (intent first), so a crash
 * leaves a record the next start reconciles; `migrated` for one imported from a pre-#126 file.
 * `scratch` marks a throwaway checkout (a planner's, #238) that holds nothing of value: one a crash
 * left registered is force-removed at the next start.
 */
export const WorkspaceCreated = z.object({
  workspaceId: Id,
  workerId: z.string().min(1),
  baseCommit: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, 'expected a full commit id'),
  baseBranch: z.string().min(1).optional(),
  migrated: z.literal(true).optional(),
  scratch: z.literal(true).optional(),
});
export type WorkspaceCreated = z.infer<typeof WorkspaceCreated>;

/**
 * Why a workspace left the registry: `removed` after the checks, `forced` past them, `gone` when
 * nothing of it was left (a crash before or during creation or removal). Unknown values read as
 * `removed`.
 */
export const WorkspaceRemovedReason = openEnum(['removed', 'forced', 'gone'], 'removed');
export type WorkspaceRemovedReason = z.infer<typeof WorkspaceRemovedReason>;

/** Payload of `workspace.removed`: written after the checkout, its git admin dir and branch went. */
export const WorkspaceRemoved = z.object({
  workspaceId: Id,
  reason: WorkspaceRemovedReason,
});
export type WorkspaceRemoved = z.infer<typeof WorkspaceRemoved>;
