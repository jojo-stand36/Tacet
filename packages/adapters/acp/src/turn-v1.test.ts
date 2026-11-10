import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PermissionOption, SessionUpdate, StopReason } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import {
  approvalChoices,
  newTurnState,
  permissionOutcome,
  stopState,
  turnUsage,
  updateToEvents,
} from './turn-v1.js';

/**
 * The v1 prompt-turn mappings against transcripts recorded from the real Gemini CLI 0.67.0
 * (docs/adapters/spikes/63-gemini): a tool call answered with allow, with reject, and cancelled.
 */
type Obj = Record<string, unknown>;
type Line = {
  dir: '>>' | '<<';
  msg: { method?: string; id?: unknown; params?: Obj; result?: Obj };
};
const transcript = (name: string): Line[] =>
  readFileSync(
    join(import.meta.dirname, '..', 'test', 'fixtures', `gemini-0.67.0-acp-${name}.jsonl`),
    'utf8',
  )
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Line);

/** Replay a transcript's turn through the mappings, answering permissions with `kind`. */
function replay(name: string, kind: 'allow_once' | 'reject' | 'cancel') {
  const lines = transcript(name);
  const st = newTurnState();
  const events = lines
    .filter((l) => l.dir === '<<' && l.msg.method === 'session/update')
    .flatMap((l) => updateToEvents(l.msg.params?.update as SessionUpdate, st));
  const ask = lines.find((l) => l.msg.method === 'session/request_permission');
  const options = ask?.msg.params?.options as PermissionOption[];
  const recordedReply = lines.find((l) => l.dir === '>>' && l.msg.id === ask?.msg.id)?.msg.result;
  const response = lines.at(-1)?.msg.result as { stopReason: StopReason };
  return {
    events,
    options,
    ours: permissionOutcome(options, { kind, persist: false }),
    recorded: recordedReply?.outcome,
    end: stopState(response.stopReason),
    usage: turnUsage(response, st),
  };
}

describe('ACP v1 prompt turn (recorded Gemini CLI 0.67.0 transcripts)', () => {
  it('allow: answers proceed_once; the tool runs and the turn ends idle', () => {
    const r = replay('allow_once', 'allow_once');
    expect(r.ours).toEqual(r.recorded);
    expect(r.ours).toEqual({ outcome: 'selected', optionId: 'proceed_once' });
    expect(approvalChoices(r.options)).toEqual(['allow_once', 'allow_always', 'reject', 'cancel']);
    const call = r.events.find((e) => e.t === 'tool.call');
    expect(call).toMatchObject({ t: 'tool.call', name: 'execute' });
    expect(r.events.filter((e) => e.t === 'tool.result')).toEqual([
      { t: 'tool.result', id: (call as { id: string }).id, ok: true },
    ]);
    expect(r.events.filter((e) => e.t === 'message.delta')).toEqual([
      { t: 'message.delta', text: 'Tool finished.' },
    ]);
    expect(r.events.filter((e) => e.t === 'usage')[0]).toMatchObject({
      contextUsed: 128,
      contextMax: 1048576,
      source: 'reported',
    });
    expect(r.end).toEqual({ state: 'idle' });
    expect(r.usage).toMatchObject({ inputTokens: 240, outputTokens: 16, contextMax: 1048576 });
  });

  it('reject: answers Gemini’s reject option, whose id is `cancel`; the tool fails', () => {
    const r = replay('reject_once', 'reject');
    expect(r.ours).toEqual(r.recorded);
    expect(r.ours).toEqual({ outcome: 'selected', optionId: 'cancel' });
    expect(r.events.filter((e) => e.t === 'tool.result')).toMatchObject([{ ok: false }]);
    expect(r.end).toEqual({ state: 'idle' });
  });

  it('cancel: answers cancelled; the turn ends cancelled, not as an error', () => {
    const r = replay('cancel', 'cancel');
    expect(r.ours).toEqual(r.recorded);
    expect(r.ours).toEqual({ outcome: 'cancelled' });
    expect(r.end).toEqual({ state: 'cancelled' });
    // And the client did send session/cancel before answering, as the spec requires.
    const lines = transcript('cancel');
    const cancelAt = lines.findIndex((l) => l.dir === '>>' && l.msg.method === 'session/cancel');
    const answerAt = lines.findIndex((l) => l.dir === '>>' && l.msg.result?.outcome !== undefined);
    expect(cancelAt).toBeGreaterThan(-1);
    expect(cancelAt).toBeLessThan(answerAt);
  });

  it('refuses rather than allows when the agent offers no option of the asked kind', () => {
    const onlyAllow: PermissionOption[] = [{ optionId: 'a', name: 'Allow', kind: 'allow_once' }];
    expect(permissionOutcome(onlyAllow, { kind: 'reject', persist: false })).toEqual({
      outcome: 'cancelled',
    });
    expect(permissionOutcome(onlyAllow, { kind: 'allow_always', persist: false })).toEqual({
      outcome: 'selected',
      optionId: 'a',
    });
    expect(approvalChoices(onlyAllow)).toEqual(['allow_once', 'cancel']);
  });

  it('reports a finished tool once, and a USD cost total as deltas', () => {
    const st = newTurnState();
    const done = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
    } as SessionUpdate;
    expect(updateToEvents(done, st)).toHaveLength(1);
    expect(updateToEvents(done, st)).toHaveLength(0);
    const usage = (amount: number) =>
      updateToEvents(
        {
          sessionUpdate: 'usage_update',
          used: 10,
          size: 100,
          cost: { amount, currency: 'USD' },
        } as SessionUpdate,
        st,
      )[0];
    expect(usage(0.5)).toMatchObject({ costUsd: 0.5 });
    expect(usage(0.75)).toMatchObject({ costUsd: 0.25 });
    expect(stopState('max_tokens')).toEqual({ state: 'idle', message: 'turn ended: max_tokens' });
    expect(turnUsage({ stopReason: 'end_turn' }, newTurnState())).toBeUndefined();
  });
});
