import {
  type AutonomyLevel,
  Decision,
  Escalation,
  lowerAutonomy,
  type TacetConfig,
  Task,
} from '@tacet/core';
import type { EventStore } from '@tacet/core/node';
import type { EscalationGate } from '../mcp/backend.js';

/**
 * The deterministic part of the escalation gate (#25, ADR-004 A, C, E): an exact precedent of the
 * user's own, never `always_ask`, never `blocking`. The Mini-conductor's own reasoning (ADR-004 B)
 * comes later, behind the same `EscalationGate`.
 */

/**
 * A question as precedent compares it (ADR-004 A): Unicode NFKC, case-folded, punctuation
 * dropped, and runs of space collapsed. Symbols (`<`, `>=`, `+`, ...) are kept: they change what a
 * question asks.
 */
export function normalizeQuestion(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\p{P}+/gu, ' ')
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

/**
 * Words for `always_ask`: split on anything but letters, digits, `/`, `.` and `-`, lower-cased,
 * and with leading and trailing `.` and `-` trimmed, so a word that ends a sentence ("prod.") or
 * an ellipsis is still the word.
 */
function words(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}/.-]+/u)
    .map((w) => w.replace(/^[.-]+|[.-]+$/gu, ''))
    .filter((w) => w.length > 0);
}

/**
 * Whether the text's word `have` is the entry's word `need`: the same word, or, for a path entry
 * (one with a `/`), a path under it, so `/infra` covers `/infra/main.tf`. This only widens what
 * reaches the user.
 */
function covers(need: string, have: string): boolean {
  if (have === need) return true;
  if (!need.includes('/')) return false;
  return have.startsWith(need.endsWith('/') ? need : `${need}/`);
}

/**
 * The first `always_ask` entry the escalation matches, if any (ADR-004 C): one whose words, filler
 * dropped, all appear among the words of the question, its context or its options (a path entry
 * also covers the paths under it). An entry of filler alone matches nothing.
 */
export function alwaysAskMatch(
  entries: readonly string[],
  escalation: Pick<Escalation, 'question' | 'context' | 'options'>,
): string | undefined {
  const have = [
    ...new Set(
      words(
        [escalation.question, escalation.context ?? '', ...(escalation.options ?? [])].join(' '),
      ),
    ),
  ];
  return entries.find((entry) => {
    const need = words(entry).filter((w) => !FILLER.has(w));
    return need.length > 0 && need.every((n) => have.some((h) => covers(n, h)));
  });
}

/**
 * The autonomy the gate works at for `taskId` (ADR-004 B): the config's (merged so that only the
 * user raises it), lowered by its root task's own `autonomy` when that is lower.
 */
export function effectiveAutonomy(
  store: EventStore,
  config: TacetConfig,
  taskId: string,
): AutonomyLevel {
  const configured: AutonomyLevel = config.escalation?.autonomy ?? 'medium';
  const root = rootTasks(store)(taskId);
  for (const e of store.query({ taskId: root, typePrefix: 'task.created' })) {
    const t = Task.safeParse(e.envelope.data);
    if (t.success && t.data.id === root && t.data.autonomy !== undefined) {
      return lowerAutonomy(configured, t.data.autonomy);
    }
  }
  return configured;
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
 * Only answers to questions Workers asked through `escalate` are precedent: never approval
 * requests (the user's verdict on a proposal) nor the Mini-conductor's own escalations (a blocked
 * Worker, a merge conflict), whose answers are about that situation, not a Worker's question. A
 * Decision of another repo never is (ADR-004 A).
 */
export function findPrecedent(
  store: EventStore,
  escalation: Escalation,
  repo?: string,
): Precedent | undefined {
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
    // Whoever supersedes a Decision: superseding only ever removes precedent, and a Worker
    // cannot set `supersedes` through Tacet's tools.
    if (d.data.supersedes !== undefined) superseded.add(d.data.supersedes);
  }
  const rootOf = rootTasks(store);
  const root = rootOf(escalation.taskId);
  const key = precedentKey(escalation.question, escalation.options);
  for (const d of decisions.reverse()) {
    if (d.source !== 'user' || superseded.has(d.id) || d.escalationId === undefined) continue;
    if (repo !== undefined && d.repo !== undefined && d.repo !== repo) continue;
    const inScope = d.scope === 'repo' || (d.taskId !== undefined && rootOf(d.taskId) === root);
    if (!inScope) continue;
    const asked = raised.get(d.escalationId);
    // A Worker's `escalate` sets no category and always names its session.
    if (
      !asked ||
      asked.category !== undefined ||
      asked.sessionId === undefined ||
      asked.proposedDecision !== undefined
    ) {
      continue;
    }
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

/**
 * Whether the escalation always goes to the user, whatever precedent or reasoning would say
 * (ADR-004 B, C, E): `blocking` urgency, an approval request, or an `always_ask` match.
 */
export function forUser(escalation: Escalation, alwaysAsk: readonly string[]): boolean {
  if (escalation.urgency === 'blocking') return true;
  if (escalation.category === 'decision' || escalation.proposedDecision !== undefined) return true;
  return alwaysAskMatch(alwaysAsk, escalation) !== undefined;
}

export interface DeterministicGateOptions {
  store: EventStore;
  /** `escalation.always_ask` from the merged config. */
  alwaysAsk?: readonly string[];
  /** The repo id, so another repo's Decisions are never precedent. */
  repo?: string;
}

/**
 * The escalation gate without a model (ADR-004): answers only with an exact precedent of the
 * user's, at every autonomy level and every urgency but `blocking`. `blocking` questions, approval
 * requests and `always_ask` matches are left to the user. It reads the log synchronously, so the
 * backend's time limit does not bound it; it yields once first, so the call is asynchronous.
 */
export function deterministicGate(o: DeterministicGateOptions): EscalationGate {
  return async (escalation) => {
    await Promise.resolve();
    if (forUser(escalation, o.alwaysAsk ?? [])) return undefined;
    const p = findPrecedent(o.store, escalation, o.repo);
    if (!p) return undefined;
    return {
      answer: p.answer,
      source: 'precedent',
      rationale: `The user answered the same question before (escalation ${p.escalationId}, decision ${p.decision.id}).`,
    };
  };
}
