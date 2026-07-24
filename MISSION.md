# Mission — King AI Operations Hub

## Purpose

This document defines why King AI Operations Hub exists, what it must always
be, and what it must never become. Every product decision, sprint plan, and
architecture change should be checkable against this document the way code is
checkable against [ARCHITECTURE.md](ARCHITECTURE.md)'s invariants.

## Scope

Covers mission, principles, values, success metrics, and permanent exclusions.
Does **not** cover market strategy ([PRODUCT_VISION.md](PRODUCT_VISION.md)),
organizational roles ([TEAM.md](TEAM.md)), or delivery process
([WORKFLOW.md](WORKFLOW.md)).

## Definitions

| Term | Meaning |
|---|---|
| **Owner** | The accountable human. Today: the founder. In a commercial future: each customer's accountable human(s). |
| **Workspace / Project** | An isolated tenant unit (UI says *workspace*, schema says *project* — same thing; see [HANDOFF.md](HANDOFF.md) §3). |
| **Consequential action** | Anything in the closed action enum of [SECURITY.md](SECURITY.md) §4 — an act with effects outside the platform. |
| **Sovereignty** | The property that no consequential action occurs without explicit, recorded human approval. |

## Why this product exists

Model capability stopped being the bottleneck; **governance** became it. Anyone
can ask a frontier model to do work. Almost no one can:

- run AI work across several ventures without context bleeding between them;
- get a *second, adversarial* opinion from a competing vendor before trusting output;
- know, to the cent, what each piece of work cost — before and after;
- prove, later, exactly what was said, by which model, and who approved what;
- let models *propose* real-world actions while making execution physically
  impossible without a human decision.

King AI Operations Hub exists to make delegating work to AI **safe enough to be
boring**: isolated by construction, reviewed by a rival, priced exactly,
audited immutably, and always subordinate to a human.

## Long-term mission

> **Become the operating system for accountable AI delegation** — the control
> plane through which a person or team runs a portfolio of AI-executed work
> with the same confidence, isolation, and auditability a bank demands of its
> ledger.

Near horizon (internal tool): one owner, five ventures, two vendors.
Far horizon (platform): any owner, any portfolio, any provider or tool that
can pass the [PLUGIN_SDK.md](PLUGIN_SDK.md) bar — with the same guarantees at
every scale.

## Core principles

1. **Isolation is structural, not procedural.** Tenant separation lives in the
   database's row-level security and the type system, never in developer
   discipline. (Invariant I1, [ARCHITECTURE.md](ARCHITECTURE.md) §2.)
2. **Models propose; humans dispose.** There is no code path from model output
   to real-world effect that does not pass a recorded human approval.
   (Invariant I4; threat T2 in [SECURITY.md](SECURITY.md).)
3. **Disagreement is the product.** Cross-vendor review exists because two
   models from the same family share blind spots. The reviewer is always the
   *other* vendor by construction ([DECISIONS.md](DECISIONS.md) D-005).
4. **Bounded by design.** Agent loops are unrepresentable, not discouraged
   (D-006). Spend is gated before the first token (I8). Every limit is a
   constant, not a convention.
5. **History is sacred.** Messages and audit events are append-only and
   hash-chained (I6, I7). Corrections are new records. The past is never edited.
6. **Exact money.** Costs are integer micro-dollars computed against a
   versioned pricing table (D-004). "About" is not a cost.
7. **Model output is hostile until proven otherwise.** Everything a model
   returns is untrusted input (I3) — parsed against strict schemas or
   protocols, rendered as text, never executed.
8. **The simplicity gate.** Every feature must answer yes to all three:
   does it strengthen the mission? does it reduce (or at least not increase)
   complexity? can a new engineer understand it within minutes? Failing any
   one means redesign or rejection ([DECISIONS.md](DECISIONS.md) D-013).
9. **Objectives over tasks.** The platform is organized around what the owner
   is trying to achieve, not the unit of AI execution — features are designed
   top-down through Objective → Milestone → Task → Run (D-010).

