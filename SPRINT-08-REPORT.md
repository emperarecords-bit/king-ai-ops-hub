# Sprint 8 Report — "Continuous Operations"

> Prepared for the owner/CEO. Snapshot: 2026-07-24, end of Sprint 8.
> Authorization: Executive Response to Sprint 7 — frame the sprint around
> Continuous Operations, not scheduling; all work stays inside the existing
> approval, budget, audit, and review systems; begin thinking about the layer
> above execution. §8 answers that last request. Prior reports: SPRINT-01…07.

---

## 1. Executive Summary

**What was accomplished.** The company now keeps working while you're away.
Standing work — human-authored recurring assignments attached to objectives —
produces results on a cadence you set, and every one of those results passes
through exactly the same gates as work you initiate by hand: budget preflight,
rate limits, cross-vendor review, the approval queue, the audit chain. Nothing
about the engine, the security model, or the approval gate changed. The
morning briefing gained a "Prepared while you were away" section, so the
overnight output is the first thing you see, already tagged with whether it
needs a decision or is just ready to read.

**The framing you asked for held.** This was not a scheduling feature. The
sprint's real deliverable is a set of *safety properties* that make unattended
operation trustworthy: standing work cannot outlive its author's authority,
cannot stampede after an outage, cannot spend past a budget, cannot execute
anything, and cannot schedule itself. Each of those is enforced in code and
pinned by a test, not asserted in a doc.

**Internal consistency.** The no-autonomous-consequences exclusion in
ROADMAP.md is preserved exactly: schedules are human-authored, and every run
they create still stops at the approval gate. A model never decides what runs
or when.

## 2. Work Delivered

| Item | Detail | Commit |
|---|---|---|
| `task_schedules` schema | Cadence (daily/weekly/monthly), UTC hour, weekday/monthday, next/last run, enabled, author; `tasks.schedule_id` links produced work back to its source | `8565fae` |
| Cadence math | Extracted to a dependency-free module; the invariant "always strictly in the future" pinned by 10 unit tests incl. year-boundary and Feb-28 cases | `8565fae` |
| Schedule lifecycle | Create (admin-only, audited), pause/resume (the kill switch), list by objective; deletion deliberately not offered — history references schedules | `8565fae` |
| The tick | `scripts/run-standing-work.ts`, hourly via Task Scheduler, registered and test-fired (exit 0, logged). Dumb by design: find due, run each once, report | `8565fae` |
| Authority re-check | Each tick verifies the author is still a project admin; if not, the schedule pauses itself with an audit event | `8565fae` |
| Briefing integration | "Prepared while you were away": last-24h standing results with decision state (needs your decision / ready to read / failed) | `8565fae` |
| Objective UI | Standing-work section: create with assignee + cadence + hour, pause/resume, next-due and last-run visibility | `8565fae` |

**Evidence:** 135 unit/integration tests + 3 E2E green; RLS on
`task_schedules` verified by the dynamic every-table check; the scheduled task
registered and fired end-to-end against the real database.

## 3. Deviations and judgment calls

1. **Cadences are daily/weekly/monthly, not cron.** Cron expressions are
   expressive and unreadable; three cadences cover every case a manager
   actually asks for, and each is explainable in the UI in plain words. Cron
   can be added later without a migration if real usage demands it.
2. **Monthday capped at 28.** Eliminates the "what happens on the 31st in
   February" class of bug entirely rather than handling it.
3. **The tick advances the clock before running.** A run that crashes is not
   retried by the scheduler — it appears as a failed run in the briefing and
   waits for the next window. Chosen because silent auto-retry of billable
   work is exactly the behavior an owner should not discover after the fact.
4. **No E2E for standing work.** Its browser surface is a form; its real
   behavior is time-based and covered by integration + unit tests. A
   time-travel E2E would test Playwright, not the product.
5. **`server-only` handling.** The domain layer's server guard blocks plain
   Node scripts. Resolved the way Next itself does — the `react-server`
   condition and the package's own empty module — rather than weakening the
   guard. The production build's protection is unchanged.

## 4. Outstanding Questions (owner)

