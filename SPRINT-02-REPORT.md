# Sprint 2 Report — Product Foundation

> Prepared for the owner/CEO before approval to merge. Snapshot: 2026-07-23,
> end of the Product Foundation sprint. Prior report:
> [SPRINT-01-REPORT.md](SPRINT-01-REPORT.md) (engineering foundation).
> Repo: `C:\Users\baldd\dev\king-ai-ops-hub` — still uncommitted; "merge" =
> approve the initial commit of the entire baseline (code + all documentation).

---

## 1. Executive Summary

**What was accomplished.** This sprint produced the complete business and
product documentation layer that turns an internal tool into a describable,
governable, commercially credible platform — seven new documents (mission,
product vision, team/AI-organization, workflow, objectives model, agent
catalog, plugin SDK specification) written to a uniform standard and wired
into the existing engineering docs by reference rather than duplication. Per
the sprint constraint, **zero changes** were made to architecture, security,
schema, or implementation. In parallel, owner onboarding completed: the
founder's account (`emperarecords@hotmail.com`) is signed up and bound as
admin to all five workspaces, and leftover test data was purged — the platform
now has its first real user and is one smoke-run away from proven end-to-end
operation with live provider keys.

**Overall assessment.** The project now has an unusual property for its age:
its business documents and its code point at the same named invariants
(I1–I8), decisions (D-001…D-009), and threats (T1–T7). A new engineer, an
investor, or a security reviewer can traverse from "what we promise" to "where
it's enforced" to "which test proves it" without hitting a gap. The remaining
weaknesses are operational, unchanged from Sprint 1, and small: no commit
history, the encryption key regeneration, and the first live provider run.

**Internal consistency.** Verified two ways: a scripted link-check confirms
all cross-references across the 14-document set resolve, and a manual review
found **no contradictions introduced by the new documents**. Two pre-existing
wording issues were *discovered* by writing them (§3, items 1–2) — both
documented with recommended one-line fixes, per the sprint's
document-don't-implement rule.

## 2. Documents Created

| File | Purpose | Key decisions made | How it supports the platform |
|---|---|---|---|
| **MISSION.md** | Why the product exists; principles, values, metrics, permanent exclusions | Mission = "operating system for accountable AI delegation"; 7 core principles each mapped to an enforcing invariant; a binding "never" list (no autonomy over consequential actions, no cross-tenant intelligence, no mutable history, fail-closed always); concrete success metrics with data sources | Every future feature request can be accepted/rejected against a written test, like code against invariants |
| **PRODUCT_VISION.md** | Market-facing definition: customers, problems, positioning, 3–5 year evolution | Three customer segments in adoption order (portfolio owners → studios/agencies → regulated teams); positioning against agent frameworks and vendor consoles; five competitive advantages, each mapped to a tested mechanism; ROADMAP.md declared authoritative on sequencing to prevent dual truth | Gives sales/fundraising language that is diligence-proof — every claim traces to a named, tested control |
| **TEAM.md** | The human+AI organization: authority, escalation, handoffs | Only humans hold approval authority — stated as a hard rule above all others; authority matrix across 5 roles; 5 escalation rules (invariant conflict ⇒ stop + document); handoffs require written artifacts; Coordinator defined as a role currently performed in-session, gaining a product surface with Objectives | Makes "who decides what" unambiguous before any second human or new agent joins |
| **WORKFLOW.md** | The complete lifecycle: objective → task → run → review → approval → artifact → completion | Unified the future business lifecycle with the implemented run lifecycle; sequence + state diagrams verified line-by-line against `engine.ts`; approval state machine documented incl. the future `executed` transition | One canonical description of how work flows, for onboarding users and building Phase 3 correctly |
| **OBJECTIVES.md** | Objectives as a first-class concept; hierarchy, lifecycle, ownership, reporting | Objectives are tenant-scoped (I1 applies unchanged); completion rolls up only by verification; priorities are single-ordinal with budget-pressure semantics; cross-project dependencies forbidden (covert-channel risk); **schema recommended, not implemented** — purely additive (2 tables + 1 join + 1 nullable column) | Turns the hub from a task runner into a system of record for *work*, and pre-approves the shape of a future migration sprint |
| **AGENT_CATALOG.md** | Registry of every AI agent, current and future | "No catalog entry → no run" rule; uniform read/write/execute/escalate vocabulary; 6 current agents specified (4 in-product + Claude Code + Claude Cowork); 5 future agents specified incl. Phase-3 Executors with hash re-verification and the MCP clients with single-project tokens; 7-point compliance checklist for adding any agent | Prevents capability creep: every agent's authority ceiling is written down before it exists |
| **PLUGIN_SDK.md** | Specification (only) for third-party providers and tools | Thesis: *a plugin can add capability, never authority*; providers implement the existing `AIProvider` contract with error-taxonomy and fail-expensive pricing compliance; tool writes are proposals into the existing approval queue — plugins cannot extend the action enum; capability manifests, semver, per-project secrets, event model that observes but cannot veto | Lets the Year-4 ecosystem grow without renegotiating a single security property |

