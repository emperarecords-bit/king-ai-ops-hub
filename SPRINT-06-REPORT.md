# Sprint 6 Report — "Every Morning"

> Prepared for the owner/CEO. Snapshot: 2026-07-24, end of Sprint 6.
> Authorization: Executive Response to Sprint 5 — "optimize for executive
> decision-making rather than feature count"; Knowledge designed, not rushed.
> Prior reports: SPRINT-01 … 05.

---

## 1. Executive Summary

**What was accomplished.** The Hub now opens with answers. The first page
after sign-in is the Morning Briefing: a one-line verdict on your day
("3 decisions waiting on you" / "your team is working" / "all caught up"),
four executive numbers (decisions waiting, completed overnight, needs
attention, working now), and every workspace's overnight story sorted
decisions-first with a one-click path into each approval queue. The
twice-deferred hygiene debt shipped *because* it's what makes those numbers
true: expired approvals are swept before any count renders, and stale
rate-limit rows self-prune. Company Knowledge was designed end to end —
schema, promotion loop, injection budget, trust-boundary review, four-phase
plan — and deliberately not implemented, per direction.

**Feature count this sprint: effectively one.** That was the assignment.

**Internal consistency.** The briefing honors I1 precisely: numbers
aggregate across workspaces, content never crosses — each workspace briefs
inside its own tenant transaction. KNOWLEDGE-DESIGN.md §6 documents the one
future exception (opt-in org-wide knowledge) before any code exists.

## 2. Work Delivered

| Item | Detail | Commit |
|---|---|---|
| Morning Briefing domain | Per-workspace digest (pending approvals + oldest age, 24h completed/failed runs, review interventions, objectives at risk, budget %, working now) with executive sort: decisions → trouble → activity | `647f6cc` |
| Briefing page | Replaces the workspace selector as post-login home; verdict line, four stat cards, per-workspace story lines, "Decide N" buttons, "quiet" states; workspace grid preserved via the story rows | `647f6cc` |
| A5 approval-expiry sweep | Pending past 24h expiry → `expired` + audit per row; runs on every approvals-page load and every briefing — queue counts and briefing numbers can no longer overstate | `647f6cc` |
| A7 bucket pruning | Stale rate-limit windows deleted on each successful consume (targeted by scope, no scheduler) | `647f6cc` |
| KNOWLEDGE-DESIGN.md | Buildable design over the D-011 spec: versioned never-edited items, artifact→knowledge promotion with human gate, scoped injection with token budget and "what did it know" run record, org-scope trust review, K1–K4 phasing (K1 has zero open questions) | `647f6cc` |