1. **Sprint 9 direction** — my recommendation is §9 (Management Insights),
   which is the "layer above execution" you asked me to start thinking about.
   Alternatives: K2 knowledge promotion, or Phase 3 executors.
2. **First standing work** — worth defining one this week (§10.3) so the
   briefing has something to prepare; the feature is unexercised by real
   content until then.
3. Carried, defaults safe: PartsHunt Pro unrun · approval expiry 24h ·
   single-owner · local-only · mini-model price verification.

## 5. Technical Debt

| Rank | Item | Type | Status |
|---|---|---|---|
| **Medium** | Nonce-based production CSP (deployment blocker) | Technical | Carried |
| **Medium** | `gpt-5.4-mini` pricing unverified | Product | Carried |
| **Medium** | The tick runs schedules sequentially in one process; a slow run delays the rest of that hour's batch. Fine at current volumes; A1 (job queue) is the real answer | Technical | New |
| **Low** | Standing work has no per-schedule spend visibility (its cost is folded into the workspace total) | Product | New |
| **Low** | Retire `project_context_items` (K2); knowledge E2E; briefing transaction batching; assignee column; funnel events; USER_JOURNEY pointer | Various | Carried |

## 6. Risks

**Product** — *Unattended output nobody reads.* Standing work that produces
results into an empty room is worse than no standing work: it spends budget
and erodes trust in the briefing. Mitigation: the briefing surfaces it first
and tags decision state; the honest test is whether you open those items. If
you don't within two weeks, the right move is fewer schedules, not more.

**Financial** — Recurring spend is the first spend that happens without a
human present. Existing controls hold (budget refuses before the first token;
the briefing shows burn), but the failure mode is new: a daily schedule on
flagship models could quietly consume a workspace's month. Mitigation today:
flagship on standing work requires a stated category like everywhere else,
and cadence + tier are both visible on the objective page. Per-schedule cost
attribution is queued (§5).

**Technical** — The tick is the first code path that runs with no human in
the request. It is deliberately the least clever code in the repo: no
retries, no fan-out, no state beyond `next_run_at`. Sequential execution is
its known scaling limit (§5).

**Security** — One new consideration, addressed: a schedule authored by
someone who later loses access would otherwise keep acting with their
identity. The tick re-checks authority every run and pauses on revocation.
No new execution surface otherwise — standing work proposes, exactly as
manual work does.

## 7. Sprint Review

| Dimension | Score | Reasoning |
|---|---|---|
| Scope | 10/10 | Delivered as Continuous Operations, not scheduling: the safety properties were the product, and the insights analysis (§8) was delivered alongside |
| Quality | 9/10 | Cadence math and scheduling contract both pinned; tick verified end-to-end; −1: no per-schedule cost attribution shipped with a spend-creating feature |
| Completeness | 9/10 | Feature complete and registered; −1: unexercised by real recurring content until the owner defines one |
| Maintainability | 10/10 | The tick is boring by construction; cadence math is pure and isolated; zero engine changes |
| Future scalability | 9/10 | Sequential tick is a known, documented limit with a named answer (A1) |

**Overall: 9.5/10.** The sprint's hardest requirement was restraint: giving
the platform the ability to work unattended without giving it autonomy. The
gates all held, and the code that runs without a human is the simplest code
in the repository.

## 8. The Layer Above Execution (requested analysis — no code shipped)

> "The platform now understands work. The next generation should begin
> understanding the organization itself… management insights rather than
> additional dashboards."

**What separates an insight from a dashboard.** A dashboard answers a
question you thought to ask. An insight arrives unrequested, names something
you didn't know, and implies an action. The Hub is unusually well-positioned
for this because it already records the three things most companies can't
measure: *what work was attempted*, *what a second opinion said about it*,
and *what it cost* — all joined to *what it was for*. No chat tool has that
join. Nothing new needs to be instrumented; the data is already there.

**Five insights the existing data can already produce** (all derivable
today, none requiring new collection):

1. **Cost per outcome.** Spend joined to objectives, not to tokens: "AccurateBids
   beta cost $12.40 and closed four of six criteria; StressPro's objective has
   consumed $31 and closed none." This is the single most executive number the
   platform can produce, and no competitor can produce it at all.
