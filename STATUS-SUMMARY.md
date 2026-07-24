# King AI Operations Hub — Status Summary

> A plain-language snapshot for people outside the build: project managers,
> advisors, anyone who needs the state of things without the sprint history.
> Update at each sprint boundary. Approved by the owner 2026-07-24.
>
> Detail lives elsewhere: [SPRINT-11-REPORT.md](SPRINT-11-REPORT.md) (current
> sprint) · [OBSERVATIONS.md](OBSERVATIONS.md) (what real usage shows) ·
> [ROADMAP.md](ROADMAP.md) · [DECISIONS.md](DECISIONS.md).

**As of 24 July 2026.**

## What it is

An internally-built platform for delegating work to AI models (OpenAI and
Anthropic) across six isolated project workspaces. Its distinguishing feature:
two rival AI vendors cross-check each other's work, and no AI-proposed action
reaches the real world without explicit human approval. Everything is
cost-metered and recorded in a tamper-evident audit trail.

## Current status: built and working; adoption not yet proven

Eleven sprints delivered. The platform runs end-to-end in daily-use condition:
sign-in, workspace isolation, task execution across both vendors, cross-vendor
review, company knowledge that every AI consults before starting work,
recurring "standing work" that runs unattended, a morning executive briefing,
and a management-insights layer. Quality gates are green — 157 automated tests
plus browser-level end-to-end coverage. All pre-deployment security blockers
are closed (nonce-based content security policy, automated nightly backups
with a verified restore drill, encrypted secrets, full version history).

Total real usage to date: **15 tasks, 11 completed runs, $0.44 of AI spend.**
The engineering is ahead of the adoption, which is the current focus.

## Recent work: validation rather than features

The last sprint instrumented the platform to observe its own usage instead of
adding capability. That immediately produced findings:

- **The measurement system was wrong.** Test data had contaminated the
  operational reports — earlier figures ("44 objectives created", "6 approvals
  pending") were measuring the test suite, not real work. Fixed structurally;
  the true numbers are far smaller and now trustworthy.
- **Usage pattern identified.** Sessions are short, and the most common way
  they end is immediately after a result appears — the platform is currently
  used like a chat tool: run one task, take the answer, leave. Most of what
  was built (objectives, briefing, insights) sits past the point where users
  stop.
- **A real defect surfaced through use.** The AI-generated "success criteria"
  feature produced unmeasurable output (three of four criteria had a target of
  zero, and a deadline was silently corrupted). Root cause was a contradiction
  between the instruction given to the model and the data schema. Fixed,
  verified live, and covered by regression tests.

## The measure that now guides the roadmap

Per owner direction (2026-07-24), behavioral continuation outranks task counts
and API usage as the primary metric. The question driving the next stage is
not "what capability is missing" but **"how does finishing one task become the
start of the next workflow?"**

First baseline, 24 July 2026:

| Measure | Value |
|---|---|
| Sessions recorded | 7 |
| **Finished their work inside the Hub** | **1 (14%)** |
| Left at a delivered result | 3 (43%) |
| Session length | median 0.3 min · average 8.4 min |
| Actions per session | 7.3 |
| Follow-up actions accepted | *not measurable — none are offered yet* |

## Open decisions

1. Whether a sustained two-week real-usage period is realistic; if not, the
   validation approach should be restructured rather than continue reporting
   near-zero usage.
2. Calibration of the "time saved" baseline assumptions before that figure is
   quoted anywhere externally (currently 5.3 hours, computed from stated
   assumptions rather than measurement).

## Principal risk

Not technical. The platform works; what is unproven is whether it becomes the
default place work happens rather than a tool opened occasionally. Every
remaining roadmap item is gated on evidence from real use.

## Next milestone

Validation continues. The two highest-value candidates identified from
observed behavior:

1. Make the moment *after* a result appears lead somewhere, rather than ending
   the session.
2. Improve discoverability of capabilities that already exist but are not
   being found — one shipped feature went unnoticed long enough for a defect
   in it to survive undetected.
