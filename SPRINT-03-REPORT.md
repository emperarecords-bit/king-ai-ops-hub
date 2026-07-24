# Sprint 3 Report — "Prove It Live"

> Prepared for the owner/CEO. Snapshot: 2026-07-24, end of Sprint 3.
> Prior reports: [SPRINT-01-REPORT.md](SPRINT-01-REPORT.md) (engineering
> foundation), [SPRINT-02-REPORT.md](SPRINT-02-REPORT.md) (product
> foundation). Plan of record: [SPRINT-03-PLAN.md](SPRINT-03-PLAN.md)
> (approved 2026-07-23), amended mid-sprint by the Executive Product
> Direction Update → [DESIGN-REVIEW-WORKFORCE.md](DESIGN-REVIEW-WORKFORCE.md)
> (approved, recorded as D-015).

---

## 1. Executive Summary

**What was accomplished.** Sprint 3 took the platform from "tested but never
run" to **proven in live production use by its owner and observable while it
works**. The first real cross-provider run executed end to end — and earned
its keep by flushing out four genuine defects that only live traffic could
find (a nonexistent model name, quota errors masked as rate limits, a 5×
billing over-count on dated model names, and a CSP that had silently disabled
every line of client-side JavaScript). All four were fixed, tested, and
committed the same day. Around that proof, the sprint delivered: automated
verified backups (M0), the approved budgets and two-tier model routing (M1),
structured review verdicts and live SSE streaming (M2), the golden-transcript
suite plus debt burn-down (M3), and the workforce dark schema with the
onboarding specification (M4). The mid-sprint executive pivot to an AI
Workforce platform was absorbed with a design review and two plan
adjustments — zero rework of completed work.

**Overall assessment.** The platform now has the three properties that
matter at this stage: it *works* (live, both vendors, real money metered to
the micro), it *shows its work* (streaming, verdict panels, the
review-value metric), and it *cannot silently regress* (103 tests including
byte-for-byte golden pins and a dynamic every-table RLS check). Repository
history is clean: 13 commits, each gate-green.

**Internal consistency.** All Sprint 3 changes are reflected in the
documentation set; the five outstanding doc discrepancies from Sprints 1–2
were fixed this sprint. New documents (design review, onboarding spec) are
cross-referenced and use the decided vocabulary. No new contradictions found.

## 2. Work Delivered (by milestone)

| Milestone | Delivered | Commits |
|---|---|---|
| **M0 — Operational safety** | Nightly 03:00 `pg_dump` via Task Scheduler → local + OneDrive, 30-day retention; restore drill proven (all core tables verified in a throwaway container); pre-migration safety dumps (fired 3× for real this sprint) | `f81c231` |
| **M1 — Prove it live** | Approved budgets applied ($100/$100/$40/$30/$30/$30); sixth `king-ai-ops-hub` dogfood workspace; D-014 two-tier routing (standard = mini/Sonnet, flagship = GPT-5.2/Opus 4.8) with audited category attribution; flagship toggle on the task form; **first live cross-provider run green** (verdict: approve, 11.2s total) | `28c3872`, `244e474`, `2a9bdc7`, `ee622ef`, `dcf45d5` |
| **M2 — Observable review** | Structured verdicts (severity-tagged issues, Zod-validated, stored in `run_steps.verdict_detail`); Review panel on task detail; review-value card on Usage (the differentiator metric); `stream()` on both adapters; SSE run streaming with live per-step output; no-retry-after-partial-output rule | `5907216`, `8f05f6a` |
| **M3 — Pin & polish** | Golden-transcript suite (8 transcripts, 2 verbatim from live runs, byte-for-byte snapshot pins); email-relink fix + real-DB regression test; **CSP hydration fix**; login segmented Sign in / Create account; five doc one-liners | `c01726e`, `f3cc99b` |
| **M4 — Dark foundations** | Migration 0003: `departments` table (per D-015; 8 seeded, all 24 employees assigned), `objectives` with success-criteria gating, `milestones`, task attachment FKs; RLS on everything; dynamic every-public-table RLS test; [ONBOARDING.md](ONBOARDING.md) 15-minute journey spec in workforce vocabulary | `21a9776`, `b4f902d` |

**Mid-sprint executive item:** Workforce direction reviewed
([DESIGN-REVIEW-WORKFORCE.md](DESIGN-REVIEW-WORKFORCE.md)), approved,
recorded as **D-015** with the assignment-dimension correction accepted; plan
amended exactly as the review recommended (departments as table; onboarding
in workforce vocabulary).

## 3. Evidence Pack (decision #3 verification checklist)

Live database state at report time:

