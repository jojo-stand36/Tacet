# ADR-004: The escalation gate and policy evaluation

- Status: proposed
- Date: 2026-11-11

Issue: #25. The plan, reviewed by the architect agent, is on #25. The owner decides items A to H in their own comment on the PR that adds this ADR.

## Context

ARCHITECTURE §2.2 gives the Mini-conductor an **escalation gate**: before an Escalation goes to the user, the gate tries to resolve it "by repo policy, past decisions, its own reasoning". §4 has the config keys for it: `escalation.autonomy` (`low | medium | high`), `escalation.always_ask`, and `policies` (rules checked task, then local, then repo, then user, with "a deny anywhere wins"). ADR-003 §6 has the MCP `escalate` tool return `resolved` with a `source` of `policy`, `precedent` or `mini` when the gate answers. ADR-001 lists what to borrow: Omnigent's three-level ALLOW/DENY/ASK policy model, and Gas Town's severity-routed escalation.

None of that is decided in detail, and the code has only a hook (`EscalationGate` in the MCP backend) that nothing plugs into. What the gate may answer, from which evidence, and what an answer is allowed to do, are hard to reverse once users rely on them: repos commit `policies`, and recorded precedent outlives the version that wrote it. Three facts shape the answer:

- **Workers are untrusted.** Their questions, contexts and proposals are text they wrote. Workers can read the run directory (`~/.tacet/run`, ARCHITECTURE §6) until the worker sandbox (#53) denies it, so they can also forge anything a token there allows.
- **Precedent multiplies.** A decision reused as precedent answers every later question that matches it. One wrong or forged precedent repeats.
- **The user is the scarce resource.** The point of the gate is that fewer questions reach them, without any reaching them less safely.

## Decision

### A. What counts as precedent

- Only Decisions with `source: user` are precedent: answers the user gave (#25 PR1 records each one as a Decision) and Worker proposals the user approved. Decisions with source `worker`, `mini`, `policy` or `precedent` never are. So a wrong answer by the gate is recorded, but never reused, and nothing a Worker can write becomes precedent on its own.
- A precedent applies when it is not superseded, and its scope is `repo`, or `task` with the same root task (a task's sub-tasks share the user's answers; ARCHITECTURE notes the change from "the same sub-task").
- Matching is exact: the question normalised (Unicode NFKC, case-folded, punctuation and spacing collapsed) and, when the question has options, the same options with the decision among them. Partial or keyword matches are never applied on their own; they are only candidates for the Mini-conductor's own reasoning (C). No embeddings.
- A `source: user` Decision that arrives through the Conductor's replica of another repo is not precedent while the Conductor link is unauthenticated (#330).

### B. Autonomy

| `autonomy` | The gate may answer from |
|---|---|
| `low` | `always_ask` and policy never answer; an exact user precedent (A) only. No model call. |
| `medium` (default) | As `low`, plus the Mini-conductor's own reasoning (C), only when it is grounded: it cites a candidate user precedent or a configured constraint. |
| `high` | As `medium`, plus the Mini-conductor's own reasoning on its own judgement, for urgency `low` or `normal` only; `high` and `blocking` always reach the user. |

The effective autonomy is the lowest of the user, repo, local and task layers' settings: a task may lower it, never raise it (as `workers.*`, ARCHITECTURE §4). A task's autonomy, which today exists only in the A2A task metadata (`TaskExt`), is kept on the stored Task.

### C. The Mini-conductor's own reasoning

- It runs on `tiers.mini` the way the planner and the reviewer do: on the API-key route, with no MCP server, every approval refused, in an empty working directory, with the Worker-process marker.
- It sees the question, its context and options, the task's goal, `always_ask`, at most five candidate precedents, and the repo's constraints. Worker-written text is fenced between random markers and labelled untrusted.
- Its reply is strict JSON (`{verdict: answer | forward, answer, rationale, cites, alwaysAsk}`), checked in code: every cited id must be a candidate it was given, the answer must be one of the options when there are options, and text is capped and redacted. Anything that does not check out forwards the question to the user.
- Its usage is charged to the sub-task (`agent.usage`), and it is skipped when the task's remaining budget is low. The `escalate` rate limit (6 per 10 minutes) bounds it.

### D. `always_ask`, policies and tool approvals

- `always_ask` beats precedent and reasoning: a question an entry matches goes to the user. Matching is by the entry's keywords, all present in the normalised question, context and options; the reasoning step is also asked whether an entry applies, and either one saying so is enough.
- `policies` are evaluated by a pure `evaluatePolicies(rules, request)` in `@tacet/core`, with **DENY > ASK > ALLOW** and no dependence on the order or layer a rule came from (layers are unioned). The input a rule matches is defined per tool (for Claude's file tools: each target path relative to the checkout; a rule matches if any path does). Tools without a defined input match only rules without a `match`.
- Until the worker sandbox (#53), policies only **narrow** the interim tool policy (#200): `deny` refuses with the rule's reason (`worker.approval`); `ask` refuses now (approvals are never held open, ADR-003's #184 addendum) and raises at most one Escalation per session and rule, which the user answers as a message to the Worker; `allow` grants nothing beyond what the interim policy allows.
- The committed repo layer may not `allow`: a cloned repo must not grant tools. A config that does is an error.
- An Escalation raised for a tool `ask` is never answered by precedent or reasoning: only the user answers it.
- CEL rules and an `ask` that grants the refused call once answered are later issues.

### E. What a gate answer is

- A gate answer is advice to the same Worker, never a permission. It cannot change the tool policy, approve a Worker's repo-wide proposal, or record repo precedent.
- Approval requests for a Worker's repo-wide proposal, Escalations for a tool `ask`, and Escalations the Mini-conductor raises itself (a blocked Worker, a merge conflict, protected config) never reach the gate.
- Each answer the gate gives is recorded, with its rationale and source, as a Decision (scope `task`), which `search_decisions` shows labelled by source and which is never precedent (A).

## Consequences

- Fewer questions reach the user only where the evidence is the user's own past answer, a configured rule, or (from `medium`) reasoning grounded in one of them. A question that could be dangerous to answer automatically (`blocking`, `always_ask`, a tool `ask`) always reaches the user.
- Prompt injection through a question can at worst make the gate give the same Worker advice it could have reasoned out itself; it costs tokens, bounded by the rate limit and budget, and cannot grant anything.
- The default (`medium`) makes a model call only when there is something to ground it in, so a repo with no precedent pays nothing.
- Policies committed to a repo can narrow what Workers may do, never widen it; widening waits for the sandbox (#53) and its own decision.
- `tacet status` shows the escalation rate (#25 PR2), so the effect of each autonomy level is measured, not assumed.
- Stale re-escalation of unanswered items belongs with the inbox (#26, #45), not the gate.

## Alternatives considered

- **Every Decision as precedent**, as the MCP tool surface might suggest: rejected. Worker-written and gate-written Decisions would then answer future questions, so one forged or wrong answer spreads.
- **Similarity matching (embeddings or keyword overlap) applied directly**: rejected. A near match on wording is not the same question; it is evidence for the reasoning step at most. An embedding model would also be a new dependency.
- **The gate approves tool use** (an `ask` answered by precedent or reasoning): rejected. Code a Worker wrote would then be approving its own tool calls.
- **Replace the interim tool policy with policies now**: rejected until the sandbox (#53). `allow` rules widening it would rest on the time-of-check assumptions the interim policy documents.
- **CEL for inline rules now** (ADR-001's later item): deferred. It needs a TypeScript CEL dependency, which must be justified on its own.
