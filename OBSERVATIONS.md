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

### O-7 · The observation system was lying, and the truth is more interesting

**Observed.** With fixture workspaces excluded (O-3 fixed), the harvest lost
most of its content — and what remained finally described reality. The
corrections matter:

| Reported before | Actually true |
|---|---|
| 6 pending approvals | **0** — all six were in legacy `insight-*` test fixtures |
| 44 objectives created, 28 completed | **1 created, 1 completed** — the rest were fixtures |
| 46 workspaces created | **1** |
| 25 knowledge version events | **0 in real workspaces** |

**Why it matters.** Every earlier claim about "what the owner does here" was
measuring my test suite. Two prior reports carried those numbers. The lesson
is not "fix the query" — it is that **an observation system needs its own
correctness bar**, because a diagnostic that quietly measures the wrong
population produces confident, wrong strategy. This is the first thing this
sprint has proved, and it argues for the sprint's premise.

### O-8 · The owner leaves immediately after getting a result

**Observed.** Session reconstruction (30-minute gap = new session) over real
workspaces only: 6 sessions, and **3 of them end at `run.completed`** — the
single most common exit point. Sessions are short (0–36 min).

**Why it matters.** This is the ChatGPT-substitution pattern, visible in
data: *open the Hub → run one task → take the answer → leave.* Nothing pulls
the user onward to approvals, objectives, or knowledge. Everything built
after Sprint 5 — objectives, insights, briefing, knowledge — sits past the
point where the session already ended.

The executive question ("what makes someone open the Hub instead of
ChatGPT?") now has a sharper form: **what happens in the 30 seconds after a
result appears?** Today, nothing. That moment is the highest-leverage surface
in the product and it is currently a dead end.

### O-9 · Work happens here; planning happens elsewhere

**Observed.** 14 of 15 real tasks have **no objective attached**. Meanwhile
one objective exists, in a workspace where no tasks were run. The two halves
of the product are being used by the same person in different places, and
never together.

**Why it matters.** The hierarchy (Objective → Task → Run) is the product's
organizing idea, and in practice the owner enters at Task and never climbs.
Either attaching work to an objective is too much friction at task-creation
time, or objectives do not yet feel worth the ceremony. Both are fixable, but
the fix must not be "require an objective" — that would push task creation
out of the Hub entirely, which is the one workflow currently living here.

**Also observed:** `partshunt-pro` holds an objective titled "general" with
zero success criteria — created before D-017. Harmless, but it is the
artifact of exactly the behavior D-017 now prevents.

### O-10 · The owner could not find "Suggest criteria"

**Observed.** Asked directly: *"where is the suggested criteria button?"* It
is on the new-objective form, below the first criterion row, styled as a
plain inline text link beside "+ Add criterion" — below the fold at 720px,
same weight as its neighbor, with nothing indicating it does work for you.
The amber **Create objective** button directly beneath it is the loudest
element on the screen.

**Why it matters.** D-017 made success criteria mandatory for activation;
suggestions were the friction relief that made the requirement fair. **An
invisible relief leaves only the requirement.** The predicted failure modes
are exactly what the harvest would later show as adoption problems —
objectives filled with throwaway criteria, or objectives not created at all
(which is already O-9's pattern).

This is also a general lesson about how this product has been built: it was
implemented, tested, and reported as "delivered" without anyone checking
whether it could be *found*. Feature completeness and feature discoverability
are being measured by the same green checkmark, and they are not the same
thing.

**Recommended fix** (not applied — Sprint 11 is validation): promote it to a
real button beside the criteria heading, label it for its outcome
("Suggest criteria from the title"), disable it until a title exists so its
dependency is self-evident, and move it above the criterion rows so it is
seen before the manual path is taken.

### O-11 · Suggested criteria are plausible but not measurable — three of four had target 0

**Observed.** First real use of the feature (2026-07-24, objective *"connect
all ai to this hub"* in `king-ai-ops-hub`). It produced four criteria. Three
carried `target: 0`, and one tried to express a deadline:

| Label | Unit | Target |
|---|---|---|
| Number of AI chat sources connected to the hub | count | **0** |
| Number of project/workspace integrations connected | count | **0** |
| Percentage … searchable and viewable in one place | % | 100 ✓ |
| **Date** by which the first end-to-end connection works | date | **0** |

**Why it matters — this is correctness, not taste.** D-017's completion gate
is only as meaningful as the criteria it enforces. "Connected sources ≥ 0" is
satisfied by doing nothing; the gate becomes ceremony. And the fourth row is
a deadline forced through a `target: number` schema that cannot represent a
date, so it degraded to 0 rather than failing loudly.

Three distinct defects behind it:

1. **No positivity constraint.** The Zod schema accepts any finite number.
   A count or percentage target of 0 is almost never a real goal and should
   be rejected at validation, not stored.
2. **The schema has no date type.** The model reached for a real and common
   criterion kind ("done by X") and the schema quietly mangled it. Either
   support a date criterion or instruct the suggester that deadlines are not
   success criteria.
3. **Metric slugs are derived, not designed.** One key came out as
   `number_of_project/workspace_integrations_connected_to_the_hub` — a
   slash inside an identifier, and otherwise just the label lowercased. The
   `metric` field currently carries no information the label doesn't, but is
   the field a future `source: "usage"` binding would join on.

**Also observed:** the objective is still in **draft**. Whether that is
because the criteria looked wrong, or because activation is a separate step
the owner did not notice, is the next thing worth learning — it is the
difference between a quality problem and a discoverability problem (cf.
O-10).

**Recommended fix.** Reject non-positive targets for `count`/`%` units;
either add a `deadline` criterion type or teach the suggester that dates are
not criteria; constrain `metric` to `^[a-z0-9_]+$` and generate it properly.
Small, and it protects the one invariant the objective model exists to hold.

---

## Open questions this file exists to answer

1. Which insights fire, and are they *right*? (Nothing has fired yet in a
   real workspace — the thresholds are working as designed, staying silent.)
2. What does the owner do repeatedly that the product makes hard?
3. What does the owner do *outside* the Hub that should be inside it?
   (First evidence: O-9 — planning. Objectives are created elsewhere, or not
   at all.)
4. Does "prepared while you were away" become a habit or wallpaper?
   (Untestable until standing work exists in a real workspace — currently
   zero.)
5. **What should happen in the 30 seconds after a result appears?** (O-8.
   Currently nothing, and it is where every session ends.)

## Adoption baselines — 2026-07-24, first honest measurement

The numbers future harvests should be compared against. All fixture-free.

| Measure | Value |
|---|---|
| Real tasks, all time | 15 (14 unattached to any objective) |
| Real completed runs | 11 reviewed · 0 unreviewed |
| Real objectives | 1 created, 1 activated, 1 completed |
| Standing work in real workspaces | 0 |
| Insights fired, all time | 0 |
| Sessions | 6 · median ~6 min · most common exit `run.completed` |
| Pending approvals | 0 |
| Total real spend | $0.26 |
| Time saved (stated baselines, uncalibrated) | 5.3 h |