All seven follow the mandated standard: Purpose / Scope / Definitions /
Examples / Diagrams (mermaid where useful) / Future considerations / Related
documents.

## 3. Cross-Document Review

**Contradictions — none introduced; two pre-existing found and documented:**

1. [SECURITY.md](SECURITY.md) §7 calls this "a single-owner system" while
   PRODUCT_VISION.md describes multi-tenant customers. Not a design conflict —
   the schema and adversary model (A3) are already multi-user — but the
   sentence will read as false in diligence. *Recommended fix:* reword to
   "currently operated single-owner; designed multi-tenant." One line, next
   doc-touching sprint.
2. [ROADMAP.md](ROADMAP.md)'s exclusion "autonomous background agents with no
   human in the loop" is ambiguous against the future read-only Cost Auditor
   (runs on a schedule, reports only). *Recommended fix:* tighten to "no
   autonomous agents that take or select consequential actions" — the intent
   every other document states. One line.
3. Carried from Sprint 1 (unchanged, already queued): three minor doc-code
   discrepancies in ARCHITECTURE.md/README.md.

**Mutual referencing:** scripted check — every `*.md → *.md` link across all
14 documents resolves; the new docs cite the engineering set 40+ times and
never duplicate its content (constraint honored).

**Terminology:** consistent by construction — the new docs adopted the
existing vocabulary (workspace=project stated once and reused; task→run→
step→message chain; invariant/decision/threat IDs) and added one new shared
vocabulary (read/write/execute/escalate permissions) used identically in
TEAM.md, AGENT_CATALOG.md, and PLUGIN_SDK.md.

**Responsibilities:** the TEAM.md authority matrix leaves no orphaned
capability — every row has exactly one Decide owner; approval authority
appears in exactly one column (Human Owner); the catalog's universal
constraints repeat the same ceiling for every agent.

**Vision ↔ architecture alignment:** every PRODUCT_VISION claim was checked
against an enforcing mechanism; no claim exists without one (the table in §
"Problems being solved" is literally claim → invariant). The 3–5 year
evolution introduces no capability that violates the MISSION "never" list —
the one near-miss (scheduled Cost Auditor vs. ROADMAP wording) is item 2 above.

## 4. Recommended Architecture Changes (not implemented)

Unchanged from Sprint 1 (A1–A7 in [SPRINT-01-REPORT.md](SPRINT-01-REPORT.md)
§4 remain valid), plus two new, documentation-driven items:

| # | Recommendation | Why it matters | Risk | Suggested sprint |
|---|---|---|---|---|
| A8 | **Objectives schema** per OBJECTIVES.md §Schema (2 tables, 1 join, 1 nullable column, RLS + tenancy-test extension) | Unlocks cost-per-outcome reporting and the Coordinator surface; shape is now pre-specified and owner-reviewable before any migration | Low (purely additive) | Sprint 4 |
| A9 | **Review-value metric** (revise/reject rate per project on the Usage screen) | It is the number MISSION.md and PRODUCT_VISION.md both cite as proof the differentiator works; data already collected in `run_steps.verdict` | Low (one query + one UI card) | **Sprint 3** |

## 5. Outstanding Questions (owner decisions — no assumptions made)

Carried, minus the resolved one (sign-up email — **done**,
`emperarecords@hotmail.com`):

1. **Real spend limits per workspace** — $25/month default still placeholder.
2. **Default models** — flagship (GPT-5.2 + Opus 4.8, current) vs. cheaper
   defaults with flagship on demand.
3. **Approval expiry window** — 24 h default: right for your rhythm?
4. **Multi-human access this quarter?** — affects role-UX investment.
5. **Deployment target/timing** — local-only until decided.
6. **Data retention & backup cadence** — Docker volume is still the only copy.
7. *New from this sprint:* **pricing/billing model** for the commercial phase
   (subscription vs. margin-on-spend vs. both) — PRODUCT_VISION deliberately
   leaves this open; no near-term pressure, but it shapes Year-2 architecture
   (billing on top of `usage_events`).
