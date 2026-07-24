# Sprint 4 Report — "Build the Company"

> Prepared for the owner/CEO. Snapshot: 2026-07-24, end of Sprint 4.
> Authorization: Executive memo "Build the Company" (2026-07-24). Prior
> reports: [SPRINT-01](SPRINT-01-REPORT.md) · [SPRINT-02](SPRINT-02-REPORT.md)
> · [SPRINT-03](SPRINT-03-REPORT.md).

---

## 1. Executive Summary

**What was accomplished.** Sprint 4 changed what the product *is* to the
person using it. Before: an orchestration console that ran AI models on
tasks. After: a company you manage — objectives with success criteria that
gate completion, employees organized in departments with visible track
records and costs, and a dashboard that answers "how is my company doing?"
in one glance. The orchestration engine did not change at all this sprint —
exactly as directed — it just stopped being the thing you look at. All five
priorities from the authorization memo were delivered in four commits, each
gate-green, with the completion gate (the sprint's one hard business rule)
pinned by seven integration tests.

**Overall assessment.** The workforce framing is no longer a documentation
promise; it's the interface. What remains between here and "approachable for
a non-technical user" is one structural gap this sprint deliberately did not
touch: workspaces still come only from the seed script — there is no
create-a-workspace UI, which is the front door of the ONBOARDING.md journey.
That gap is the recommended next sprint (§9).

**Internal consistency.** The implementation followed D-015's
assignment-dimension reading (the memo's containment hierarchy was set aside
per the approved design review — sponsoring department and accountable
employee are attributes on objectives, and it worked exactly as predicted:
zero schema changes were needed beyond what Sprint 3 shipped dark).

## 2. Work Delivered

| Priority | Delivered | Commit |
|---|---|---|
| **P1 Objectives** | Full experience on the dark schema: create (criteria + sponsoring department + accountable employee), list + detail with progress rollup (tasks/criteria/milestones → %), milestone add/progression, criteria **met / waive / reopen** with verifier identity recorded, audited status transitions, and THE gate: completion refused while any criterion is unmet, refusal names the outstanding criteria; closed objectives are immutable. Tasks attach via form selector or `?objective=` deep link. | `6ae987c` |
| **P2 Employees** | Agents page → **Employees**: cards grouped by department showing work done, review impact (intervention rate of reviews given), cost this period, working-now badge, accountable objectives, "on leave" for disabled. All derived from existing run/usage records — zero new write paths. Config behind a Configure disclosure. | `4d70067` |
| **P3 Executive dashboard** | Needs-your-decision · Working now · Objectives at risk (active, nothing in motion) · spend + budget bar · active objectives w/ progress · team roster with live/idle dots and per-employee cost · Blocked panel for failed work · recent work in business language. | `4d70067` |
| **P4 Workflows** | Work flows objective-first: dashboard → objective → "+ Assign work toward this objective" → pre-attached task → run → progress moves the objective. Implemented per D-015 (assignment dimension), not the memo's literal containment chain — see §4. | `6ae987c` |
| **P5 Simplicity** | Vendor names and models are now diagnostics: task form leads with objective + brief, "Cross-check this work" replaces review jargon, flagship = "Assign senior staff", vendor routing behind Advanced with the default in plain words; dashboard and history speak business language throughout. Data model untouched — presentation only. | `2db4367`, `4d70067` |

Also this sprint (carried from Sprint 3 closeout, commit `96ad765`): E2E
credentials wired, sandbox workspaces seeded, suite green in a real browser —
and re-run green after every Sprint 4 UI change (it caught one regression:
the renamed dashboard button).

**End-of-sprint deliverables checklist (from the memo):** create Objectives ✅
· track progress ✅ · assign work naturally ✅ · view Departments ✅ · view
Employees ✅ · company status from a dashboard ✅ · "managing a workforce, not
configuring providers" ✅ — with the §9 caveat that *workspace creation*
itself is still seed-only.

## 3. Evidence

- 110 unit/integration tests + 2 E2E, all green; typecheck + lint clean on
  every commit.
- 7 new integration tests pin the completion-gate lifecycle end to end
  (draft → refuse jump → activate → refuse with unmet criteria → met+waive
  with verifier recorded → complete → closed = immutable).
- Live DB: 8 departments; 5 objectives (test fixtures); audit chain intact at
  **70 rows, 0 broken links** — every criterion change and status transition
  of the sprint is in it.
- E2E exercised the changed UI in a hydrated browser after each priority
  landed (the A11 lesson from Sprint 3, now practiced).

## 4. Deviations and judgment calls

1. **Hierarchy**: implemented D-015 (approved) rather than the memo's literal
   `Department → Employee → Objective` containment. Consequence: zero
   fragmentation of cross-functional objectives, zero schema change. Flagged
   again here for transparency; a one-line "confirmed" from you closes it.
2. **"At risk" definition**: an active objective with no work in motion
   (all attached tasks finished, progress < 100%). Deliberately conservative
   — no target-date model exists yet (milestone `target_date` is stored but
   unused by UI). Richer risk signals (deadline slip, budget burn) are
   Sprint 5+ material.
3. **Employee detail pages**: the memo says "eventually support" — cards
   carry the full metric set now; dedicated per-employee pages deferred until
   there's more history to show on them.

## 5. Outstanding Questions (owner)

1. Confirm the D-015 hierarchy reading stands (§4.1) — one word.
2. **PartsHunt Pro still has zero runs** — the only workspace never proven
   live. Two minutes whenever you're in there.
3. Carried, defaults safe: approval expiry 24h · single-owner · local-only ·
   `gpt-5.4-mini` price verification (Medium debt).

## 6. Technical Debt

| Rank | Item | Type | Status |
|---|---|---|---|
| **High** | No workspace-creation UI (seed-only) — blocks the ONBOARDING.md journey and any non-technical user | Product | → Sprint 5 P1 |
| **Medium** | Nonce-based production CSP (deployment-gated) | Technical | Carried (A10) |
| **Medium** | Approval-expiry sweep (A5); bucket pruning (A7) — deferred again in favor of memo priorities | Technical | Carried |
| **Medium** | `gpt-5.4-mini` pricing unverified | Product | Carried |
| **Low** | Milestone `target_date` stored but not settable/shown in UI | Product | New |
| **Low** | Objective test fixtures accumulate in the local DB (archived, invisible, but present — audit RESTRICT pins them by design) | Technical | New, accepted |
| **Low** | USER_JOURNEY.md deprecation pointer still missing | Documentation | Carried |

## 7. Risks

**Product** — *Objective theater*: criteria can be waived freely, so the gate
is honest only if waiving stays deliberate. Mitigation already in place:
waives are visually distinct, audited with identity, and reversible
(reopen); watch the waive rate once real objectives exist. *Idle ≠ useless*:
the dashboard marks employees idle-this-period; with six workspaces and four
employees each, most will always read idle — acceptable at this scale, revisit
the definition when departments diversify.

**Technical** — the sprint added read paths and presentation only; no new
attack surface, no engine changes, no new dependencies. The heaviest new
query (employee stats) is 4 indexed aggregates per page load — negligible at
current scale, and a natural view/materialization candidate later.

**Security** — unchanged. Objective mutations are tenant-scoped, audited,
and behind requireTenant like everything else; the completion gate is
server-side (the UI buttons are convenience, not enforcement).

## 8. Sprint Review

| Dimension | Score | Reasoning |
|---|---|---|
| Scope | 9/10 | All five priorities; P4 satisfied through P1's flow rather than net-new work — right call, but the memo's fullest reading (e.g. department-level views) has room left |
| Quality | 9/10 | Gate-green commits, E2E after each UI change, the business rule integration-tested; −1: no E2E specifically for the objectives flow yet |
| Completeness | 9/10 | Memo checklist fully checked; workspace creation gap is real but was never in the memo |
| Maintainability | 10/10 | Derived-only metrics (no new write paths), presentation-only simplicity changes, one new domain module with clean seams |
| Future scalability | 9/10 | Objectives/employees UIs sit directly on the dark schema as designed; stats queries will want views at 100× scale |

**Overall: 9/10.** The sprint delivered the product transformation the memo
asked for without touching the engine, the schema (beyond what was already
dark), or the security posture — the cheapest possible version of the most
visible possible change. The missing point: an objectives E2E scenario and
the workspace-creation front door.

## 9. Recommended Sprint — Sprint 5: "The Front Door"

The single highest-value next milestone: make the platform self-serve from
zero, per [ONBOARDING.md](ONBOARDING.md).

**Objectives**
1. Workspace creation UI with auto-staffing (default employees, budget,
   charter) — the missing front door.
2. The guided first-run journey: meet the team → first objective → first
   assignment, with the objective-first framing ONBOARDING.md specifies.
3. Assignee-first task form (employee picker replacing the review/vendor
   controls as the visible choice) — the last P5 item.
4. An objectives E2E scenario (create → activate → attach → gate-refusal →
   complete) joining the suite.

**Deliverables** — create-workspace flow + provisioning service; onboarding
route for zero-workspace users; employee-picker task form (D-005 pairing
derived from the pick); `onboarding.stage_reached` audit instrumentation;
E2E for objectives + onboarding happy path; sprint report.

**Estimated complexity** — Medium. ~6 sessions (provisioning 1.5, journey UI
2, assignee-first form 1, E2E + polish 1.5).

**Dependencies** — none external; §5.1 confirmation folds in the hierarchy
question.

**Success criteria** — a brand-new account reaches an approved first result
in under fifteen minutes without touching a seed script or seeing a model
name; the objectives E2E pins the gate in the browser; all existing gates
stay green.

## 10. CEO Briefing (one page)

**1. Where are we now?** You asked for a company, not a console — that's
what renders now. Objectives with real completion discipline, employees with
track records and costs, departments as the org chart, and a dashboard that
tells you who's working, what's blocked, what needs you, and what's at risk.
Underneath, nothing moved: same engine, same isolation, same audit chain
(70 records, zero breaks), same three-cent bill.

**2. Biggest remaining challenge?** The front door. Everything works
beautifully *inside* a workspace, but workspaces themselves still come from
an engineer's script. Until a new user can walk from empty account to first
approved result unassisted, "approachable for non-technical users" is a
demo, not a property. That's Sprint 5, and it's well-specified already
(ONBOARDING.md).

**3. What should I personally focus on?** Use it as the manager it now
thinks you are: create one real objective in a real workspace this week —
with two or three honest success criteria — and run its work through it.
Where the framing chafes, tell me; that feedback is worth more than any
backlog item. (And PartsHunt Pro still awaits its two-minute smoke run.)

**4. Ready to continue?** Yes. No new debt above Medium except the known
front-door gap, which is the next sprint by design.

**5. Decisions needed before Sprint 5?** One word confirming the hierarchy
reading (§4.1), and go/no-go on Sprint 5 as scoped. Everything else holds
its default.

---

*Requesting: approval of this report and authorization for Sprint 5 — "The
Front Door."*
