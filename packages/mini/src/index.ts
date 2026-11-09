/** Per-repo Mini-conductor daemon and MCP server. Placeholder until its roadmap issue lands. */

export type {
  CreateWorktreeOptions,
  MergeResult,
  MergeStrategy,
  WorktreeGcOptions,
  WorktreeGcResult,
  WorktreeInfo,
  WorktreeSetup,
} from './worktree.js';
export { WorktreeManager } from './worktree.js';

export const packageName = '@tacet/mini' as const;