**Evidence:** 113 unit/integration tests + 3 E2E green; the critical-flow
E2E now walks through the live briefing. The browser suite caught a real
fault before the owner saw it (Date params inside raw SQL fragments don't
serialize — the briefing 500'd on first render; fixed and re-proven).
A5/A7 close the last carried items from the Sprint 1 recommendation list —
A1 (job queue) is now the only survivor, by design.

## 3. Deviations and judgment calls

1. **Standing work did not ship.** The Sprint 5 recommendation bundled
   briefing + standing work; the executive direction ("decision-making over
   feature count") argued for one surface done deeply. The briefing is that
   surface; standing work is the queued follow-up that gives it fresh
   content every morning.
2. **"Overnight" = rolling 24h**, not since-last-visit. Last-seen tracking
   is a session-state feature with privacy texture; the rolling window is
   honest and stateless. Revisit only if real usage shows double-reporting
   annoyance.
3. **The briefing is org-role-agnostic** — any member sees the digest of
   workspaces they belong to. Fine single-owner; role-shaped briefings
   (viewer vs admin) are a multi-user question.

## 4. Outstanding Questions (owner)

1. **Sprint 7 direction** — the one real decision (see §9): standing work
   (the briefing gains a reason to differ every morning) vs Knowledge K1
   (the compounding moat starts) vs your call that the executive workflow
   still isn't complete.
2. PartsHunt Pro: still zero live runs (fourth consecutive report; I'll
   drop this line on request).
3. Carried, defaults safe: approval expiry 24h · single-owner · local-only ·
   mini-model price verification.

## 5. Technical Debt

| Rank | Item | Type | Status |
|---|---|---|---|
| **Medium** | Nonce-based production CSP (deployment blocker) | Technical | Carried |
| **Medium** | `gpt-5.4-mini` pricing unverified | Product | Carried |
| **Low** | Briefing runs N sequential tenant transactions (one per workspace) — fine at 8, wants batching by ~50 | Technical | New |
| **Low** | `tasks.assignee_agent_id` column; onboarding funnel events; E2E for provisioning; USER_JOURNEY.md pointer | Various | Carried |
| ~~Medium~~ | ~~A5 expiry sweep · A7 bucket pruning~~ | — | **Closed this sprint** |

## 6. Risks

**Product** — *The briefing's honesty is its brand.* It now sweeps ghosts
before counting, but "at risk" and "worth reading" are judgment encodings;
if they cry wolf, the morning habit dies. Watch: does the owner click
through on "review catches"? If not, tighten the signal. *Empty mornings*:
with no standing work, a day without submitted tasks briefs as "all caught
up" — true but habit-neutral. This is the §9 fork.

**Technical** — no new write paths except the expiry sweep (bounded,
audited); briefing is read-only aggregation. Sequential per-workspace
transactions are the only scaling note (§5).

**Security** — no new surface. The sweep runs inside the caller's tenant
context; the briefing never widens reads; Knowledge's future I1 exception
is documented before implementation rather than discovered after.

## 7. Sprint Review

| Dimension | Score | Reasoning |
|---|---|---|
| Scope | 10/10 | Exactly what was directed: one executive surface, its supporting hygiene, and a design doc — restraint was the requirement |
| Quality | 9/10 | Three-layer testing; browser suite caught the one real bug pre-owner; −1 for shipping that bug to the dev server at all |
| Completeness | 9/10 | Briefing complete; −1: "worth reading" links to the workspace, not yet to the specific reviewed runs |
| Maintainability | 10/10 | Briefing is pure derivation over existing records; hygiene is piggybacked, not scheduled infrastructure |
| Future scalability | 9/10 | Knowledge design de-risks the biggest future subsystem; briefing batching noted before it hurts |

**Overall: 9.5/10.** The most focused sprint yet — it shipped less than any
predecessor and moved the product's center of gravity more than most.

## 8. The Morning Test (how we'll know it worked)

The briefing's success is behavioral, not architectural: does opening the
Hub pay before you type? First-week signals worth your own attention:
(a) do the four numbers match your intuition of what happened yesterday;
(b) did "Decide N" ever save you a hunt; (c) was anything important that
happened *not* on the briefing. Your answers to those three questions are
Sprint 7's real requirements document.

## 9. Recommended Sprint — Sprint 7: "Standing Work"

One recommendation, not a menu: **standing work** — recurring tasks attached
to objectives ("every Monday: competitive summary"), human-defined
schedules, runs through the existing engine and approval gate, surfaced on
the briefing as "prepared for you overnight."

**Why this over Knowledge K1:** the briefing currently reports what you
initiated; standing work makes mornings *generative* — there is something
new every day without you lifting a finger, which is the habit mechanic the
daily-operation analysis identified as decisive. Knowledge compounds value
per run; standing work creates the runs to compound. Sequence: habits first,
moat second. K1 remains fully designed and slots in as Sprint 8.

**Objectives** — schedule model on tasks (recurrence rule, next-run-at);
a scheduler tick (local: the existing Task Scheduler pattern; no autonomy
change — schedules are human-authored, every run stays budget- and
approval-gated); briefing integration ("prepared overnight" section);
management UI on the objective page.

**Deliverables** — schema (additive: `task_schedules`), runner integration,
briefing section, schedule CRUD with audit, tests incl. the
no-unbounded-recurrence guard, sprint report (auto, per new standing
instruction).

**Estimated complexity** — Medium. ~5 sessions.

**Dependencies** — none external. Decision only: §4.1.

**Success criteria** — a standing task defined on Friday appears as a
completed, reviewed, budget-metered result in Monday's briefing without any
human action in between except the approval decision if one is proposed.

## 10. CEO Briefing (one page)

**1. Where are we now?** The Hub opens with answers. Sign in and the first
thing you see is whether anything needs you, what your company did
overnight, which of it a reviewer flagged as worth your eyes, and a button
per workspace that takes you straight to the decisions. The numbers are
swept for truth before they render. Knowledge — the compounding memory that
will separate the Hub from every chat window — is fully designed and
waiting for your go.

**2. Biggest remaining challenge?** Making mornings generative. The
briefing reports beautifully on work you started; the next step is work
that starts itself — on your schedule, inside your budgets, behind your
approval gate.

**3. What should I personally focus on?** Live with the briefing for a few
mornings and answer the three questions in §8. That lived experience — not
a spec — should shape what "standing work" prepares for you overnight.

**4. Are we ready to continue?** Yes. Cleanest debt sheet of the project:
the Sprint-1 recommendation list is down to its final item (the job queue),
and nothing above Medium remains except the deployment-gated CSP.

**5. Decisions needed?** One: Sprint 7 direction — standing work
(recommended), Knowledge K1, or more executive-workflow polish first.

---

*Requesting: approval of this report and the Sprint 7 direction decision.*
