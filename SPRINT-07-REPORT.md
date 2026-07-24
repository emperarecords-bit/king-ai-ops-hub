# Sprint 7 Report — "Company Knowledge (K1)"

> Prepared for the owner/CEO. Snapshot: 2026-07-24, end of Sprint 7.
> Authorization: Executive Response to Sprint 6 — roadmap reordered,
> Knowledge over Standing Work; impact analysis delivered pre-sprint and
> confirmed no architectural blocker. Prior reports: SPRINT-01 … 06.

---

## 1. Executive Summary

**What was accomplished.** Company Knowledge is live as a first-class
organizational asset. Every workspace now has a Knowledge page — "what your
team knows" — and every active knowledge item is consulted by every employee
before every piece of work, in that workspace and only that workspace. The
lifecycle enforces the design's two invariants mechanically: knowledge is
versioned, never edited (a change is a new version; activating it archives
its predecessor in the same transaction, so two versions can never inject
together), and humans gate the loop (drafts are quarantine; every activation
records who approved and when; every transition is audited). All 50 existing
approved context items — including every workspace charter — migrated in as
active knowledge with lineage back to their source rows. The engine, the
prompt wrapping, and the tenancy fire-alarm are untouched: exactly the
"generalize the existing read path" plan from the impact analysis.

**The strategic claim this enables:** using the Hub now visibly accumulates
an asset no chat window has. Every run starts from what the company knows,
and what the company knows is versioned, approved, and auditable.

**Internal consistency.** Implementation matches KNOWLEDGE-DESIGN.md §2–§4
with K1's declared scope (project only); the schema carries the full design
column set, so K2–K4 are code-and-policy changes, not migrations. The org-
wide scope (the one designed I1 exception) shipped nothing — such rows are
structurally invisible until K4's explicit policy.

## 2. Work Delivered

| Item | Detail | Commit |
|---|---|---|
| `knowledge_items` schema | Full design columns (scope, kind, version, supersedes lineage, source, approver identity); migration 0004 | `1ff3c83` |
| Data migration | Every approved context item → active knowledge `fact` with `source_ref` lineage; idempotent; `project_context_items` retained but no longer written | `1ff3c83` |
| Injection swap | `loadApprovedContext()` now reads ACTIVE project-scope knowledge — same `<untrusted-context>` wrapping, same per-row tenancy assertion, zero engine changes | `1ff3c83` |
| Lifecycle domain | create (draft or activate-now for human authors) · activate (archives predecessor atomically) · revise (new version with lineage) · archive (terminal); all audited with identity | `1ff3c83` |
| Knowledge page | Nav "Knowledge": add form (8 kinds), drafts-awaiting-approval queue, active items grouped by kind with New-version / Retire controls, collapsed version history | `1ff3c83` |
| Provisioning + seed | Charters are born as knowledge (active, founder-approved); new workspaces start with their first knowledge item | `1ff3c83` |
| Tests | 7 integration tests pinning injection discipline (drafts never inject; exactly one version injects; archived is terminal; only drafts activate) | `1ff3c83` |

**Evidence:** 120 unit/integration tests + 3 E2E green; RLS on
`knowledge_items` verified by the dynamic every-table check; 50 items
migrated with zero injection-behavior change for existing workspaces
(charters kept flowing into prompts through the swap).

## 3. Deviations and judgment calls

