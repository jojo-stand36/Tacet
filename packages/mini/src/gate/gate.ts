import { Decision, Escalation, Task } from '@tacet/core';
import type { EventStore } from '@tacet/core/node';
import type { EscalationGate } from '../mcp/backend.js';

/**
 * The deterministic part of the escalation gate (#25, ADR-004 A, C, E): an exact precedent of the
 * user's own, never `always_ask`, never `blocking`. The Mini-conductor's own reasoning (ADR-004 B)
 * comes later, behind the same `EscalationGate`.
 */

/**
 * A question as precedent compares it (ADR-004 A): Unicode NFKC, case-folded, punctuation
 * dropped, and runs of space collapsed.
 */
export function normalizeQuestion(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** The exact-match key of a question and its options, sorted (ADR-004 A). Context is not in it. */
export function precedentKey(question: string, options?: readonly string[]): string {
  return JSON.stringify([
    normalizeQuestion(question),
    [...(options ?? [])].map(normalizeQuestion).sort(),
  ]);
}

/** Filler words an `always_ask` entry may carry that never have to appear (ADR-004 C). */
const FILLER = new Set(['a', 'an', 'the', 'and', 'or', 'to', 'of', 'anything', 'touching']);

/** Words for `always_ask`: split on anything but letters, digits, `/`, `.` and `-`, lower-cased. */
function words(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}/.-]+/u)
    .filter((w) => w.length > 0);
}

/**
 * The first `always_ask` entry the escalation matches, if any (ADR-004 C): one whose words, filler
 * dropped, all appear among the words of the question, its context or its options. An entry of
 * filler alone matches nothing.
 */
export function alwaysAskMatch(
  entries: readonly string[],
  escalation: Pick<Escalation, 'question' | 'context' | 'options'>,
): string | undefined {
  const have = new Set(
    words([escalation.question, escalation.context ?? '', ...(escalation.options ?? [])].join(' ')),
  );
  return entries.find((entry) => {
    const need = words(entry).filter((w) => !FILLER.has(w));
    return need.length > 0 && need.every((w) => have.has(w));
  });
}

/** Each task's root: itself, or the top of its `parentId` chain, as `task.created` has it. */
export function rootTasks(store: EventStore): (taskId: string) => string {
  const parent = new Map<string, string>();
  for (const e of store.query({ typePrefix: 'task.created' })) {
    const t = Task.safeParse(e.envelope.data);
    if (t.success && t.data.parentId !== undefined) parent.set(t.data.id, t.data.parentId);
  }
  return (taskId) => {
    let at = taskId;
    // A cycle cannot come from Tacet's own writes; stop at one anyway.
    const seen = new Set<string>();
    for (let p = parent.get(at); p !== undefined && !seen.has(p); p = parent.get(at)) {
      seen.add(at);
      at = p;
    }
    return at;
  };
}

/** What an exact precedent gives: the answer, and the Decision and escalation it came from. */
export interface Precedent {
  answer: string;
  decision: Decision;
  escalationId: string;
}

/**
 * The newest exact precedent for `escalation` (ADR-004 A): a Decision of the user's (`source:
 * user`), not superseded, of scope `repo` or of a task with the same root task, recorded for an
 * escalation whose question and options have the same key. When the new question has options,
 * the decision must be one of them, and the answer is that option as the new question spells it.
 * Approval requests are never precedent: their Decisions are the user's verdict on a proposal,
 * not an answer to a question.
 */
export function findPrecedent(store: EventStore, escalation: Escalation): Precedent | undefined {
  if (escalation.taskId === undefined) return undefined;
  const raised = new Map<string, Escalation>();
  for (const e of store.query({ typePrefix: 'escalation.raised' })) {
    const x = Escalation.safeParse(e.envelope.data);
    if (x.success) raised.set(x.data.id, x.data);
  }
  const decisions: Decision[] = [];
  const superseded = new Set<string>();
  for (const e of store.query({ typePrefix: 'decision.recorded' })) {
    const d = Decision.safeParse(e.envelope.data);
    if (!d.success) continue;
    decisions.push(d.data);
    if (d.data.supersedes !== undefined) superseded.add(d.data.supersedes);
  }
  const rootOf = rootTasks(store);
  const root = rootOf(escalation.taskId);
  const key = precedentKey(escalation.question, escalation.options);
  for (const d of decisions.reverse()) {
    if (d.source !== 'user' || superseded.has(d.id) || d.escalationId === undefined) continue;
    const inScope = d.scope === 'repo' || (d.taskId !== undefined && rootOf(d.taskId) === root);
    if (!inScope) continue;
    const asked = raised.get(d.escalationId);
    if (!asked || asked.category === 'decision' || asked.proposedDecision !== undefined) continue;
    if (precedentKey(asked.question, asked.options) !== key) continue;
    let answer = d.decision;
    if (escalation.options && escalation.options.length > 0) {
      const want = normalizeQuestion(d.decision);
      const option = escalation.options.find((o) => normalizeQuestion(o) === want);
      if (option === undefined) continue;
      answer = option;
    }
    return { answer, decision: d, escalationId: asked.id };
  }
  return undefined;
}

export interface DeterministicGateOptions {
  store: EventStore;
  /** `escalation.always_ask` from the merged config. */
  alwaysAsk?: readonly string[];
}

/**
 * The escalation gate without a model (ADR-004): answers only with an exact precedent of the
 * user's, at every autonomy level and every urgency but `blocking`. `blocking` questions, approval
 * requests and `always_ask` matches are left to the user.
 */
export function deterministicGate(o: DeterministicGateOptions): EscalationGate {
  return async (escalation) => {
    if (escalation.urgency === 'blocking') return undefined;
    if (escalation.category === 'decision' || escalation.proposedDecision !== undefined) {
      return undefined;
    }
    if (alwaysAskMatch(o.alwaysAsk ?? [], escalation) !== undefined) return undefined;
    const p = findPrecedent(o.store, escalation);
    if (!p) return undefined;
    return {
      answer: p.answer,
      source: 'precedent',
      rationale: `The user answered the same question before (escalation ${p.escalationId}, decision ${p.decision.id}).`,
    };
  };
}
