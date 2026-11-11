# ADR-004: The escalation gate and policy evaluation

- Status: proposed
- Date: 2026-11-11

Issue: #25. The plan, reviewed by the architect agent, is on #25. The owner decides the items listed under "Owner items" in their own comment on the PR that adds this ADR.

## Context

ARCHITECTURE §2.2 gives the Mini-conductor an **escalation gate**: before an Escalation goes to the user, the gate tries to resolve it from "repo policy, past decisions log, its own reasoning". §4 has the config keys: `escalation.autonomy` (`low | medium | high`), `escalation.always_ask`, and `policies` (tool rules with `deny`, `ask` or `allow` and a `reason`). ADR-003 §6 has MCP `escalate` return `resolved` with a `source` of `policy`, `precedent` or `mini` when the gate answers. ADR-001 lists what to borrow: Omnigent's ALLOW/DENY/ASK policy model, and Gas Town's severity-routed escalation.

None of this is decided in detail, and the code has only a hook (`EscalationGate` in the MCP backend) that nothing plugs into. What the gate may answer, from which evidence, and what an answer may do, are hard to reverse: repos commit `policies`, and precedent outlives the version that wrote it. Three facts shape the answer:

- **Worker text is untrusted.** Questions, contexts and proposals are text a Worker wrote. So are the topics of Decisions made from them, and a cloned repo's committed `.tacet/tacet.yaml`.
- **Worker-written code runs as the user** (verify commands, Workers with a shell) and can read and write the run and state directories until the worker sandbox (#53) denies them (ARCHITECTURE §6).
- **Precedent multiplies.** A reused Decision answers every later question it matches, so one wrong or forged precedent repeats.

## Owner items

Approving this ADR approves these items; the letters match the plan on #25.

| Item | What | Where |
|---|---|---|
| A | What counts as precedent, and how it matches | A below |
| B | The autonomy levels, urgency, and the Mini-conductor's own reasoning | B below |
| C | `always_ask` beats precedent and reasoning | C below |
| D | Policies and tool approvals | D below |
| E | A gate answer is advice, never a permission; what never reaches the gate | E below |
| F | The MCP surface: the gate's time, one write, `escalation.resolved` fields, `record_decision` | ADR-003 addendum "the escalation gate on the MCP surface (#25)", items 1-4 |
| G | Where repo precedent may come from, and the residual risk until #53 | ADR-003 addendum item 5; "Residual risk" below |
| H | Roadmap changes | H below |

## Decision

### A. Precedent

- **Only Decisions with `source: user` are precedent**: answers the user gave (recorded as Decisions since #25 PR1) and Worker proposals the user approved. Decisions with source `worker`, `mini`, `policy` or `precedent` never are, so a wrong gate answer is recorded but never reused, and nothing a Worker records through Tacet's tools becomes precedent on its own.
- **Scope.** A precedent applies when it is not superseded and its scope is `repo`, or `task` with the same root task: a task's sub-tasks share the user's answers. (Today `search_decisions` scopes task decisions by sub-task; PR3 changes that, and ARCHITECTURE §2.2 says so.)
- **Exact match only.** The key is the escalation's question, normalised (Unicode NFKC, case-folded, punctuation and runs of space collapsed), plus its options sorted, both read from the `escalation.raised` the Decision's `escalationId` names. The question's `context` is not part of the key. When the new question has options, the precedent's decision must be one of them. `Decision.tags` are not used. When several precedents match, the newest applies.
- **Approved proposals** have a topic the Worker wrote and no question of the user's: they are never an exact match, only candidates for reasoning (B).
- **Candidates for reasoning** are the user's precedents (repo scope, or the same root task) that `search_decisions`' keyword scoring ranks with at least two shared terms, five at most. They are never applied without the reasoning step.
- **Revoking** a precedent is superseding it (a Decision with `supersedes`); a command for it is later work.
- **Other repos' Decisions are never precedent here.** Cross-repo reuse would come down the Conductor link with `tacet/decision.record` (ADR-003 §4), which #24 does not serve; it is deferred until the link is authenticated (#330) and decided on its own.

### B. Autonomy, urgency and the Mini-conductor's own reasoning

| `autonomy` | The gate may answer with |
|---|---|
| `low` | An exact user precedent (A) only. No model call. |
| `medium` (default) | As `low`, plus the Mini-conductor's own reasoning, only when there is at least one candidate precedent and the answer cites one. |
| `high` | As `medium`, plus the Mini-conductor's own reasoning without a candidate. |

- **Urgency.** `blocking` is never gated: it always reaches the user. `high` is answered only by an exact precedent. Reasoning answers only `low` and `normal`. The Worker sets urgency itself, so this is a cost and user-experience control, not a security boundary.
- **Merging.** `escalation.autonomy` follows §4's scalar rule across the user, repo and local layers (a layer that sets it replaces the one below; one that does not set it does not count, so `medium` applies only when none does). The task layer may only lower it: a task that raises it is a config error, as for `workers.*`. A task's autonomy, which today exists only in the A2A task metadata (`TaskExt`), is kept on the stored Task.
- **The reasoning step** runs on `tiers.mini` as the planner and the reviewer do: on the API-key route, with no MCP server, every approval refused, in an empty working directory, with the Worker-process marker. It sees the question, its context and options, the task's goal, `always_ask`, and the candidates (their topic, decision and id). All of that but the task's goal is fenced between random markers and labelled untrusted, each field capped at 4000 characters. Its reply is strict JSON (`{verdict: "answer" | "forward", answer, rationale, cites, alwaysAsk}`), checked in code: the cited ids must be among the candidates it was given, the answer must be one of the options when there are options, the rationale is capped and redacted. Anything that does not check out forwards the question to the user. Its usage is charged to the sub-task (`agent.usage`). It is skipped when the task has a budget and less than a tenth of it is left. The `escalate` rate limit (6 per 10 minutes) bounds how often it runs.

### C. `always_ask`

- `always_ask` beats precedent and reasoning: a question an entry matches goes to the user.
- Matching: an entry matches when each of its words (split on anything but letters, digits, `/`, `.` and `-`, lower-cased, with the words `a`, `an`, `the`, `and`, `or`, `to`, `of`, `anything`, `touching` dropped) appears in the normalised question, context or options. The reasoning step is also asked whether an entry applies (`alwaysAsk`), and either one saying so is enough.

### D. Policies and tool approvals

- **Policies never answer an escalation.** They decide tool approvals only. §2.2's "repo policy" for the gate now means `always_ask` (which forwards) and nothing else; the `source: policy` of ADR-003 §6 is reserved and not written until a rule kind that can answer exists (CEL, ADR-001's later item).
- `policies` are evaluated by a pure `evaluatePolicies(rules, request)` in `@tacet/core`: **DENY > ASK > ALLOW**, with no dependence on order or layer. Layers are unioned without their origin, and an order-free rule keeps ADR-001's "DENY short-circuits" without Omnigent's session > agent > server levels, which Tacet's layers do not map onto.
- A rule's `tool` is matched exactly, or as a prefix when it ends in `*`. Its `match` is a glob (`*` within a path segment, `**` across segments, `?` one character) on the request's input, defined per tool: for Claude's file tools, each target path relative to the checkout, and a rule matches if any path does. A tool without a defined input matches only rules without `match`. Tacet's own MCP tools (`mcp__tacet__*`) are never subject to policies, so a rule cannot cut a Worker off from `escalate`.
- **Until the worker sandbox (#53), policies only narrow** the interim tool policy (#200): `deny` refuses with the rule's `reason` (`worker.approval`); `ask` refuses now (approvals are never held open, ADR-003's #184 addendum) and raises at most one Escalation per session and rule, which the user answers as a message to the Worker; `allow` grants nothing beyond the interim policy. For a Worker without an MCP client (#184), the refusal is one of the refused requests its `blocked` escalation already reports, so no second escalation is raised.
- **The committed repo layer may not `allow`**: a cloned repo must not grant tools. A config that does is an error.
- An Escalation raised for a tool `ask` never reaches the gate (E).

### E. What a gate answer is

- A gate answer is advice to the sub-task, never a permission. It cannot change the tool policy, approve a Worker's repo-wide proposal, or record repo precedent.
- Never gated: approval requests for a Worker's repo-wide proposal, Escalations for a tool `ask`, Escalations the Mini-conductor raises itself (a blocked Worker, a merge conflict, protected config), and `blocking` ones.
- Each answer the gate gives is recorded with its source and rationale as a Decision of scope `task`. Later sessions of the sub-task see it (`read_task`, `search_decisions`, labelled by source), it is forwarded to the Conductor as `decision.*`, and it is never precedent (A).

### H. Roadmap

With this ADR's approval, and by the owner's request:
- Stale re-escalation of unanswered items moves out of #25 to the inbox (#26, #45, which already list it); their issues are updated to say so.
- New issues: "Policies: CEL rules that can answer an escalation" (ADR-001's later item; `source: policy`), and "Tool `ask` that grants the refused call once answered, after the worker sandbox (#53)".

### Residual risk

Until the worker sandbox (#53) denies the state directory, code a Worker wrote runs as the user and can append a Decision with `source: user`, even repo-wide, straight into the repo's event log, bypassing the one-time answer code. The `source: user` rule protects the paths through Tacet (MCP tools, the control port, the Conductor link), not the log file itself. This is the same exposure ARCHITECTURE §6 already accepts for the run and state directories; the owner accepts it here for precedent until #53.

## Consequences

- Fewer questions reach the user only where the evidence is the user's own past answer or, from `medium`, reasoning grounded in one. Questions that could be dangerous to answer automatically (`blocking`, `always_ask`, a tool `ask`, an approval) always reach them.
- Prompt injection through a question can at worst make the gate give the sub-task advice it could have reasoned out itself. It costs tokens, bounded by the rate limit and budget, and grants nothing.
- At the default (`medium`) a repo with no matching precedent makes no model call.
- Policies committed to a repo narrow what Workers may do, never widen it; widening waits for #53 and its own decision.
- `tacet status` shows the escalation rate (#25 PR2), so the effect of each level is measured.

## Alternatives considered

- **Every Decision as precedent**: rejected. Worker-written and gate-written Decisions would answer future questions, so one forged or wrong answer spreads.
- **Similarity matching (embeddings or keyword overlap) applied directly**: rejected. A near match on wording is not the same question; it is a candidate for reasoning at most. Embeddings would also be a new dependency.
- **The gate answers tool `ask`s**: rejected. Code a Worker wrote would then approve its own tool calls.
- **Policies answer escalations now**: deferred to CEL rules, which would need a TypeScript CEL dependency justified on its own.
- **Replace the interim tool policy with policies now**: rejected until #53. `allow` rules widening it would rest on the interim policy's time-of-check assumptions.
- **Autonomy as the lowest of all layers**: rejected. It departs from §4's scalar rule and would stop a user from setting `high` for a repo that says nothing; only the task layer is clamped.
