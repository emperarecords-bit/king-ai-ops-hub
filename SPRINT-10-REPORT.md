# Sprint 10 Report — "Prove It With Real Work"

> Prepared for the owner/CEO. Snapshot: 2026-07-24, end of Sprint 10.
> Authorization: Executive Response to Sprint 9 — validate through sustained
> real use rather than feature expansion; prioritize observing real usage over
> designing future capabilities; every friction point becomes input to the
> next generation. CoS voice decided (event-driven + weekly strategic review,
> relationship-focused) and recorded. Prior: SPRINT-01…09.

---

## 1. Executive Summary

**What was accomplished.** Three deployment blockers closed with evidence, one
observation instrument built, and — the point of the sprint — **the first
real findings harvested from actual usage**, including one product gap that
no test could have caught.

The headline finding: **both objectives you created outside of tests have
zero success criteria**, and one of them completed immediately. The
completion gate — the spine of the objectives model — is vacuous when an
objective has nothing to satisfy. That is a genuine design gap surfaced in a
single day of real use, and it is documented with options rather than
unilaterally fixed, because the right answer depends on what you meant.

**On the sprint's discipline:** no features were added. The only new code is
a read-only diagnostic (`npm run observe`) whose job is to make friction into
evidence. It found a 168× error in its own first output, which is a useful
demonstration of why observation needs the same rigor as product code.

**Chief of Staff mandate updated** per your direction — event-driven with a
guaranteed weekly strategic review, focused on *relationships between facts*
rather than facts. That mandate materially changes its design (§3).

## 2. Work Delivered

| Item | Detail |
|---|---|
| **CSP nonces** (blocker) | Per-request nonce from middleware; production runs `strict-dynamic` with **no** `unsafe-inline`. Verified against a real production build: the nonce in the CSP header matches the nonce in the served HTML, and hydration works — the exact failure mode that silently killed all client JS in Sprint 3, now proven closed. |
| **Pricing verified** (blocker) | Checked against live vendor pages; **two real errors found** (§4.1). Dated test prevents the next one. |
| **Knowledge E2E** (gap) | Add → active → revise → v1 archived not overwritten. 4 browser scenarios now green. |
| **`npm run observe`** | Read-only harvest: where work flows, whether cost tracks outcomes, friction signals, review economics, what the owner actually does. Deliberately a script, not a product surface. |
| **OBSERVATIONS.md** | Five dated findings from the first harvest, each with what was observed, why it matters, and what remains uncertain. |
| **CHIEF-OF-STAFF.md §9** | Voice decided; relationship mandate and its four design consequences recorded. |

## 3. The Chief of Staff mandate change (recorded, not built)

Your framing — *relationships rather than isolated facts; why the
organization behaves as it does; where attention has greatest impact* —
changes the design in four concrete ways, now written into the design doc:

1. The digest must carry **time series**, not current state — a relationship
   needs a "since when."
2. Output ends with **one** recommendation, not a list; "greatest impact" is
   a singular question.
3. **Trend awareness moves up** from a later phase to the substance of the
   role.
4. The grounding check extends: a claimed relationship must name the two
   facts it joins, and the CoS says *"in the same week as"* rather than
   *"because of"* unless the link is structural. Correlation stated as cause
   is the failure mode that would destroy the role's credibility.

## 4. Findings

### 4.1 Pricing was wrong in both directions (now corrected)

| Model | Was | Verified | Effect |
|---|---|---|---|
| `gpt-5.4-mini` | $0.25 / $2.00 | **$0.75 / $4.50** | Under-billed 3× input, 2.25× output |
| `claude-sonnet-5` | $3.00 / $15.00 | **$2.00 / $10.00** (introductory, through Aug 31) | Over-billed 50% |
| `claude-opus-4-8` | $5 / $25 | $5 / $25 | Correct |
| `claude-haiku-4-5` | $1 / $5 | $1 / $5 | Correct |
| `gpt-5.2` | $1.25 / $10 | **delisted** — not on the pricing page | Unverifiable; see §5.1 |

