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

### O-12 · Workspaces cannot be edited at all

**Observed.** Owner asked how to edit a workspace. There is no way. Creating
one (`/projects/new`) is the only workspace-level operation in the product:
no rename, no description change, no archive, no delete, and no UI for the
monthly budget — the approved $30–100 limits were applied by a script and are
invisible and unchangeable in the app.

Everything *inside* a workspace is editable — employees, knowledge,
providers, objectives — which makes the gap harder to notice and stranger
once noticed. A `kingdom-core` workspace exists with a name the owner may
well want to change, and nothing to change it with.

**Why it matters.** Sprint 5 built the front door (create a workspace) and
nothing built the door back. It is the same shape as O-10 and O-11: a
capability was declared complete when its happy path worked, and the ordinary
follow-on action — *change my mind about what I just made* — was never
considered. Three findings of the same kind now, which suggests the pattern
is systemic rather than incidental: **features are being scoped to creation
and not to ownership.**

Note this is not merely cosmetic. A workspace name is on every screen, in the
briefing, and in the URL. Being unable to correct it is the kind of small
permanence that makes software feel like it belongs to someone else.

**Recommended fix.** A workspace settings screen: name, description, monthly
budget, archive. Archive rather than delete — runs, usage, and audit rows
reference the project, and the audit trail is append-only by design (I6). The
key should stay immutable (it is in every URL and audit row); rename the
display name only.

**Also worth deciding:** whether the owner can change a budget the platform
enforces against them. Recommend yes, with the change written to the audit
log — the gate's value is that spending is deliberate, not that it is
unchangeable.

---

### O-13 · RESOLVED — Episode 1 retrieval failure (root cause + live acceptance)

**Reported.** The Creative Director could not find the Episode 1 script even
though `2026-07-22_KingdomCore_S01E01_Screenplay.md` (16 chunks) was indexed
and active.

**Root cause.** Raw task text was passed to `websearch_to_tsquery`, producing
an overly restrictive AND query (`review & episod & 1 & continu`) that
returned zero chunks — no single chunk held all four stems, so nothing was
retrieved or injected.

**Fix (commit 0c5b868).** `expandDocumentQuery()` OR-joins lexemes and
normalizes episode references (Episode 1 / Episode One / Ep 1 / E01 / S01E01 /
Season 1 Episode 1 → the `s01e01` lexeme + `%S01E01%` filename pattern);
`retrieveRelevant()` boosts episode-filename matches so an "Episode 1" request
pulls the whole S01E01 material. No embeddings, no other retrieval changes.