1. **Human-created knowledge can activate immediately** (author = approver,
   identity recorded). The draft→approve two-step is mandatory only for
   model-proposed knowledge (K2's promotion path). Rationale: forcing the
   single owner to approve their own typing is ceremony; the audit trail is
   identical either way.
2. **`project_context_items` retained, not dropped.** Read-only-by-
   convention until K2; dropping a table with historical FKs the same sprint
   as migrating its data would trade reversibility for tidiness.
3. **No injection token budget yet** — K3 per the design. Current volumes
   (a charter plus a handful of items) are nowhere near needing it.

## 4. Outstanding Questions (owner)

1. **Sprint 8 direction:** Standing Work as previously agreed ("immediately
   afterward unless engineering finds a stronger dependency" — none found:
   K2's promote-from-result button is tempting but Standing Work now
   generates the results worth promoting, so the agreed order holds). Confirm
   or redirect.
2. Carried, defaults safe: PartsHunt Pro unrun · approval expiry 24h ·
   single-owner · local-only · mini-model price verification.

## 5. Technical Debt

| Rank | Item | Type | Status |
|---|---|---|---|
| **Medium** | Nonce-based production CSP (deployment blocker) | Technical | Carried |
| **Medium** | `gpt-5.4-mini` pricing unverified | Product | Carried |
| **Low** | Retire `project_context_items` + its UI remnants (K2) | Technical | New |
| **Low** | Knowledge has no E2E scenario yet (domain rules are integration-tested; the page is exercised only manually) | Process | New |
| **Low** | Briefing per-workspace transaction batching; assignee column; funnel events; USER_JOURNEY pointer | Various | Carried |

## 6. Risks

**Product** — *Knowledge rot*: an active item nobody revisits becomes
confidently-injected stale truth — worse than ignorance. The design's
staleness measure (median age since last version) should surface on the
Knowledge page when there's enough history; watch manually until then.
*Over-stuffing*: everything active injects into every run; without the K3
budget, a knowledge-happy owner could bloat prompts and costs. Mitigation
today: item count is visible per kind; the briefing's budget line catches
cost drift.

**Security** — The injection surface grew in *content volume*, not in kind:
knowledge is wrapped and delimited exactly as context was (T2), cannot
execute anything, and model-proposed knowledge will enter only through the
draft quarantine. The K4 org-scope exception remains design-only.

**Technical** — The swap is the riskiest thing this sprint shipped and it
is deliberately boring: one function, same signature, same assertions,
integration-tested against the real database.

## 7. Sprint Review

| Dimension | Score | Reasoning |
|---|---|---|
| Scope | 10/10 | K1 exactly as designed, on the reordered priority, with the impact analysis honored |
| Quality | 10/10 | Injection discipline pinned by 7 tests; migration idempotent with lineage; zero regressions across 120 tests + 3 E2E |
| Completeness | 9/10 | −1: no Knowledge E2E scenario; the page's happy path rests on manual + component-level confidence |
| Maintainability | 9/10 | Full-column schema kills future migrations; −1: two knowledge write-paths (module + provisioning inline insert) should converge in K2 |
| Future scalability | 10/10 | K2–K4 are now incremental; the compounding measure (§8 of the design) is computable from day one |

**Overall: 9.5/10.** The strategic pivot you called for landed in one
sprint, without touching the engine, because two sprints of prior design
work meant K1 started with zero open questions — the pattern worth keeping.

## 8. Recommended Sprint — Sprint 8: "Standing Work"

As previously agreed, and the engineering review found no reason to reorder
again. Scope as specified in SPRINT-06-REPORT §9, with one addition earned
by K1: completed standing runs get the **"Save as company knowledge"**
promotion button (the first slice of K2), because recurring reports are
exactly the artifacts worth promoting — the two features compound.

**Success criteria** — a standing task defined Friday appears as a
completed, reviewed, metered result in Monday's briefing with no human
action between except approval decisions; promoting its result to knowledge
takes one click and lands in the draft queue.

## 9. CEO Briefing (one page)

**1. Where are we now?** Your company remembers. Every workspace has a
Knowledge page holding what the team knows — standards, decisions, personas,
playbooks — versioned like law, approved like policy, and consulted by every
employee before every piece of work. The 50 pieces of approved context that
already existed carried over with full lineage. Nothing about how work
executes changed; everything about what work *knows* did.

**2. Biggest remaining challenge?** Feeding it. Knowledge compounds only if
it grows from real work — which is why Standing Work plus the one-click
promote button is the right next sprint: recurring results become the
knowledge candidates, and mornings become generative at the same time.

**3. What should I personally focus on?** Seed the asset: open Knowledge in
your two busiest workspaces and write down the five things you find yourself
re-explaining — house style, pricing rules, who the customer is. Ten minutes
each, and every future run in those workspaces starts from it. That's the
compounding flywheel's first turn.

**4. Are we ready to continue?** Yes. Gates green, no new debt above Low,
and the next sprint is pre-scoped with success criteria.

**5. Decisions needed?** One: confirm Sprint 8 = Standing Work (+ the
promote-to-knowledge slice), or redirect.

---

*Requesting: approval of this report and Sprint 8 confirmation.*