Historical `usage_events` were written with the old rates. They stay as
recorded (immutability) and remain explainable via `pricing_version`; total
affected spend is $0.43, so the distortion is immaterial in absolute terms —
but it would not have stayed immaterial. A dated unit test now fails from
2026-09-01 until Sonnet's introductory pricing is reverted in the table.

### 4.2 The finding that matters: objectives without criteria

Both owner-created objectives have zero success criteria; "general" completed
instantly. Options are laid out in OBSERVATIONS.md O-1: require ≥1 criterion,
allow zero but mark the objective *unverifiable* and exclude it from
completion-based insights, suggest criteria at creation, or leave it. **This
is a product decision and it is yours** — the two readings (UX friction vs.
"objectives are doing two jobs") lead in opposite directions.

### 4.3 Cross-check costs 79–99% of every workspace's spend

Predicted at 60–80% in Sprint 3; the real ratio is worse — reviewers write
long, primaries write short, and Sonnet's output rate is 2.2× the mini's.
Consequence: the review-leverage insight is about to be the most
consequential thing on the briefing, and its thresholds are load-bearing.
Sample sizes are still 1–12 per workspace, so no action yet.

### 4.4 Failure signals never age out

All four failed runs are historical (fixed in Sprint 3) yet still count
toward "needs attention" forever. Signals should decay — a 30-day window on
failure counts is the obvious fix, deferred to Sprint 11 as a real friction
finding rather than a guess.

### 4.5 Test fixtures leak into operational views

Fixture workspaces appear in harvest queries with real-looking pending
approvals. The briefing is safe (it filters by membership), the harvest is
not. Convention + filter, Sprint 11.

## 5. Outstanding Questions (owner)

1. **Flagship model** — `gpt-5.2` is delisted from OpenAI's pricing page
   (still callable on the account, price unverifiable). Move the flagship
   tier to a listed model (`gpt-5.4` at $2.50/$15 is verified) or keep 5.2?
2. **Objectives without criteria** (§4.2) — which of the four options?
3. **The validation period itself.** This report covers *day one*. The real
   deliverable — two weeks of sustained use — has not happened yet: zero
   standing work exists, no insight has fired in a real workspace, and
   `kingdom-core` was created but never used.
4. Carried: PartsHunt Pro has one completed objective but still zero runs ·
   approval expiry 24h · single-owner · local-only.

## 6. Technical Debt

| Rank | Item | Type | Status |
|---|---|---|---|
| **Medium** | Sequential tick and per-workspace briefing transactions (A1 job queue) | Technical | Carried |
| **Low** | Failure signals don't age out (§4.4); fixtures in operational views (§4.5) | Product/Process | New, from real usage |
| **Low** | Insight caching; dismissal loop; `project_context_items` retirement; assignee column; funnel events; USER_JOURNEY pointer | Various | Carried |
| ~~Medium~~ | ~~Nonce CSP~~ · ~~pricing unverified~~ · ~~knowledge E2E~~ | — | **Closed this sprint** |

**Deployment blockers: all closed.** Encryption, git history, backups, first
live run, E2E, and now production CSP. The remaining gate is a decision, not
an engineering task.

## 7. Risks

**Product** — *The validation period may not happen.* This sprint built the
instrument; the evidence still requires you to use the platform for real
work over weeks. Without that, Sprint 11 designs from imagination again —
the exact thing this sprint existed to prevent. The honest risk is that the
Hub is easy to endorse and hard to adopt, and only sustained use distinguishes
those.

**Product** — *Observation could become theater.* A weekly harvest nobody
reads is worse than none. Mitigation: OBSERVATIONS.md entries must state what
is *uncertain*, as O-1 and O-2 do; findings that cannot name their own
ambiguity are usually assumptions wearing evidence's clothes.