**Live acceptance (2026-07-24, kingdom-core owner, task verbatim "Review
Episode 1 for continuity.", provider=both).** All criteria met:

| Criterion | Result |
|---|---|
| S01E01 screenplay retrieved | ✅ chunks 0, 14, 15 (of 5 retrieved) |
| Context injected into prompt | ✅ response cites SEED-A/B/C, 22:00 runtime, previz 21:59.96, Scene 3 |
| Provenance in Documents Used | ✅ `runs.retrieved_documents` populated |
| Real continuity review (not "provide the script") | ✅ detailed, specific to the material |
| Workspace isolation | ✅ 5/5 retrieved docs scoped to kingdom-core |
| No unrelated episode outranks E01 | ✅ 0 other-episode screenplays retrieved |

Documents Used: S01E01_Screenplay ch0 (0.039), ch14 (0.036),
S01E01_Storyboard_ShotList ch17 (0.033), S01E01_Screenplay ch15 (0.029),
S01E01_SceneDump ch0 (0.025). Review step returned `revise`; one revision ran;
consolidated normally.

**Status: retrieval bug RESOLVED.** Per directive, no embeddings or further
retrieval changes added.

**One non-blocking observation (not a failure).** All 5 slots filled with
S01E01-specific docs; broader Season-1 canon/character references
(Character_Arc_Tracker, Dialogue_Bible) did not make the top 5 because the
episode-filename boost prioritizes the referenced episode's own material. The
hard acceptance criteria all pass; if canon breadth becomes desirable later,
the lever is retrieval depth (raise K) or a small canon-doc quota — a future
decision, deliberately not made now.

---

### O-16 · RESOLVED — Context authority contract; residual hedging recorded

**Problem.** The model sometimes discounted correct Hub state as "conversation
context" / "not a live tracker", weakening right answers.

**Fix (commit pending).** An authority contract in the system prompt + tiered,
labeled context sections (Level 1 Hub state → Level 4 historical), with
conflict rules. Prompt-assembly only; no schema, retrieval, or state-selection
change.

**Live acceptance (kingdom-core owner, both providers) — all three pass:**
- T1 operational status: "treating the Hub snapshot as the current operational
  record for this run"; distinguishes doc claims from Hub status; recommends
  confirming approvals, not building a tracker.
- T2 conflict: names the conflict (doc "writing COMPLETE" vs Hub "0/5 criteria
  met"), rules Hub authoritative, recommends verify/update the Hub record —
  does not declare completion.
- T3 missing: names only the absent fields (owner, deadline); does not plead
  lack of project access.

**Residual hedging (recorded, not fixed — no scope expansion):**
1. T1 added: "that is an assumption based on the provided authority hierarchy,
   not a timestamp comparison I can independently verify here." This is the
   model correctly applying the L1>L3 hierarchy while noting it cannot verify
   document staleness — reasonable epistemic caution, not the old "conversation
   context" failure. If we wanted it gone, the lever is giving the state block
   a machine-comparable freshness signal vs. document dates, so the model can
   *verify* rather than *assume* currency — a future context-freshness sprint,
   deliberately not done here.
2. T3 phrased the scope as "the materials provided" while still naming the
   specific missing fields — acceptable; no broad access disclaimer.

**Status: authority contract shipped; hedging reduced from framing-level to
verification-level.**

---

### O-17 · RESOLVED — Context freshness signals; O-16 hedge eliminated

**Problem (from O-16).** The model treated Hub state as authoritative but
hedged: "I am assuming the Hub state is current, but I cannot independently
verify the timestamps."

**Fix (commit pending).** Machine-comparable freshness metadata per context
item (observed / source-updated / content-effective / confidence / basis), a
conservative labeled-date parser, and a precomputed Hub-vs-document freshness
relation injected into the prompt. Additive only — no schema change (freshness
persists in the existing `context_manifest` jsonb), no retrieval/quota/state
change (only an additive `indexedAt` column added to the document selects).

**Live acceptance (kingdom-core owner, both providers) — Test 1 scenario with
real data (Hub updated 2026-07-25 vs production-status doc effective
2026-07-23):**
- Reported the conflict (writing "COMPLETE" vs criterion "All 12 scripts
  approved" unmet).
- Stated the Hub is authoritative and **demonstrably newer**, citing concrete
  dates: "Hub record: updated 2026-07-25; Document: effective 2026-07-23."
- **No timestamp-verification hedge** — the O-16 residual is gone.

Tests 2–4 (document newer, not comparable, injection) are covered by
deterministic integration tests; setting them up live would require fabricating
documents in the owner's real folder.

**Residual hedging:** none observed in the live run beyond appropriate,
field-specific uncertainty. The freshness axis converted the prior
framing-level and verification-level hedging into concrete, dated statements.

**Status: freshness signals shipped; the O-16 → O-17 hedging arc is closed.**

---

### O-18 · RESOLVED — Task dependency graph (workflow structure)

**Goal.** Give employees dependency awareness, not just status: prerequisites,
dependents, blockers, what completion unlocks — from Hub records, never
inferred.

**Delivered.** A `task_dependencies` table (canonical prerequisite→dependent
edge, self-edge CHECK, RLS, unique pair); bounded neighborhood traversal
(depth 2 / 15 nodes) with Kahn's-algorithm cycle detection that reports rather
than recurses; a Level-1 Hub context source stating blocked-vs-independent-vs-
no-data explicitly; manifest `{nodeCount, edgeCount, rootTask, cycle}`; a
Dependencies management card on task detail (admins add/remove; cycles refused
at add time); panel extension. No change to retrieval, assembly, authority,
freshness, or providers.

**Acceptance — all four pass:**
- T1 chain A→B→C (integration): B reports prerequisite A, unlocks C.
- T2 parallel A→{B,C} (integration): C identified as parallel work, not a
  blocker of B.
- T3 cycle A→B→C→A (integration): detected, traversal bounded, no chain
  reported; `addDependency` also refuses the cycle-closing edge.
- T4 live KingdomCore (both providers): with a real scripts→dialogue→audio
  chain, the model recommended the three actions **in dependency order**
  (approve scripts first, "downstream work should remain secondary"), refusing
  to elevate blocked work. Graph metadata `{nodeCount:4, edgeCount:5,
  cycle:false}` persisted.

**Residual hedging:** the live response added "confidence moderate… sources do
not expose the full underlying records" — mild, about not seeing every record,
not about the graph; the ordering itself was stated confidently. Not pursued
(out of scope).

**Status: dependency awareness shipped.**

---

### O-19 · RESOLVED — Decision memory (organizational memory)

**Goal.** Preserve approved operational/creative conclusions across tasks so
future runs inherit them instead of relosing the reasoning at task completion.

**Delivered.** A first-class `decisions` table (proposed → accepted →
superseded / rejected; self-FK supersession; RLS; structured memory only, no
transcripts); a human approval workflow (never auto-created); a Level-1
Decision-memory context source — accepted only, bounded to 10, ranked by
task/objective/document/recency, superseded never retrieved; manifest +
Context-used panel; a Decisions screen (propose / accept / reject / supersede).
No change to retrieval, authority, freshness, dependency graphs, providers, or
the run workflow — decisions are a parallel Level-1 source.

**Acceptance — all four pass:**
- T1 live: with "Episode runtime fixed at 22:00" accepted, "Should Episode 1 be
  shortened to 20 minutes?" → the model cited the decision first and declined.
- T2 integration: B (24 min) supersedes A (22 min) → A becomes superseded/
  historical, only B is retrieved as current; A appears solely as B's
  superseded note.
- T3 live: "Review Episode 1 continuity" referenced the accepted "Architect
  symbol first appears in Scene 4" decision without rediscovering it from
  documents.
- T4 integration: no decisions → no memory block, no hallucinated memory.

**Residual hedging:** the live responses added the usual doc-vs-Hub freshness
caveat (correct, from O-17) — decision citations themselves were confident.

**Status: organizational memory shipped.**

---

### O-20 · RESOLVED — AI-suggested decision candidates (human-in-the-loop)

**Goal.** Let completed runs suggest structured decision candidates for human
review, without letting the AI approve anything.

**Delivered.** A separate, bounded, one-shot extraction after task completion
(one structured call on the primary provider, strict JSON, ≤3 candidates, zero
valid); server-side grounding + dedup + supersession validation against run
provenance; candidates saved `proposed` with suggested_by_run_id / confidence /
evidence (reused decisions table + 5 additive fields + runs.
candidate_extraction_status); a Suggested-decisions review queue with
accept / edit-and-accept / reject / defer, labeled "AI suggestion — not an
accepted decision." Idempotent; fail-safe (extraction failure never touches the
task); the AI can never self-approve (save path hardcodes proposed). O-19
accepted-ranking, authority, freshness, dependencies untouched.

**Acceptance — all six pass:** T1 clear decision (integration: one proposed
candidate, not in memory until accepted, then in memory), T2 recommendation →
zero, T3 duplicate suppressed, T4 supersession kept+linked, T5 injection/
ungrounded ref rejected (unit), T6 forced failure leaves task completed +
records 'failed' + saves nothing (integration).

**Live KingdomCore:** a "lock previz" task produced one AI candidate (proposed,
confidence high); it was absent from a subsequent run's Decision Memory before
approval and present after admin acceptance. extraction status 'succeeded'.

**Status: human-in-the-loop memory capture shipped.**

---

### O-21 · Cloud deployment readiness

**Delivered (verified).** Durable run execution (Postgres job queue + worker;
atomic claim, idempotent enqueue, restart recovery to a failed-recoverable
state — no duplicate provider billing); config layer that refuses to boot in
production with placeholder/superuser secrets; advisory-locked migrations
verified to apply 0000-0012 to a CLEAN db with the full 265-test suite passing;
storage-boundary fix so a disconnected folder reports unavailable instead of
archiving everything; StorageAdapter seam; /api/health (process/db/migrations/
worker); run correlation id in logs; Dockerfile (standalone) + fly.toml (one
supported path); mobile-viewport pass (no horizontal overflow, nav wraps).

**Owner-dependent (documented, not done here).** The live Fly deploy + real
phone pass need the owner's Fly account. Deferred launch risks enumerated in
DEPLOYMENT.md §9 — chief among them: production MUST connect as app_server (not
the dev superuser) for RLS to be enforced, and the cloud Project Library
ingestion adapter is designed but not built.

**Status: deployable, not yet launched.**

---

### O-22 · Production RLS enforcement

**Delivered (verified).** The application now runs against the non-superuser
`app_server` role (`NOSUPERUSER NOBYPASSRLS`, owns nothing), with RLS proven as
the independent database boundary — not just the app-layer filters.

- **Three-role model** in `rls.sql`: migration role (owner, DDL/fixtures),
  `app_server` (runtime), `app_system` (`NOLOGIN BYPASSRLS`, owns the
  `SECURITY DEFINER` `app.*` dispatch functions only). `app_server` has no
  general cross-tenant read.
- **Cross-tenant escape hatches confined to definer functions:** worker claim/
  finish/requeue, stale-job list, due-schedule list, health aggregate, and
  placeholder-profile adoption. The worker, standing tick, and health endpoint
  were all rewritten to use them; every run still executes through `withTenant()`.
- **Bootstrap made app_server-safe:** `withUser()` boundary + navigation-table
  policies keyed off membership (recursion-safe via `app.is_org_member` /
  `is_project_member` definer helpers — a latent self-referential policy recursion
  that only surfaced under a non-superuser role, fixed here).
- **Provisioning fix:** `INSERT … RETURNING` on a just-created org/project is
  refused by the SELECT policy (no membership row yet); provisioning now generates
  ids and inserts without RETURNING.
- **Observability:** `tenant.context_invalid` (fail closed), `rls.rejected`
  (WITH CHECK refusal), identifiers only — never row data.
- **Proof:** `tests/integration/rls-enforcement.test.ts` (direct cross-tenant
  read/insert/update refused as app_server, missing-context, membership, policy
  guard) + `worker-isolation.test.ts` (per-job context restore, no pool leak,
  fail-closed on missing identity). `npm run test:rls` runs the FULL suite with
  the app connection = `app_server`: **276/276 pass**, and it prints the resolved
  `current_user`. Re-verified against a freshly migrated clean database.
- **Live:** worker boots as `app_server`, claims across the queue via the definer,
  restores per-job tenant context, and executes the gated run path; the web
  process boots as `app_server` and serves `/api/health` (`ok`) and the
  authenticated dashboard rendering real tenant data under RLS.

**Owner-dependent.** Production sets a real `app_server` password (the dev value
is a placeholder `assertProductionSafe` rejects); the interactive real-device
click-through is the same sign-in-gated step as O-21. Standing-work still runs
locally as `king`; when the cloud scheduler is wired (§9 #3) it uses the same
definer path, already implemented.

**Status: RLS enforcement proven under app_server — launch gate #1 closed.**
