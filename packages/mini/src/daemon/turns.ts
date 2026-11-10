import { assertSafePrompt, type SessionHandle } from '@tacet/core';
import type { WorkerAdapter } from './ports.js';

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/**
 * Turns of a session the Mini-conductor itself drives (the planner, the reviewer): send one input
 * and collect the reply text until the turn ends. Every approval request is refused with
 * `refusal`, so the session changes nothing; usage is added to `usage`.
 */
export function sessionTurns(
  worker: WorkerAdapter,
  h: SessionHandle,
  usage: TurnUsage,
  o: { label: string; refusal: string; timeoutMs: number },
): (text: string) => Promise<string> {
  const { adapter } = worker;
  const iterator = adapter.events(h)[Symbol.asyncIterator]();
  return async (text) => {
    await adapter.send(h, { text: assertSafePrompt(text) });
    let reply = '';
    let started = false;
    const deadline = Date.now() + o.timeoutMs;
    for (;;) {
      const next = await Promise.race([
        iterator.next(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`${o.label} timed out`)),
            Math.max(1, deadline - Date.now()),
          ).unref(),
        ),
      ]);
      if (next.done) throw new Error(`${o.label} session ended`);
      const e = next.value;
      if (e.t === 'message.delta') reply += e.text;
      else if (e.t === 'usage') {
        usage.inputTokens += e.inputTokens;
        usage.outputTokens += e.outputTokens;
        usage.costUsd += e.costUsd ?? 0;
      } else if (e.t === 'approval.request') {
        await adapter.respond(h, e.id, { kind: 'reject', persist: false, message: o.refusal });
      } else if (e.t === 'status') {
        if (e.state === 'running') started = true;
        else if (e.state === 'idle' && started) return reply;
        else if (e.state === 'error' || e.state === 'auth_required' || e.state === 'done') {
          throw new Error(`${o.label} session ${e.state}${e.message ? `: ${e.message}` : ''}`);
        }
      }
    }
  };
}
