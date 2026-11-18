import { existsSync } from 'node:fs';
import { openEventStore } from '@tacet/core/node';
import type { Io } from '../io.js';
import { safeJson, terminalSafe } from '../render.js';
import { repoRootFrom, statePaths } from '../state.js';

export interface BudgetOptions {
  repo?: string;
  'user-dir'?: string;
  json?: boolean;
}

/**
 * `tacet budget forget <model>` (#361, owner decision 2026-11-18): withdraw the answer recorded
 * for a model with no known cost, a refusal or an allowance, so the next task that needs it asks
 * again. Only with no run live: it takes the Mini-conductor's lock, as `tacet cancel` does with no
 * run, so the log keeps one writer. There is no `allow`: an allowance needs the question's answer
 * code, which a Worker-run process does not have (#269).
 */
export async function budgetForget(io: Io, model: string, o: BudgetOptions): Promise<number> {
  const repoRoot = repoRootFrom(o.repo ?? io.cwd);
  const paths = statePaths(repoRoot, o['user-dir'], io.home);
  if (!existsSync(paths.events)) {
    io.err(`no Tacet state for ${terminalSafe(repoRoot)}: nothing to forget`);
    return 1;
  }
  const { forgetUnpriced, miniLockHolder } = await import('@tacet/mini');
  const pid = miniLockHolder(paths.lock);
  if (pid !== undefined) {
    io.err(
      `a run is live for this repo (pid ${pid}): stop it (Ctrl-C), then tacet budget forget ${terminalSafe(model)}`,
    );
    return 1;
  }
  const store = openEventStore(paths.events);
  try {
    const { forgotten } = forgetUnpriced(model, {
      store,
      lockPath: paths.lock,
      repo: paths.repoId,
      miniId: 'standalone',
    });
    if (o.json) io.out(safeJson({ model, forgotten }));
    else {
      io.out(
        terminalSafe(
          `${model}: the ${forgotten === 'allowed' ? 'allowance' : 'refusal'} is forgotten; the next task that needs it asks again`,
        ),
      );
    }
    return 0;
  } catch (err) {
    io.err(terminalSafe(err instanceof Error ? err.message : String(err)));
    return 1;
  } finally {
    store.close();
  }
}
