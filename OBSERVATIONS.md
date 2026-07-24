# Observations — real usage of the Hub

> Sprint 10's deliverable is evidence, not features. This file records what
> actually happens when the platform is used: friction, ignored insights,
> repeated actions, unexpected workflows. Each entry is dated and states what
> was *observed*, not what was assumed. Findings here are the requirements
> document for Sprint 11.
>
> Harvested with `npm run observe` (read-only diagnostic).

---

## 2026-07-24 — First harvest (day 1 of the validation period)

**Scale so far:** 26 tasks, 23 completed runs, $0.43 total spend across 10
workspaces (6 real, 4 test fixtures). Too little for statistical claims —
recorded as a baseline, not a conclusion.

### O-1 · Objectives are being created without success criteria (product gap)

**Observed.** Both objectives created by the owner outside of tests —
"Architecture" (e2e-sandbox-b, draft) and "general" (partshunt-pro,
completed) — have **zero success criteria**. The second was completed
immediately.

**Why it matters.** The completion gate is the spine of the objectives model:
*"completion should remain impossible until all success criteria are
satisfied."* With zero criteria that rule is vacuous — the gate passes
trivially, and the objective completes on vibes. Real usage found this in a
day; no test could, because every test fixture dutifully supplies criteria.

**Interpretation (uncertain).** Two readings, and they lead opposite ways:
either the form makes criteria feel optional (a UX problem — fixable with
prompting, a template, or requiring at least one), or criteria genuinely
*are* overhead for lightweight objectives (a product problem — in which case
"objective" is doing two jobs and needs a lighter sibling). **This needs the
owner's read, not my guess.**

**Options, for decision:** (a) require ≥1 criterion, (b) allow zero but mark
such objectives "unverifiable" and exclude them from completion-based
insights, (c) offer suggested criteria at creation, (d) leave as-is.

### O-2 · Cross-check is consuming 79–99% of every workspace's spend

**Observed.**

| workspace | reviews | changed | review share of spend |
|---|---|---|---|
| king-ai-ops-hub | 6 | 17% | 97% |
| e2e-sandbox | 12 | 58% | 99% |
| kodiscan | 1 | 100% | 98% |
| accuratebids | 1 | 100% | 89% |
| bushandbelly | 1 | 100% | 79% |
| stresspro | 1 | 0% | 98% |

**Why it matters.** SPRINT-03-PLAN §2.2 predicted the reviewer would be the
expensive half; the real ratio is far more lopsided than "60–80%" — reviewers
write long, primaries write short, and Sonnet's output rate is 2.2× the
mini's. **The review-leverage insight (Sprint 9) will therefore fire often
and matter a lot** — its threshold logic is about to be load-bearing.

**Not yet actionable.** Sample sizes of 1 make "changed 100%" meaningless.
Revisit at ≥20 reviews per workspace.

### O-3 · Test fixtures pollute operational views (process friction)

**Observed.** Four `insight-*` fixture workspaces appear in the pending-
approvals query with real-looking `file_write` approvals; `obj-test-*` and
E2E objectives clutter the cost-per-outcome harvest.

**Why it matters.** Fixtures are archived, but archival only hides them from
pickers — not from operational queries. If the owner ever sees fixture rows
in the *briefing*, trust in the numbers dies instantly. The briefing filters
by membership so it is currently safe; the harvest is not.

**Fix (small, deferred to Sprint 11):** mark fixture workspaces with a flag
or key prefix convention and exclude them from all operational reads.

### O-4 · The front door was used (positive)

**Observed.** `kingdom-core` exists — a workspace created through the UI, not
the seed. It has one knowledge item (its charter, auto-provisioned) and no
work yet.

**Why it matters.** Provisioning works unattended and unassisted. The gap it
reveals is the *next* step: a workspace was created and then nothing
happened in it. The getting-started checklist exists; whether it was seen or
ignored is the open question.

### O-5 · Every failed run in the database predates Sprint 3's fixes

**Observed.** All 4 failed runs are from 2026-07-24 01:40–01:46: two
`gpt-5.2-mini does not exist`, two `rate limit hit` (actually quota
exhaustion). Zero failures since.

**Why it matters.** The failures are historical and already fixed — but they
still count toward the briefing's "needs attention" and the harvest's
friction signals *forever*. **Failure signals should age out** (e.g. 30-day
window) or the dashboard slowly fills with settled history.

### O-6 · The knowledge revise editor stays open after saving (minor friction)

**Observed.** After saving a new version, the editor remains open holding the
text just submitted, beside the newly rendered version. Found while writing
the knowledge E2E — the duplicate text broke a strict locator.

**Why it matters.** Small, but it is the kind of thing that makes a screen
feel unfinished: the user cannot tell whether the save took effect. Deferred
deliberately (Sprint 11 is validation, not polish) and recorded so it is
fixed from evidence rather than taste.

---

## Open questions this file exists to answer

1. Which insights fire, and are they *right*? (Nothing has fired yet in a
   real workspace — the thresholds are working as designed, staying silent.)
2. What does the owner do repeatedly that the product makes hard?
3. What does the owner do *outside* the Hub that should be inside it?
4. Does "prepared while you were away" become a habit or wallpaper?
   (Untestable until standing work exists in a real workspace — currently
   zero.)
