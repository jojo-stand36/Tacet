import {
  assertSafePrompt,
  evaluatePolicies,
  type PolicyRule,
  type SessionHandle,
} from '@tacet/core';
import type { WorkerAdapter } from './ports.js';
import { MAX_REPLY_CHARS } from './reply.js';
import { decideToolRequest } from './tool-policy.js';

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/**
 * Turns of a session the Mini-conductor itself drives (the planner, the reviewer): send one input
 * and collect the reply text until the turn ends. Every approval request is refused with
 * `refusal`, so the session changes nothing, except, with `reads`, reads and searches the
 * Worker policy (#200) would allow inside `reads.cwd` (the planner reads the repo in its own
 * throwaway checkout; an unattended Claude adapter asks about those too, #206). Usage is added
 * to `usage`.
 */
export function sessionTurns(
  worker: WorkerAdapter,
  h: SessionHandle,
  usage: TurnUsage,
  o: {
    label: string;
    refusal: string;
    timeoutMs: number;
    /**
     * Reads the Worker policy allows inside `cwd`, less what `policies` deny or ask about (a
     * Mini-conductor session never escalates for one; it is refused).
     */
    reads?: { adapterId: string; cwd: string; policies?: readonly PolicyRule[] };
  },
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
      // Past the parse cap the reply is invalid anyway: stop growing it, keep reading the turn
      // (#203).
      if (e.t === 'message.delta') {
        if (reply.length <= MAX_REPLY_CHARS) reply += e.text;
      } else if (e.t === 'usage') {
        usage.inputTokens += e.inputTokens;
        usage.outputTokens += e.outputTokens;
        usage.costUsd += e.costUsd ?? 0;
      } else if (e.t === 'approval.request') {
        const d =
          o.reads !== undefined && READ_TOOLS.has(e.toolName ?? '')
            ? decideToolRequest(
                {
                  adapterId: o.reads.adapterId,
                  toolName: e.toolName,
                  input: (e.requestedGrant as { input?: unknown } | undefined)?.input,
                },
                o.reads.cwd,
              )
            : undefined;
        const verdict = d?.allow
          ? evaluatePolicies(o.reads?.policies ?? [], { tool: e.toolName ?? '', paths: d.paths })
          : undefined;
        const read = d?.allow === true && (!verdict || verdict.decision === 'allow');
        await adapter.respond(
          h,
          e.id,
          read
            ? { kind: 'allow_once', persist: false }
            : { kind: 'reject', persist: false, message: o.refusal },
        );
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

/** Tools that change nothing: the only ones `reads` may allow. */
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep']);