8. *New:* **market-facing name** — "King AI Operations Hub" is untested as a
   brand; a decision is only needed before anything public.

## 6. Technical Debt

| Rank | Item | Type | Status |
|---|---|---|---|
| **Critical** | `APP_ENCRYPTION_KEY` from non-CSPRNG; regenerate before any real secret is stored | Technical | Open (minutes of work; blocked only on merge approval) |
| **Critical** | No git commits — 14 documents and the whole codebase have no history | Process | Open; first action after approval |
| **High** | First live provider run not yet executed (keys are in; owner onboarded; one click remains) | Process | New this sprint — the last unproven link |
| **High** | E2E suite never run (now unblocked: real credentials exist) | Process | Open |
| **High** | Profile email-relink edge (500 on reversed onboarding order) | Technical | Open (A4) |
| **High** | Synchronous run execution | Technical | Open (A1) |
| **Medium** | Pricing table unverified against live vendor pages | Technical/Product | Open |
| **Medium** | Items §3.1–3.3 wording fixes (5 one-liners total) | Documentation | New/carried |
| **Medium** | Open sign-up + hardcoded dev DB password (deployment blockers only) | Technical | Open |
| **Medium** | Approval expiry lazy | Technical | Open (A5) |
| **Low** | Missing-concept documents (billing, onboarding, SLA, privacy, DR runbook, license) — identified, intentionally not invented without owner input | Documentation/Product | New — see §5 items 7–8 |
| **Low** | Sign-up toggle is easy to miss on the login screen (owner tripped on it) | Product | New — small UX fix, fold into Sprint 3 |
| **Low** | `rate_limit_buckets` pruning; leaf-doc cross-links | Technical/Doc | Open |

## 7. Risks and Mitigations

**Product** — *Documentation theater*: a beautiful doc set that drifts from
the code within three sprints. → Mitigation: the doc set is grep-checkable
(IDs cited from code), the link-check is scriptable into CI, and TEAM.md makes
doc updates part of the handoff definition of done. *Differentiator unproven
in numbers*: we claim review catches errors but don't yet display the rate. →
A9 in Sprint 3.

