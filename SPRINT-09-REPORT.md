# Sprint 9 Report — "Management Insights"

> Prepared for the owner/CEO. Snapshot: 2026-07-24, end of Sprint 9.
> Authorization: Executive Response to Sprint 8 — distinguish activity from
> organizational progress; favor multi-dimensional insights that identify
> leverage; keep them explainable, deterministic where practical, and
> traceable; begin thinking about the Chief of Staff. Prior: SPRINT-01…08.

---

## 1. Executive Summary

**What was accomplished.** The briefing now tells you what matters, not what
happened. Five composite insights compute from data the platform already
records and appear as ranked sentences under "What matters" — each combining
at least two dimensions, each carrying a suggested action, a one-click link,
and an expandable **"Why this says that"** block containing the exact numbers
behind the claim. No new page was added to the navigation, and no model is
involved: every insight is deterministic SQL plus templated language, so it
cannot hallucinate and says the same thing about the same data every time.

**Your distinction drove the design.** "12 runs completed" is activity and
stayed on the stat cards. "This objective consumed $10 across 2 tasks without
closing any of its 2 criteria" is progress — money joined to outcomes — and
that is what the insight layer produces. A single-dimension counter is not
allowed into the insight list by construction.

**Also delivered:** the Chief of Staff design document you asked me to start
thinking about ([CHIEF-OF-STAFF.md](CHIEF-OF-STAFF.md)) — including the
layering that keeps it trustworthy and one open question that should be
answered before it is built.

## 2. Work Delivered

| Insight | Dimensions combined | What it names | Severity |
|---|---|---|---|
| **Cost without progress** | money × criteria closed × task count | An objective consuming budget while closing nothing | critical |
| **Cost divergence** | money × criteria × comparison across objectives | One objective costing 3×+ more per criterion closed than another — and points at the cheaper one as the model | attention |
| **Stalled: waiting on you** | objective progress × decision state | The owner is the blocker, with the count of decisions holding it | critical |
| **Stalled: unassigned** | objective progress × work in motion × standing work | Genuinely abandoned work, with idle days and whether anything recurring exists | attention |
| **Decision latency** | time × wasted spend | Approvals that expired undecided (work bought and thrown away), aging queues, and the positive case when the owner is *not* the bottleneck | critical / attention / positive |
| **Review leverage** | quality × share of spend | Cross-check that is not earning its keep (and what it costs), or is catching so much it points at missing knowledge | opportunity / attention |
| **Standing work value** | production × decision behavior × cost | Unattended output nobody acts on — pure cost | opportunity |

| Supporting work | Detail |
|---|---|
| Briefing presentation | "What matters" section, ranked by consequence across all workspaces, capped at six so a briefing stays a briefing |
| Traceability | Every insight renders its evidence under "Why this says that" — the figures, not a re-statement |
| Per-schedule cost attribution | Standing work now shows what it produced and what it cost (closes Sprint 8 debt) |
| Chief of Staff design | Three-layer architecture, trust controls, isolation posture, phasing, worked example |

**Evidence:** 141 unit/integration tests + 3 E2E green; 6 new integration
tests pin the properties that matter most — **a quiet workspace produces no
insights** (no noise manufacturing), output is byte-identical across repeated
runs (determinism), ranking is by consequence, and every insight carries
action + link + evidence.

## 3. Deviations and judgment calls

1. **No dismissal loop shipped.** Sprint 8's plan included dismissals. With
   only a handful of insights and thresholds tuned to stay silent, dismissal
   would be machinery for a problem that does not exist yet. Revisit when the
   briefing regularly shows more than it should.
2. **Thresholds are conservative on purpose.** Review leverage needs ≥5
   reviews before it claims anything; standing-work value needs ≥3 results
   and ≥2 ignored; cost divergence needs a 3× gap. An insight that fires on
   thin data is worse than silence — it teaches the owner to distrust the
   section.
3. **Insights are computed per request, not cached.** Five small aggregate
   queries per workspace on a page you open a few times a day. Caching would
   add invalidation complexity for no measurable gain; noted as a scaling
   item, not built.
4. **Two SQL faults found and fixed during the sprint** (both caught by the
   new tests): a correlated subquery mixing an aggregate with `array_agg`,
   and Drizzle rendering column references unqualified inside raw SQL, which
   made them ambiguous. Both are exactly the class of bug the "same data,
   same sentence" determinism test exists to catch.

## 4. Outstanding Questions (owner)

1. **The Chief of Staff's voice** (CHIEF-OF-STAFF.md §9): weekly note, or
   event-driven when something changed? My recommendation is event-driven
   with a weekly floor. Worth deciding before it is built.
2. **Sprint 10 direction** — my recommendation is §8. Alternatives: CoS-1
   (needs more history first), K2 knowledge promotion, Phase 3 executors.
3. **Real data is now the constraint.** The insight layer is honest enough to
   stay quiet with thin history — which means its value is unproven until
   there is real work in real workspaces (standing work included).
4. Carried, defaults safe: PartsHunt Pro unrun · approval expiry 24h ·
   single-owner · local-only · mini-model price verification.

## 5. Technical Debt