## Non-negotiable values

These survive any pivot, rewrite, or acquisition conversation:

- **The human is accountable, so the human is in command.** No "fully
  autonomous mode," ever, for consequential actions.
- **A customer's data is theirs alone.** No cross-tenant learning, search,
  analytics, or "anonymized insights" across workspace boundaries.
- **Auditability over convenience.** If a feature requires mutable history,
  the feature is wrong.
- **Fail closed.** Missing budget row → no spend. Unknown model → priced at the
  ceiling. Unparseable action → discarded and audited. Ambiguity never
  resolves in the direction of risk.
- **No dark patterns on cost.** Spend is visible, capped, and attributed
  before the owner is ever surprised.

## Success metrics

### Current phase (internal tool)

| Metric | Target | Source |
|---|---|---|
| Cross-tenant data incidents | **0, forever** | Tenancy test suite + audit review |
| Consequential actions executed without approval | **0, forever** | `approvals` + audit chain |
| Review catch rate (revise/reject verdicts that changed the final output) | Track first, then target | `run_steps.verdict` |
| Cost per completed task | Visible per task; monthly ≤ configured caps | `usage_events` |
| Task cycle time (submit → consolidated result) | < 3 min p90 | `runs` timestamps |
| Owner approval latency (proposal → decision) | < 24 h (before expiry) | `approvals` |
| Quality gate status on main | Green at every commit | CI |

### Platform phase (leading indicators, when commercial)

- Weekly active workspaces per owner; tasks per workspace per week.
- % of tasks run with review enabled (proxy for trust in the differentiator).
- Revenue per workspace vs. model spend per workspace (gross margin per tenant).
- Time-to-first-completed-task for a new owner (< 15 minutes).

## What the platform will never become

Restating and extending the "Deliberately not planned" list of
[ROADMAP.md](ROADMAP.md):

1. **An autonomous agent swarm.** No unbounded model-to-model loops; no agent
   that selects its own next consequential action without a human gate.
2. **A cross-tenant intelligence product.** No feature that reads across
   workspace boundaries — including search, dashboards, or model fine-tuning
   on customer data.
3. **A model vendor.** We orchestrate and govern providers; we do not train or
   host foundation models, and we stay credibly neutral between vendors.
4. **A surprise-billing machine.** No usage pattern where the owner learns the
   cost after the fact without having set the ceiling first.
5. **A place where history can be rewritten.** No admin tool, support
   backdoor, or "compliance feature" that edits messages or audit rows.

## Examples

- *Aligned:* adding a "cost estimate before run" preview — serves principles 4
  and 6. — *Build it.*
- *Aligned:* a per-workspace GitHub integration that opens PRs only after
  approval — passes principle 2 via Phase 3 executors. — *Roadmapped.*
- *Violates:* "let power users skip approvals for low-risk actions" — breaches
  the non-negotiable on sovereignty. The correct feature is faster approval UX,
  not absent approval. — *Reject.*
- *Violates:* "search across all my workspaces at once" — breaches value 2 even
  though all workspaces belong to the same owner today. — *Reject; offer
  per-workspace search.*

## Future considerations

- When multiple humans share an org, "the human is in command" needs a
  role-aware definition (which human, for which action class) — see the open
  question in [SPRINT-01-REPORT.md](SPRINT-01-REPORT.md) §5 and
  [TEAM.md](TEAM.md) escalation rules.
- Success metrics should graduate from "tracked in SQL" to a first-class
  reporting surface when Objectives land ([OBJECTIVES.md](OBJECTIVES.md)).

## Related documents

[PRODUCT_VISION.md](PRODUCT_VISION.md) · [TEAM.md](TEAM.md) ·
[WORKFLOW.md](WORKFLOW.md) · [OBJECTIVES.md](OBJECTIVES.md) ·
[ARCHITECTURE.md](ARCHITECTURE.md) · [SECURITY.md](SECURITY.md) ·
[ROADMAP.md](ROADMAP.md) · [DECISIONS.md](DECISIONS.md)
