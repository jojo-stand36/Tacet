import { memoryReadWarning, ptraceScope } from '@tacet/core/node';
import type { Io } from './io.js';

/**
 * Keep this process's memory, which holds the one-time answer codes (#269), from programs a Worker
 * runs (#316): make it non-dumpable where Node can, and warn when it could not and Yama does not
 * stop a same-user process either. Call it before the Mini-conductor starts.
 */
export function guardMemory(io: Io): void {
  const guard = io.memoryGuard;
  if (!guard) return;
  const warning = memoryReadWarning(guard.harden(), (guard.scope ?? ptraceScope)(), guard.platform);
  if (warning) io.err(warning);
}
