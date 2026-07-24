# The Chief of Staff — Design (thinking document, no implementation)

> Requested by the Executive Response to Sprint 8 (2026-07-24): *"begin
> thinking about the role of a virtual Chief of Staff. This is not another
> execution employee. It is an analytical role responsible for synthesizing
> organizational information into executive recommendations."*
> Status: **design only.** Related: [SPRINT-08-REPORT.md](SPRINT-08-REPORT.md)
> §8, `src/domain/insights/insights.ts` (Sprint 9), TEAM.md, AGENT_CATALOG.md,
> D-012 (departments), D-015 (workforce model).

## 1. What the role is — and what it must never become

The Chief of Staff (CoS) **observes the organization and advises the owner.**
It does not do the company's work, does not manage employees, and does not
decide anything. Its output is a recommendation with reasoning attached; the
owner remains the only decision-maker (TEAM.md's first rule, unchanged).

| The CoS is | The CoS is not |
|---|---|
| An analytical role in Operations | Another execution employee |
| A synthesizer of computed facts | A source of new facts |
| Advisory: every output is a recommendation | Authoritative: it approves nothing |
| Read-only over the organization's own records | A writer to knowledge, objectives, or work |

**The line that must hold:** the CoS may *say* "consider pausing the daily
competitive summary — it has cost $18 and nothing it produced was ever
opened." It may never pause it. Every recommendation terminates in a link the
owner clicks, exactly like a model-proposed action terminates in an approval.

## 2. Why it is a different kind of agent

Every existing employee (AGENT_CATALOG) takes a *task* and produces *work*.
The CoS takes the *organization's state* and produces *judgment about the
organization*. That difference has three consequences:

1. **Its input is aggregate, never content.** It reads computed metrics —
   counts, costs, rates, ages — not the text of tasks, messages, or
   knowledge. This is a deliberate isolation choice (§5).
2. **It is scheduled, not assigned.** It runs weekly on the existing standing-
   work machinery, not from a task form.
3. **It cannot be reviewed the usual way.** Cross-vendor review of an opinion
   about your company is theater. Its integrity comes from determinism of its
   inputs instead (§4).

## 3. The layered architecture (deterministic floor, model ceiling)

```
Layer 3  NARRATIVE      "Here's what I'd tell you if I ran ops for you."
  (model)               Weekly synthesis: themes, trade-offs, one recommendation.
     ▲                  Untrusted output, rendered as text, always labeled.
     │  consumes ONLY layer 2 — never raw records
Layer 2  INSIGHTS       Composite findings with severity, action, evidence.
  (deterministic)       SHIPPED in Sprint 9: src/domain/insights.
     ▲
     │  computed from
Layer 1  FACTS          Costs, verdicts, criteria, latencies, cadences.
  (the database)        Already recorded; nothing new to instrument.
```

**The load-bearing rule: the model never adds facts.** Layer 3 receives a
structured digest from layer 2 and may only *arrange, prioritize, and
explain* it. Any figure appearing in the narrative must exist in the digest —
this is checkable, and §4 makes it enforced rather than hoped for.

This layering is why the CoS can be trusted with an executive voice: the
facts are deterministic and traceable (Sprint 9's evidence blocks), and only
the *prose* is generated.

## 4. Trustworthiness controls

1. **Grounding check.** Every number in the narrative is extracted and matched
   against the digest. An unmatched figure means the narrative is discarded
   and the deterministic insights are shown alone. (Same posture as malformed
   action proposals: degrade to the safe thing, audit the failure.)
2. **Determinism where practical.** Layer 2 already produces identical
   sentences for identical data — tested. Layer 3 runs at a low temperature
   with a fixed digest, and both digest and narrative are stored, so any past
   recommendation can be reproduced and audited.
3. **Never a silent voice.** CoS output is visually distinct and labeled as a
   recommendation from an analytical employee, never presented as platform
   fact.
4. **Cost bounded.** One run per workspace per week on the standard tier;
   its spend appears in the same budget as everything else. If the CoS costs
   more than it saves, that is visible in the insight it inspired.
5. **No new authority.** It reads through the ordinary tenant path with a
   read-only context; it holds no approval rights and appears in no approval
   flow as a decider.

## 5. Isolation posture (I1 under a genuinely new pressure)

The CoS is the first role that would benefit from seeing *across* workspaces —
"Engineering's review rate is healthy in AccurateBids but poor in KodiScan"
is a real insight. That temptation is exactly what I1 exists to resist.

**Recommendation: per-workspace CoS by default.** One CoS run per workspace,
reading only that workspace, exactly like every other employee. A
cross-workspace "portfolio view" is possible *only* over the aggregate metric
layer (numbers, never content) and should require an explicit, audited owner
opt-in per workspace — the same shape as KNOWLEDGE-DESIGN's org-scope
exception (K4). Do not build the portfolio view first; earn it after the
single-workspace version proves useful.

## 6. What it would say (worked example)

Given a real digest, a weekly CoS note would read something like:

> **This week in AccurateBids.** The objective "Ship the beta" is the only
> one moving: three of six criteria closed for $14.20, which is roughly half
> the per-criterion cost of "Grow the pipeline." That gap is worth copying —
> the beta work runs against a knowledge base with pricing standards; the
> pipeline work does not.
>
> Two things are stuck on you: a file-write proposal from Tuesday and a
> deployment proposal from Wednesday, both expiring within a day. Neither
> objective can advance until they're decided.
>
> One thing to consider dropping: the daily competitive summary has produced
> seven results this month for $6.40, and none has been opened. Either act on
> it weekly instead of daily, or retire it.
>
> *Recommendation: decide the two pending approvals, then move the
> competitive summary to weekly.*

Note what it does not do: it does not decide, it does not touch anything, and
every figure in it traces to a Sprint 9 insight's evidence block.

## 7. Where it lives in the organization

A **Chief of Staff** employee in the **Operations** department (D-012), with
a catalog entry (AGENT_CATALOG) declaring: read-only permissions over
aggregate metrics, no execute, no approve, escalation = "surface to owner,"
and the explicit note that it is analytical, not executive. It should be the
first employee whose card shows *zero* work produced and still earns its
keep — a useful test of whether the workforce model can hold non-execution
roles.

## 8. Phasing

| Phase | Contents | Prerequisite |
|---|---|---|
| CoS-1 | Weekly narrative from the Sprint 9 digest, per workspace, on standing work; grounding check; stored digest + narrative | Sprint 9 insights (done) + a few weeks of real data |
| CoS-2 | Recommendation follow-through: did the owner act? Feeds which insights are worth surfacing | CoS-1 |
| CoS-3 | Trend awareness: "review interventions have doubled since the pricing standard was archived" — insight over *time*, not state | ≥1 quarter of history |
| CoS-4 | Opt-in portfolio view over aggregate metrics only, audited per workspace | Explicit owner decision |

**Not before real usage.** CoS-1 should not be built until standing work and
insights have produced enough history that its first note says something the
owner did not already know. Building it earlier produces a confident essay
about six data points — the exact failure mode that would destroy trust in
the role permanently.

## 9. The open question for the owner

**Does the CoS speak weekly, or only when it has something worth saying?**
A fixed weekly note builds a ritual but risks filler; an event-driven note
("something changed that you should know about") preserves signal but may go
quiet for weeks. My recommendation is *event-driven with a weekly floor*: it
speaks when the insight layer produces something new, and at minimum
summarizes the week even if the summary is "nothing changed, here's where the
money went." That decision shapes CoS-1's shape and is worth making before it
is built, not after.