**Technical** — The CSP change is the highest-risk edit this sprint (it can
break every page). Verified against a production build in a real browser
rather than trusted. Residual: dev and prod now differ in CSP, so a
CSP-sensitive bug could hide in dev — the E2E suite runs against dev, which
is a known gap worth closing when E2E moves to production builds.

**Financial** — Corrected pricing means future costs read higher for OpenAI
work and lower for Anthropic work than the last few sprints implied. Budgets
unchanged; the numbers are simply true now.

## 8. Sprint Review

| Dimension | Score | Reasoning |
|---|---|---|
| Scope | 9/10 | All blockers closed, instrument built, findings recorded; −1: the sprint's *stated* deliverable (two weeks of real usage) is inherently unfinished |
| Quality | 10/10 | Every blocker closed with verification rather than assertion: CSP proven in a production browser, pricing checked against vendor pages, knowledge proven in E2E |
| Completeness | 8/10 | Day one of a two-week validation; the harvest has one data point |
| Maintainability | 10/10 | Only new code is a read-only diagnostic; the dated pricing test is self-maintaining |
| Future scalability | 9/10 | Findings are already shaping Sprint 11 rather than my assumptions |

**Overall: 9/10.** The sprint did what was asked — stopped building and
started looking — and looking immediately produced a finding worth more than
another feature would have been. The missing point is honest: validation
takes calendar time, and one day has passed.

## 9. Recommended Sprint — Sprint 11: "Let It Run"

**Recommendation: continue the validation period rather than close it.** One
day of data cannot answer the questions Sprint 10 was authorized to answer.
Sprint 11 should be time-boxed by *usage*, not by tasks.

**Objectives**
1. **Sustained real use** — the two weeks that have not happened yet: real
   objectives with criteria, at least one piece of standing work, ordinary
   work routed through the Hub instead of a chat window.
2. **Weekly harvest and record** — `npm run observe` each week; every
   surprise into OBSERVATIONS.md.
3. **Fix what usage exposed, nothing else** — the criteria decision (§5.2),
   failure-signal decay (§4.4), fixture filtering (§4.5). All small.
4. **Nothing new designed** until the observations justify it.

**Estimated complexity** — Low. ~2 engineering sessions plus your ordinary
work.

**Success criteria** — two weeks elapsed with real work in ≥2 workspaces; at
least one insight fires in a real workspace and is judged right or wrong in
writing; standing work produces at least one result that reaches the
briefing; OBSERVATIONS.md holds enough to make CoS-1 a specification instead
of a guess.

## 10. CEO Briefing (one page)

**1. Where are we now?** The platform is deployment-ready — every blocker is
closed, including the production security policy, verified in a real browser
rather than assumed. And it has started telling the truth about itself: one
day of observation found that our token pricing was wrong in both directions
(now corrected against the vendors' own pages), that cross-checking is eating
79–99% of every workspace's spend, and — most importantly — that the
objectives you created have **no success criteria**, which makes the
completion gate you asked for do nothing.

**2. Biggest remaining challenge?** Adoption, measured honestly. The Hub can
execute work, remember, operate unattended, and reason about itself. What it
has not yet done is become where you actually work. That is not an
engineering problem, and no sprint can fake it.

**3. What should I personally focus on?** Two decisions and two weeks. The
decisions: whether objectives should require success criteria, and whether
the flagship tier should move off the delisted GPT-5.2. The two weeks:
genuine work in the Hub — one real objective with real criteria, one piece of
standing work, and the ordinary things you'd otherwise take to a chat window.

**4. Are we ready to continue?** Yes — 142 tests, 4 browser scenarios, no
Medium+ debt outside the known job-queue item, and every deployment blocker
closed. Readiness is no longer the constraint; usage is.

**5. Decisions needed?** Three: (a) objectives without criteria — which
option; (b) flagship model — move to `gpt-5.4` or keep `gpt-5.2`; (c) confirm
Sprint 11 is "let it run" rather than a build sprint.

---

*Requesting: approval of this report and the three decisions in §10.5.*