| Check | Evidence |
|---|---|
| Authentication | Owner account (`emperarecords@hotmail.com`) created via the app; every run in history attributed to it |
| Workspace isolation | RLS on **every** public table (dynamic check returns zero exceptions); cross-tenant read tests green; all records correctly scoped |
| Provider communication | Both vendors live: GPT-5.4 mini primary (0.9s), Claude Sonnet 5 reviewer (10.3s); 3 completed runs |
| Review workflow | Cross-vendor review executed with structured `approve` verdicts; graceful degradation proven when a reviewer failed mid-run |
| Cost tracking | 5 usage events, **$0.0346 total**, exact to the micro (Anthropic verified against hand-computed rates; OpenAI over-count found this way and fixed) |
| Usage tracking | Per-step tokens recorded with pricing version; review-value metric computes from live data |
| Audit log | Hash chain verified: **23 rows, 0 broken links** |
| Honest failure record | 4 failed runs preserved immutably — the diagnostic trail of the four live-found defects |

The four defects found by going live, in order: `gpt-5.2-mini` does not exist
(the memo's name; OpenAI versions minis separately) → `gpt-5.4-mini`
verified against the account's live model list; OpenAI `insufficient_quota`
arrives as HTTP 429 and was mislabeled a retryable rate limit; Claude 5
models reject the `temperature` parameter (adapter now adapts and remembers);
OpenAI echoes dated snapshot names, falling through to the expensive pricing
fallback (5× over-count — fixed with date-suffix-only prefix matching, which
also guards the inverse under-billing hole).

**The fifth find — the most important:** the strict CSP (`script-src 'self'`)
was blocking Next.js's inline hydration bootstrap. **All client-side
JavaScript had been dead since day one** — every interaction to date had
silently ridden on no-JS form fallbacks. Found because the M3 login toggle
was the first JS-required feature verified in-browser. Dev CSP fixed and
hydration verified live; nonce-based production CSP added to the deployment
blockers. Lesson recorded in §7 (Process).

## 4. Recommended Architecture Changes (not implemented)

| # | Recommendation | Why | Risk | Sprint |
|---|---|---|---|---|
| A1 (carried) | Background job queue for runs | Still the right pre-multi-user move; SSE made it less urgent for UX | Medium | Sprint 5+ |
| A5 (carried) | Approval-expiry sweep | Queue counts remain lazily truthful | Low | Sprint 4 (small) |
| A7 (carried) | `rate_limit_buckets` pruning | Hygiene | Low | Sprint 4 (small) |
| A10 (new) | **Nonce-based production CSP** | The dev CSP now allows inline scripts; production must not — this is a hard deployment blocker | Low (config + middleware nonce) | Before any deployment |
| A11 (new) | **In-browser E2E verification step in the quality gate** | The CSP bug proves server-green ≠ client-working; the gate never exercised a hydrated page | Low | Sprint 4, with E2E credentials |

## 5. Outstanding Questions (owner decisions)

1. **E2E credentials** — create a dedicated test login (via the app's Create
   account tab) and provide as `E2E_EMAIL`/`E2E_PASSWORD` in `.env.local`, or
   defer the Playwright gate to Sprint 4? (I cannot create accounts.)
2. **Per-workspace smoke runs** — option A (run the 2-minute smoke in each of
   the five remaining workspaces) remains open; option B (accept
   single-workspace proof + isolation tests) was the working assumption.
3. Carried, still safe to defer: approval expiry (24h stands), multi-user
   (no), deployment (local; now 3 of 6 blockers closed — git, encryption,
   backups; open: E2E, nonce CSP, first-live-run ✅ closed this sprint),
   backup *restore drill cadence* (monthly recommended; first drill passed).

## 6. Technical Debt

| Rank | Item | Type | Status |
|---|---|---|---|
| **High** | E2E suite still never run end-to-end (blocked on credentials decision, §5.1) | Process | Open |
| **High** | Production CSP needs nonces before deployment (A10) | Technical | New, scheduled |
| **Medium** | `gpt-5.4-mini` priced at the carried gpt-5-mini rate — verify against the vendor pricing page | Product | Open (one lookup) |
| **Medium** | Approval expiry lazy (A5); bucket pruning (A7) | Technical | Carried |
| **Low** | Old placeholder profile (`owner@example.com`) still holds parallel memberships in the five original workspaces — harmless, cleanable | Technical | New |
| **Low** | `USER_JOURNEY.md` partially superseded by ONBOARDING.md — needs a deprecation pointer | Documentation | New |
| ~~Critical~~ | ~~Encryption key, no git history~~ | — | **Closed Sprint 3** |
| ~~High~~ | ~~First live run, relink bug, sync-run streaming UX~~ | — | **Closed Sprint 3** |

## 7. Risks and Mitigations

**Technical.** *Verified-in-server-land-only* was this sprint's realized
risk (CSP): mitigation now structural — A11 puts a hydrated-browser check
into the gate. *Vendor drift* proved real three times (model names,
temperature deprecation, quota semantics); all three fixes follow the same
pattern — adapt inside the adapter, never in domain code — which is exactly
what the adapter layer is for. Residual: pricing accuracy (§6 Medium).

**Product.** The workforce pivot landed mid-sprint without rework — but two
pivots in two sprints is a cadence to watch: each was absorbed cheaply
*because* the docs and decision log made current state legible. Keep pivots
flowing through design reviews (as this one did) and the cost stays low.

**Security.** No new surface: streaming is observational (a dead listener
cannot corrupt a run), verdict detail is Zod-fenced like actions, the
dynamic RLS test closes T1's residual risk permanently. The CSP loosening is
dev-only and its production requirement is a named blocker.

**Business/Scalability.** Unchanged from Sprint 2. Total platform spend to
date: $0.03 — budgets are effectively untested under pressure; the $30–100
caps will first bind under real workloads (watch the Usage screen's
review-cost share, per the plan's §2.2 economics caution).

## 8. Sprint Review

| Dimension | Score | Reasoning |
|---|---|---|
| Scope | 10/10 | All five milestones + an unplanned executive design review + D-015; two plan amendments executed as approved |
| Quality | 9/10 | Every commit gate-green; live defects fixed with tests the same day; −1: E2E remains unexercised (§5.1) |
| Completeness | 9/10 | Exit criteria met except "E2E green with real credentials" (blocked on an owner decision) and per-workspace runs (option B assumed) |
| Maintainability | 10/10 | Golden pins + dynamic RLS check + 13 documented commits; the codebase now defends its own behavior |
| Future scalability | 9/10 | Dark schema makes Sprint 4 pure product work; streaming/queue seam (A1) still ahead |

**Overall: 9/10.** The sprint did the one thing that separates a promising
codebase from a real system: it met production, got punched in the face four
times (five, counting CSP), and came back with every lesson converted into a
test or an adapter behavior. The missing point is the still-unexercised E2E
gate — the exact class of gap that let the CSP bug live this long.

## 9. Recommended Sprint — Sprint 4: "Objectives in Daylight"

**Objectives**
1. Turn the dark schema on: Objectives UI (create, success criteria, attach
   tasks, verified completion rollup) following ONBOARDING.md's framing.
2. First slice of workforce presentation where it's free: employee cards on
   Agent Settings (department badges, per-employee review/cost stats).
3. Close the verification gap: E2E green in the gate (pending §5.1), A11
   hydrated-browser check, A5 + A7 small fixes.

**Deliverables** — Objective/milestone screens with completion gating and
audited criteria changes; task form's objective attachment; dashboard
objective summary; employee cards with derived metrics; E2E suite in
`verify`; approval-expiry sweep; bucket pruning; `USER_JOURNEY.md`
deprecation pointer; SPRINT-04 report.

**Estimated complexity** — Medium. ~6 focused sessions (Objectives UI 3,
employee cards 1, E2E + gate 1, small debt 1).

**Dependencies** — Owner: §5.1 (E2E credentials) and §5.2 (smoke option);
both decidable in minutes. Nothing external.

**Success criteria** — An objective with success criteria exists in a real
workspace with tasks attached and rolls up honestly (cannot complete with an
unmet criterion); employee cards show real review/cost numbers; `npm run
verify` includes a hydrated-browser E2E pass; no High debt remains except
production-CSP (deployment-gated by design).

## 10. CEO Briefing (one page)

**1. Where are we now?**
The platform is no longer a promise — you've used it. Your own account ran
real work through both AI vendors; you watched one review the other, the
bill came to three cents metered to six decimal places, and the audit chain
holds 23 tamper-evident records including every failure. The sprint's four
live-found defects are its proudest output: each one is now a test that can
never regress. Meanwhile the workforce pivot you and the CTO set landed
without breaking stride — the schema beneath it (departments, objectives,
success criteria) is already live and protected, waiting for its UI.

**2. What is the biggest remaining challenge?**
Near-term: the last verification gap — the browser-level E2E suite that
would have caught this sprint's sneakiest bug (all client JavaScript
silently dead behind a security header). It's blocked on a two-minute
decision only you can make (§5.1). Long-term: unchanged — Phase 3 executors.

**3. What should I personally focus on next?**
Three small things: (a) run one task anywhere and enjoy the streaming +
review panel — it's a different product now; (b) create the E2E test login
and drop its credentials in `.env.local` (or tell me to defer); (c) approve
Sprint 4 as scoped in §9.

**4. Are we ready to continue development?**
Yes, with the cleanest slate yet: no Critical debt, one High item that's
yours to unblock, gates green, and the next sprint is pure product work on
rails the schema already laid.

**5. What decisions do you need from me before Sprint 4?**
Only §5.1 (E2E credentials: provide or defer) and §5.2 (per-workspace
smokes: run or accept). Everything else keeps its stated default safely.

---

*Requesting: approval of this report, answers to §5.1–5.2, and go/no-go on
Sprint 4 as scoped in §9.*