2. **Where review actually earns its keep.** The intervention rate is already
   collected per employee and per workspace. The insight is the *variance*:
   "review changes 40% of Marketing results but 4% of Engineering's — consider
   dropping cross-check on Engineering routine work and saving ~30% of its
   spend." That is a recommendation with a dollar figure attached.
3. **Stalled objectives with reasons.** The Hub knows an objective is active,
   has no work in motion, and hasn't moved in N days — and it knows whether
   the blockage is an unmet criterion, an unapproved action, or simply
   nobody's assignment. "Three objectives are stalled; two are waiting on
   *your* approval" is a management insight, not a status tile.
4. **Knowledge leverage.** With K1 live, runs can be compared with and without
   a given knowledge item in scope. "Runs that consulted the pricing standard
   were revised 60% less often" tells you which knowledge is load-bearing and
   which is decoration — and it's the empirical proof of the compounding claim.
5. **Decision latency.** Time from approval-requested to decided, per
   workspace. If it climbs, the owner has become the bottleneck — the most
   important thing a single-operator company can learn about itself.

**How to deliver them without building more dashboards.** Three principles:
(a) insights are *written into the briefing*, in sentences, ranked by
consequence — not charts on a page you must visit; (b) each carries a
suggested action and a one-click path to take it; (c) each is dismissible,
and dismissals train what gets surfaced. The generation is deterministic SQL
plus templated language — no model needed for the first generation, which
keeps it cheap, explainable, and immune to hallucination. A later version
could use an employee to *write* the weekly narrative from those computed
facts, gated like any other work.

**What this becomes.** The natural end state is a Chief of Staff view: the
platform observing its own organization and telling the owner what a good
operations lead would tell them — where money is going, where quality is
weak, what's stuck and on whom, what the company has learned. That is the
"understanding the organization itself" you're pointing at, and Sprint 9 is
where it starts.

## 9. Recommended Sprint — Sprint 9: "Management Insights"

**Objectives** — implement insights 1, 3, and 5 from §8 (cost per outcome,
stalled objectives with reasons, decision latency); deliver them as ranked
sentences with actions in the briefing; add the insight dismissal loop; add
per-schedule cost attribution (§5) since it feeds insight 1.

**Why these three first:** each is computable from existing data with no new
collection, each names something the owner cannot currently see, and each
implies a specific action. Insights 2 and 4 (review leverage, knowledge
leverage) need more accumulated history to be statistically honest — they
land in Sprint 10 once standing work has produced a few weeks of runs.

**Estimated complexity** — Medium. ~5 sessions (insight computation 2,
briefing presentation + dismissal 1.5, cost attribution 1, tests 0.5).

**Dependencies** — none external. Benefits from real standing work existing
(§4.2).

**Success criteria** — the briefing shows at least one insight the owner
did not already know, stated in a sentence with a dollar or day figure and a
one-click action; every insight is traceable to the query that produced it;
no new page was added to the navigation.

## 10. CEO Briefing (one page)

**1. Where are we now?** Your company works when you don't. Standing work
produces on a cadence you set, and every result lands in the morning briefing
under "Prepared while you were away," already marked as needing a decision or
ready to read. The safety story is the real accomplishment: unattended work
cannot outlive its author's access, cannot stampede after an outage, cannot
overspend, cannot execute anything, and cannot schedule itself. The code that
runs while you sleep is the simplest code in the building.

**2. Biggest remaining challenge?** Making the platform tell you things you
didn't know. Execution is solved; the layer above it — cost per outcome,
what's stuck and on whom, where you have become the bottleneck — is untouched
and entirely computable from data you already have (§8).

**3. What should I personally focus on?** Define one piece of standing work
this week in your busiest workspace — a Monday summary, a weekly review of
something you keep meaning to check. It costs pennies, and it's the only way
to find out whether "prepared while you were away" is a habit or a
distraction. That answer shapes Sprint 9 more than any spec.

**4. Are we ready to continue?** Yes. 135 tests and 3 browser scenarios
green, nothing above Medium debt, and the next sprint is the one you asked
for two sprints ago.

**5. Decisions needed?** One: confirm Sprint 9 = Management Insights as
scoped in §9, or redirect.

---

*Requesting: approval of this report and Sprint 9 confirmation.*