| Rank | Item | Type | Status |
|---|---|---|---|
| **Medium** | Nonce-based production CSP (deployment blocker) | Technical | Carried |
| **Medium** | `gpt-5.4-mini` pricing unverified | Product | Carried |
| **Medium** | Sequential tick; sequential per-workspace briefing transactions — both want A1 (job queue) at scale | Technical | Carried |
| **Low** | Insight computation uncached; no dismissal loop | Technical/Product | New |
| **Low** | Retire `project_context_items` (K2); knowledge E2E; assignee column; funnel events; USER_JOURNEY pointer | Various | Carried |
| ~~Medium~~ | ~~Per-schedule cost attribution~~ | — | **Closed this sprint** |

## 6. Risks

**Product** — *The credibility cliff.* An insight section is trusted
completely or not at all; one confidently wrong sentence costs more than ten
useful ones earn. Mitigations in place: conservative thresholds, silence on
thin data, and evidence attached to every claim so a suspicious owner can
check the math in two clicks. The residual risk is *stale framing* — a
threshold that made sense at $30/month budgets misfiring at $300. Revisit
thresholds when spend scales.

**Product** — *Insight fatigue* is the opposite failure: if the section is
always six items long, it becomes wallpaper. The cap is a symptom-treatment;
the real control is that most insights require genuinely unusual conditions
to fire.

**Technical** — No new write paths, no engine changes, no new dependencies.
The two SQL faults found this sprint argue for the same discipline going
forward: every insight ships with a test that runs its query against real
Postgres.

**Security** — Insights read aggregates through the ordinary tenant path;
the briefing aggregates *numbers* across workspaces but no insight ever
carries content from one workspace into another's sentence. The CoS design
addresses the sharper version of this pressure before any code exists
(CHIEF-OF-STAFF §5).

## 7. Sprint Review

| Dimension | Score | Reasoning |
|---|---|---|
| Scope | 10/10 | All three planned insights plus two more (review leverage, standing-work value), the cost-attribution debt, and the CoS design |
| Quality | 9/10 | Determinism and silence-on-thin-data both tested; two real SQL faults caught by those tests before shipping; −1: the faults existed at all |
| Completeness | 9/10 | −1: dismissal loop deliberately deferred; value unproven until real data accumulates |
| Maintainability | 10/10 | Pure read layer, one module, each insight independently testable and removable |
| Future scalability | 9/10 | Layer 2 is exactly the digest the Chief of Staff will consume — Sprint 9 built CoS's foundation without building CoS |

**Overall: 9.5/10.** The sprint's discipline was refusing to report activity.
Every insight that survived combines dimensions and implies an action; the
ones that would have been counters were left on the stat cards where they
belong.

## 8. Recommended Sprint — Sprint 10: "Prove It With Real Work"

**The honest recommendation is not another feature sprint.** The platform now
has: objectives with gated completion, a workforce, knowledge, continuous
operations, a briefing, and an insight layer. What it does not have is a
month of real work flowing through it. Every remaining roadmap item —
Chief of Staff, review-leverage insights, knowledge-leverage measurement,
trend analysis — is *better designed after* watching real usage, and several
are actively harmful if built on six data points.

**Sprint 10 objectives**
1. **Instrument the owner's real usage.** Two or three genuine objectives with
   real success criteria in the two busiest workspaces; standing work on at
   least one; the owner's normal work routed through the Hub for two weeks.
2. **Harvest what the data says.** Weekly: which insights fired, which were
   right, which were noise, what the owner wished it had said. That is
   CoS-1's requirements document, written by reality.
3. **Fix what real usage exposes** — bounded scope, whatever surfaces.
4. **Close the deployment blockers** while data accumulates: nonce-based CSP,
   mini-model pricing verification, knowledge E2E. Cheap, unblocking, and
   they need no new design.

**Estimated complexity** — Low-Medium; deliberately. ~3 sessions of
engineering plus the owner's ordinary work.

**Success criteria** — two weeks of real usage in at least two workspaces;
a written record of which insights proved true; all deployment blockers
closed; and a CoS-1 spec informed by evidence rather than imagination.

## 9. CEO Briefing (one page)

**1. Where are we now?** Your briefing tells you what matters. Not "12 runs
completed" — "this objective has consumed $10 and closed nothing," "two
decisions are blocking that objective," "this recurring report has cost $6
and nobody has opened it." Every sentence combines money, quality, progress,
or time; every one carries an action and shows its arithmetic on demand; and
none of it involves a model, so it cannot invent a number. When a workspace
is healthy and quiet, the section says nothing at all — which is the property
that will make you trust it.

**2. Biggest remaining challenge?** Real data. The insight layer is
deliberately honest enough to stay silent on thin history, which means its
value is *unproven* until real work flows through the Hub for a few weeks.
That is also the prerequisite for the Chief of Staff — building it on six
data points would produce a confident essay about nothing and permanently
cost the role its credibility.

**3. What should I personally focus on?** Use it for real, for two weeks.
Two or three genuine objectives with honest success criteria, one piece of
standing work, and your normal work routed through the Hub instead of a chat
window. Then tell me which insights were right, which were noise, and what
you wished it had said. That is worth more than any spec I could write.

**4. Are we ready to continue?** Yes — 141 tests and 3 browser scenarios
green, nothing above Medium debt, and the next sprint is deliberately light
on engineering so the platform can be proven rather than extended.

**5. Decisions needed?** Two: (a) the Chief of Staff's voice — weekly note or
event-driven with a weekly floor (my recommendation); (b) confirm Sprint 10 =
prove-it-with-real-work plus deployment-blocker cleanup, or redirect to
another build sprint.

---

*Requesting: approval of this report, a decision on the CoS voice, and
Sprint 10 direction.*
