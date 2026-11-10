import { randomUUID } from 'node:crypto';
import { DECISION_EXT_URI } from '@tacet/core';
import { liveControl, liveStatus } from '../control.js';
import type { Io } from '../io.js';
import { safeJson, terminalSafe } from '../render.js';
import { repoRootFrom, statePaths } from '../state.js';

export interface AnswerOptions {
  repo?: string;
  'user-dir'?: string;
  json?: boolean;
}

/**
 * `tacet answer <escalation> <text>` (#201): answer an open escalation in the live run, over its
 * control port, so only the run writes the log. The answer reaches the Worker as its next turn.
 * With no run live, `tacet run --resume --answer ID=TEXT` answers as the run starts.
 */
export async function answer(
  io: Io,
  escalationId: string,
  text: string,
  o: AnswerOptions,
): Promise<number> {
  if (text.trim() === '') {
    io.err('an answer must not be empty');
    return 2;
  }
  const repoRoot = repoRootFrom(o.repo ?? io.cwd);
  const paths = statePaths(repoRoot, o['user-dir'], io.home);
  const client = await liveControl(io, repoRoot, paths, 'cannot answer through it');
  if (!client) {
    io.err(
      `no run is live for this repo: answer as it resumes, with tacet run --resume --answer ${terminalSafe(escalationId)}=<text>`,
    );
    return 1;
  }
  try {
    const task = (await liveStatus(client)).find((t) =>
      t.escalations.some((x) => x.id === escalationId),
    );
    if (!task) {
      io.err(`no open escalation ${terminalSafe(escalationId)} (see tacet status)`);
      return 1;
    }
    await client.call('SendMessage', {
      message: {
        messageId: randomUUID(),
        taskId: task.id,
        role: 'ROLE_USER',
        parts: [{ text }],
        extensions: [DECISION_EXT_URI],
        metadata: { [DECISION_EXT_URI]: { escalationId, choice: text, scope: 'task' } },
      },
    });
    if (o.json) io.out(safeJson({ answered: escalationId, taskId: task.id }));
    else io.out(`answered ${terminalSafe(escalationId)} (${terminalSafe(task.id)})`);
    return 0;
  } catch (err) {
    io.err(terminalSafe(err instanceof Error ? err.message : String(err)));
    return 1;
  } finally {
    await client.close();
  }
}