**Business** — *Founder bottleneck*: one person is customer zero, approver,
and decision-maker; deferred decisions (§5) silently become defaults. →
TEAM.md now states exactly that rule ("a deferred decision is a decision to
keep the default"), making the cost of deferral explicit; the §5 list keeps
the queue visible. *Name/brand risk* if anything ships publicly untested — no
action needed until deployment is decided.

**Technical** — unchanged from Sprint 1 (vendor drift contained in adapters;
single-machine DB → back up `pgdata` before experiments; sync runs capped).
No new technical risk was introduced — this sprint wrote no code.

**Security** — *Capability creep via future agents/plugins* was this sprint's
main target: AGENT_CATALOG's "no entry → no run" + manifest re-approval on
any capability change + PLUGIN_SDK's closed-action-enum rule together turn
creep from a drift risk into an explicit, auditable event. *Phase-3 executors*
remain the concentration point (unchanged); the catalog entry B1 now
pre-writes their constraints so the implementing sprint starts from a spec,
not a blank page.

**Scalability** — unchanged (A1 queue before teams; audit-chain sharding only
if multi-tenant SaaS materializes). The Objectives model adds negligible load
(two small tables, derivable rollups).

## 8. Sprint Review

| Dimension | Score | Reasoning |
|---|---|---|
| Scope | 10/10 | All 7 mandated documents delivered, all mandated sections present in each, plus onboarding completed and DB cleanup — nothing dropped |
| Quality | 9/10 | Uniform standard, diagrams verified against code, mechanical link-check, honest conflict reporting; −1: mermaid diagrams unrendered-verified only as syntax, not visually |
| Completeness | 9/10 | Product foundation complete for this stage; −1: the identified missing-concept docs (billing, privacy, DR) are named but unwritten — correctly, since they need owner decisions first |
| Maintainability | 9/10 | Reference-don't-duplicate discipline; shared ID spine makes drift detectable by grep; −1: link-check is a shell one-liner, not yet in the quality gate |
| Future scalability | 9/10 | Objectives and Plugin SDK give the two growth axes (work depth, ecosystem breadth) pre-agreed shapes; −1: both are specs whose real test comes at implementation |

**Overall: 9/10.** A documentation sprint earns this score by being
*load-bearing*: constraints honored exactly (zero implementation), conflicts
surfaced instead of papered over, and every business claim anchored to an
enforcing mechanism that already has a test. The missing point is the gap
every spec has until code meets it.

## 9. Recommended Sprint — Sprint 3: "Prove It Live" (Observable, Trustworthy Review)

The single highest-value next milestone, superseding-and-absorbing the
previously scoped engineering Sprint: first make the platform *proven in
production use by its owner*, then make its differentiator *observable*.

**Objectives**
1. Close the loop: the platform's first real, owner-driven, both-vendor run
   succeeds with live keys — then never let the proof rot (E2E in the gate).
2. Make review value visible: structured verdicts + the revise/reject metric.
3. Kill the wait: stream run progress live.
4. Zero out Critical/cheap debt (commit, CSPRNG key, relink bug, 5 doc
   one-liners, sign-up UX nit).

**Deliverables**
- Verified live smoke run in each of the five workspaces (evidence: usage
  rows, audit chain, screenshots).
- Initial git commit (baseline), then feature commits per change; CSPRNG
  encryption key.
- Structured reviewer verdicts (Zod schema: verdict + issues[] w/ severity) +
  diff-style review panel; `verdict_detail jsonb` nullable column on
  `run_steps` (only schema change).
- `stream()` on both adapters + SSE task-detail streaming.
- Golden-transcript suite (≥6 recorded exchanges pinning engine transitions).
- Review-value card on Usage (A9); email-relink fix + regression test; the
  five documentation one-liners (§3); login sign-up toggle made prominent;
  E2E running with real credentials in the verify script.

**Estimated complexity** — Medium. ~7 focused sessions (streaming 2,
verdicts+UI 2, transcripts 1, live-proof + E2E 1, debt 1).

**Dependencies** — Owner: decisions §5 items 1–2 (spend caps, default models —
needed before recording golden transcripts against the real config); ~20
minutes to run the first smoke tasks and approve the report. Nothing external.

**Success criteria**
- A `both`-provider task streams live, shows a structured review panel, and
  its cost/verdict feed the Usage metrics — in the owner's own browser.
- `npm run verify` green including transcript + E2E suites; repo has history;
  no Critical debt remains; §3 fixes merged.

## 10. CEO Briefing (one page)

**1. Where are we now?**
Two sprints in, you own a working governed-AI platform *and* the paper that
makes it a company. Sprint 1 built and verified the machine: five sealed
workspaces, two rival vendors reviewing each other, exact cost metering,
approval-gated actions, tamper-evident history — 75 tests green. Sprint 2
wrote the constitution around it: mission with a binding "never" list, a
market position where every claim maps to a tested control, an org chart for
humans and AIs where only humans ever approve, a work hierarchy ready to
implement, and an SDK spec that lets others extend the platform without ever
extending its authority. You are signed up, all five workspaces are yours, and
the only unproven thing left is one click: your first live run.

**2. What is the biggest remaining challenge?**
Unchanged and still ahead: Phase-3 executors — giving the platform hands. The
difference after this sprint: their constraints are now pre-written
(AGENT_CATALOG B1), so when we build them we implement a spec under review,
rather than improvise policy in code.

**3. What should I personally focus on next?**
Twenty minutes: (a) run the smoke task I've queued up in any workspace and
watch it work; (b) give me two numbers — monthly spend cap per workspace, and
whether defaults stay flagship (GPT-5.2 + Opus 4.8) or drop to cheaper models;
(c) say "approved" on this report so I can make the first commit. Everything
else in the outstanding list can wait or default safely.

**4. Are we ready to continue development?**
Yes — more ready than after Sprint 1, because the product now constrains the
engineering instead of trailing it. Gates are green, docs are
mechanically consistent, and Sprint 3 is scoped to convert the last
"should work" into "watched it work."

**5. What decisions do you need from me before Sprint 2 (i.e., the next sprint, Sprint 3)?**
Only the two in question 3 — spend caps and default models — because golden
transcripts should be recorded against the configuration you'll actually run.
Deferred-safely: approval expiry (24 h stands), multi-user (no), deployment
(local stands), billing model and brand name (needed only before going
public). Deferral is fine; each deferral keeps the stated default.

---

*Requesting approval to: (1) make the initial commit of the full baseline —
code plus all 14 documents; (2) regenerate the encryption key; (3) proceed to
Sprint 3 as scoped in §9.*
