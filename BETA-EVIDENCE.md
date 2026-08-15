# Beta Evidence Log

Baseline: **v0.23.0-beta** (O-23 accepted, 2026-07-25). Platform operational on
Fly.io staging (`king-ai-ops-hub-staging.fly.dev`).

**Purpose.** Every meaningful beta observation gets an entry here. Roadmap and
architecture decisions cite evidence IDs (`EV-###`) from this log — not intuition
or anticipated needs. Per the engineering policy, any change that materially
alters architecture must reference one or more entries below.

**Severity scale:** `critical` (data loss / outage / isolation breach) ·
`high` (blocks a core workflow) · `medium` (degrades a workflow, has a workaround)
· `low` (cosmetic / usability / self-corrected).

**Exit criteria (tracked, not yet met):** critical defects resolved · operational
metrics stable · retrieval quality acceptable · decision quality acceptable · user
workflows friction-tested · backup/recovery re-verified · mobile validation done.

---

## Entry template

```
### EV-NNN — <short title>
- Date:
- Environment:
- Feature exercised:
- Expected behavior:
- Observed behavior:
- Severity:
- Root cause (if known):
- Resolution:
- Follow-up required:
```

---

## Entries

### EV-001 — Stale blocker text leaked into model output
- **Date:** 2026-07-25
- **Environment:** staging
- **Feature exercised:** Multi-model run + context assembly (Blockers source)
- **Expected behavior:** A prior failed attempt's blocker is background status; the model should not echo it as part of a continuity-review answer.
- **Observed behavior:** The primary (OpenAI) answer appended unrelated "Current Hub status still shows the Review task as pending/blocked due to a failed primary model call" text. The Anthropic reviewer flagged it (`major`: irrelevant/hallucinated system status); the revision removed it. Final consolidated output was clean.
- **Severity:** low (self-corrected by the review layer; no defective final output)
- **Root cause:** The same task's earlier failed attempt (transient OpenAI-key rejection) was present in the context package's Blockers section, and the model incorporated it.
- **Resolution:** None applied. Candidate fix (usability): exclude transient/superseded blockers from a retry's context, or instruct the model to treat Blockers as non-echoable status.
- **Follow-up required:** Track recurrence across beta runs; fix only if it repeats or ever survives the review layer.

### EV-002 — `cloud_upload` provenance not surfaced in "Context used" UI
- **Date:** 2026-07-25
- **Environment:** staging
- **Feature exercised:** "Context used" / provenance display
- **Expected behavior:** Per O-23, a retrieved document's source type (`cloud_upload` / `local_folder`) is visible in the provenance panel.
- **Observed behavior:** Panel shows filename + freshness but no source badge. Data is correct — `runs.retrieved_documents` records `"source":"cloud_upload"` (verified server-side).
- **Severity:** low (cosmetic; underlying data correct)
- **Root cause:** The panel does not render the `source` field from `retrieved_documents`.
- **Resolution:** None applied. Candidate: render source in the panel (permitted usability enhancement).
- **Follow-up required:** Small UI fix, schedule when convenient.

### EV-003 — Managed Postgres outage under load at 256 MB
- **Date:** 2026-07-25
- **Environment:** staging
- **Feature exercised:** Managed Postgres under app pool + 2 s worker polling + health checks
- **Expected behavior:** DB stays available under normal staging load.
- **Observed behavior:** DB machine (256 MB, Fly default) thrashed; primary flapped its own health check (5–7 s); cluster reported "no active leader"; app returned **503**; worker claim queries failed.
- **Severity:** critical (full outage) — resolved
- **Root cause:** 256 MB insufficient for `postgres-flex` under this workload.
- **Resolution:** Scaled DB machine to **1 GB**; recovered immediately. Documented ≥1 GB as a launch requirement (DEPLOYMENT.md §11.8).
- **Follow-up required:** Watch DB memory/CPU under real beta load; add metrics/alerting before production RC.

### EV-004 — Objective stays `draft` until a measurable success criterion is added
- **Date:** 2026-07-25
- **Environment:** staging (real operation — creating AccurateBids' first objective)
- **Feature exercised:** Objective creation + activation (first business, "Launch AccurateBids.com commercially")
- **Expected behavior:** Creating an objective for a business goal makes it active/usable.
- **Observed behavior:** The objective saved in **`draft`** and would not activate until the owner added a success **criterion** with a **target + unit**. The owner had to discover this requirement ("needed to give it a criterion to activate it"). The objective form also carries several structured fields (criterion target+unit, sponsoring department, accountable employee) vs. the 2-field workspace form. Translating a qualitative launch goal into a numeric target/unit is not obvious.
- **Severity:** low (owner resolved it) — but **structural**: every objective requires this, so likely recurs.
- **Root cause (if known):** The objective model requires ≥1 measurable criterion (target+unit) to activate; qualitative goals must be forced into a quantitative frame, and the "must add a criterion to activate" rule isn't surfaced up front.
- **Resolution:** None (measuring per policy).
- **Follow-up required:** Watch whether this recurs and materially slows the owner across the other businesses' objectives. Candidate small improvements *only if confirmed recurring/material*: inline "add a criterion to activate" hint at creation, a qualitative/checklist criterion option, or allowing a draft objective to be worked before it's measurable.

### EV-005 — No owner-facing way to edit/assign employees (team)
- **Date:** 2026-07-25
- **Environment:** staging (operating AccurateBids)
- **Feature exercised:** Team / employee management
- **Expected behavior:** Owner can view and edit/assign the people working a business.
- **Observed behavior:** (1) Getting Started "Meet your team" is read-only (noted earlier as a candidate). (2) While operating the business the owner stated plainly: "we definitely need to be able to edit employees." Current model is a fixed set of engineering roles (Lead/Senior/Reviewer/Principal) with no owner-facing add/assign/edit path — so a business can't be staffed with the roles it actually needs (e.g., a marketer for AccurateBids' launch).
- **Severity:** medium (does not block the current objective/assessment, but blocks the intended operating model of staffing each business).
- **Root cause (if known):** Employee model is fixed at the code level; no CRUD/assignment UI, and non-engineering roles don't exist yet (deferred by directive).
- **Resolution:** None (measuring). This is the beta signal the directive anticipated would justify the employee-editing + non-engineering roles work — hold until a real task is blocked for lack of the right employee.
- **Follow-up required:** Confirm with a blocking instance — a point where the owner cannot complete needed work (e.g., marketing) because the role can't be assigned. That instance upgrades severity and justifies the smallest employee-management improvement.

### EV-006 — Request: voice control (feature request, behavioral basis)
- **Date:** 2026-07-25
- **Environment:** staging (operating AccurateBids)
- **Feature exercised:** Text input across the app (objective, description, criteria)
- **Expected behavior:** N/A — owner-stated future desire, not a defect.
- **Observed behavior:** Owner requested "we need to put voice control in." Behavioral basis: the owner is operating largely by voice dictation (into the assistant), and typing structured fields is friction-prone. No in-product abandonment observed yet.
- **Severity:** low (feature request / preference, not observed in-product failure)
- **Root cause (if known):** N/A — new capability, outside the current architecture.
- **Resolution:** None; parked per evidence-first policy. Not built.
- **Follow-up required:** Watch for observed in-product friction (e.g., owner abandons or errors on long text entry) that would upgrade this from preference to demonstrated need before any roadmap slot.

### EV-007 — Bulk upload capped at 20 files; real doc sets are larger
- **Date:** 2026-07-25
- **Environment:** staging (operating AccurateBids — loading the real knowledge base)
- **Feature exercised:** Project Library bulk document upload
- **Expected behavior:** Load an existing business's document set in one action.
- **Observed behavior:** Upload is capped at **20 files per batch**; the owner's AccurateBids doc set is **53 markdown files**, forcing **3 separate manual batches** to load one business. Repetitive; compounds across a 6-business portfolio (each with dozens of docs).
- **Severity:** medium (doesn't block, but materially adds repetitive steps to first-time knowledge loading, and recurs per business).
- **Root cause (if known):** Batch-size limit (O-23 shipped it as "explicit and configurable"), currently 20.
- **Resolution:** None (measuring). Candidate small improvements *if recurring/material*: raise/config the cap, or add a folder/zip import path. Not built.
- **Follow-up required:** Confirm recurrence on the next business's onboarding. If bulk-loading is routine, it justifies raising the cap or a folder import — a small, contained change.

### EV-008 — Retrieval breadth too narrow for a comprehensive assessment over a large corpus
- **Status: CLOSED — resolved as usage (owner-confirmed 2026-07-25).** No engineering justified; the fix was an operator pattern (decompose broad reviews into focused tasks). First demonstration that an observed limitation dissolved via process, not code — the intended outcome of the architecture freeze.
- **Date:** 2026-07-25
- **Environment:** staging (operating AccurateBids — first launch-readiness assessment over 53 docs / 293 chunks)
- **Feature exercised:** Context retrieval for a broad analytical task
- **Expected behavior:** A launch-readiness assessment draws on the launch-relevant material that was loaded (checklists, 90-day plan, state-of-product).
- **Observed behavior:** The completed run retrieved only **5 chunks from 4 of 53 documents** (board-debate, business-model, claude-code-handoff, state-of-product). It **missed launch-critical docs that directly answer the task** — Stripe go-live checklist, checkup checklists, brief+90-day plan, launch smoke test, product descriptions. Retrieval returns the top-5 chunks (+ core references, which are KingdomCore-shaped and don't apply here) regardless of corpus size, so one run over a large corpus sees a narrow slice.
- **Severity:** medium. **CORRECTION (2026-07-25):** an earlier note here upgraded this to medium-high on a claimed "confident false gap" (brand name = "Empera"). A follow-up focused task **partially disproved** that: asked directly, the model answered brand = "AccurateBids" (defensible; "Empera" is the *parent* entity, a different thing) and launch-city = "not specified," citing a handoff doc that literally says *"Ask the founder: what city is the launch market?"* — so that gap is almost certainly **genuine**, not fabricated. My grep-based false-gap inference was overstated; corrected down to medium.
- **Confirmed core finding (reinforced):** the *breadth* problem is real and **not solved by scoping**. The focused "platform name / launch city" task retrieved the **same 5 strategic chunks** (handoff, board-debate, business-model) and **still never reached** the long-tail docs (Empera price list, Stripe go-live checklist, checkup checklists, PRDs). Retrieval is lexical FTS (OR-match, top-5): it returns whichever docs share vocabulary with the task text, so high-signal strategic docs dominate and the long tail is unreachable **unless the query uses those docs' own words**. Risk: a "what's complete / what's missing" answer only ever reflects the retrieved slice, and the owner can't easily tell what wasn't seen.
- **Root cause (if known):** Top-N (=5) ranked retrieval with no breadth scaling and no multi-pass/section-scoped retrieval for large analytical tasks. Retrieval ranking is frozen by directive.
- **Resolution (RESOLVED as usage, 2026-07-25):** Decisive test — a keyword-matching task ("Summarize the Stripe go-live checklist") **did retrieve the exact long-tail doc** (`2026-06-07_AccurateBids_Stripe_GoLive_Checklist.md` chunk 0) and produced an accurate, grounded, cited summary (real specifics: "budright inc sandbox", $39/$79/$149 pricing, `sk_live`, deploy-gating). So the long tail **is** reachable when the query shares its vocabulary — not a retrieval defect; a single **broad** task just only sees the lexically-dominant top-5. **Fix is usage/guidance, not architecture; retrieval stays frozen.** Pattern: treat one broad assessment as *strategic synthesis*; for *tactical completeness*, run **focused keyword-specific tasks** (Stripe, pricing, QA, legal, …) and synthesize.
- **Follow-up required:** Capture the usage pattern as owner guidance ("decompose comprehensive reviews into focused tasks"). Residual risk to watch: an owner trusting a broad assessment's "nothing missing" without targeted follow-up — if that causes a real miss in practice, revisit a *small* nudge (e.g., a "covered N of M docs" hint), still not a retrieval rebuild.

### EV-009 — Review step is blind to Decision Memory, so it penalizes correct memory-grounding
- **Status: RESOLVED (2026-07-25, owner-ruled option A).** Fix shipped (commit `f38332f`… then `fix(review)`): review-stage **context parity** — the reviewer now receives an authoritative "Approved Organizational Policies" block (the accepted decisions), rendered business-facing, internal name never exposed. Scope was review-stage-only (no retrieval/ranking/storage/approval/schema/primary changes).
  - **Confirmation:** 2 occurrences, 2 domains (launch/marketing + pricing/billing); second time the forced revision *erased* the accepted 25/NPS40/5 thresholds from the deliverable.
  - **Behavioral validation (staging, v11):** T1 GTM → approve, policy preserved, no fabrication flag; T2 pricing → reviewer validates *against* policy (asks for stronger Stripe-gate integration), not stripped; T3 (invented customers) & T4 (broad-launch contradiction) → **system-level pass** — with parity restored, the *primary* refused to fabricate (T3) and refused the policy-contradicting plan (T4), so no bad content reached the reviewer; reviewer **not blunted** (raised real issues on T1/T2).
  - **Regression coverage:** 6 unit tests on the review prompt (flag unsupported claims; flag policy contradictions; never flag policy-grounding as fabricated; policy is authoritative-not-mandatory; no internal-name leak; no block when empty).
  - **First complete beta cycle: Observation → Reproduction → Root Cause → Minimal Fix → Behavioral Validation → Regression Protection.**
- **Date:** 2026-07-25
- **Environment:** staging (Decision Memory validation — neutral AccurateBids GTM task after accepting 6 org decisions)
- **Feature exercised:** Multi-model review pipeline interacting with Decision Memory (O-19)
- **Expected behavior:** When the primary correctly grounds output in accepted org decisions, the review step recognizes that grounding as legitimate institutional policy.
- **Observed behavior:** Decision Memory worked — the neutral task (no mention of pilots/thresholds) produced a policy-aware plan (supply-first, 25/NPS40/5, pilot-gated) and the "Decision memory" context showed all 6 accepted decisions. **But** the Anthropic reviewer — which receives the task + primary answer, **not** the Decision Memory context — flagged the memory-grounded statements as a **major** issue ("Unverified appeal to an unspecified 'workspace' as source of authority … may be fabricated"), explicitly noting "no such context was provided **to the reviewer**." That forced a revision that **downgraded the org's accepted policy** from established fact ("the workspace's validation thresholds") to a fresh suggestion ("I recommend using the following thresholds"). The review pipeline **diluted the institutional authority Decision Memory is meant to establish.**
- **Severity:** medium — directly undercuts the value of the Hub's core differentiator: accepted org policy gets re-framed as unverified/recommended in the final output.
- **Root cause (owner-refined 2026-07-25):** Architectural **context inconsistency across pipeline stages**, not a retrieval gap. Generation and review operate with *different authoritative context* — the primary receives accepted org policy; the reviewer evaluates without it — so correct policy references look unsupported from the reviewer's vantage, producing **false-positive hallucination findings**.
- **Resolution:** None (measuring). Candidate fix *if confirmed* (do **not** redesign Decision Memory): ensure every model participating in a workflow evaluates against the **same authoritative org context**. The review model needs only a **concise summary of accepted decisions**, not the full retrieval context — enough to validate policy-grounded claims. Preserves governance, eliminates false hallucination flags.
- **Follow-up required (evidence threshold):** One occurrence identifies the phenomenon; **reproduce once more with a *substantially different* business task** before building. If the reviewer again downgrades policy-aware reasoning for lack of org context, **EV-009 is confirmed** and the context-parity fix becomes the first evidence-justified product change.

### EV-010 — Operating-model audit: no human-owned work item (foundational gap, fixed)
- **Trigger:** Final operating-model audit before declaring the Hub operationally complete ("Can I operate a real business from this today?" across all 11 core workflows).
- **Observed behavior:** 10 of 11 workflows passed. One foundational gap: the Hub could track **AI executions** (tasks) but had **no human-owned, editable work item**. Verified in code — a `task` requires an AI assignee + prompt, **auto-runs a paid provider call on creation** (`?autorun=1`), is **write-once** (no `updateTask`, no notes field), and its status vocabulary is execution lifecycle, not business stages. The immediate operating activity (the Week-1 pilot pipeline: "each prospect = an owned task, stage moves as work progresses, update Next Action each touch") **could not be executed as specified**.
- **Severity:** foundational — a business OS must represent human work (conversations, deals, follow-ups), not only AI runs. Blocked the first real operating task, so it met the "prevents functioning as a business operating system" bar, not merely "would be nicer."
- **Root cause:** The Hub's only work object (`tasks`) is an AI-execution unit; there was no object category for human work a person owns and advances by hand.
- **Resolution (owner-approved, built 2026-07-25):** Minimal standalone `work_items` object reusing Slice 1 ownership — title, free-text stage, editable notes, optional employee owner, optional objective grouping. No AI run, no cost, no automation/routing/reminders/board/reporting. Migration 0015 (additive) + RLS; `/work` page with create + in-place edit + owner picker. Validated: tsc clean, 4 new integration tests over the real DB + RLS, build green, deployed to staging (release migration succeeded).
- **Disposition:** CLOSED. This was the final structural piece. Architecture freeze re-armed — no further platform work without repeated operational evidence.

### EV-011 — Owner cannot operate conversationally: the task form is the only way to talk to an employee
- **Trigger:** First real owner operating session on production (2026-08-15, evening) after full staffing + GM installation. The owner attempted to instruct AccurateBids' Operating Manager and asked, verbatim: "there's no way I could just click on … the operating manager … and instruct them … maybe you have, like, a text back and forth," and separately: "I just wanna contact what I need to contact and get what I need to get done. I wanna minimize my workload."
- **Date:** 2026-08-15
- **Environment:** production (first owner-driven operating attempt after the 0063 release)
- **Feature exercised:** Task creation as the sole employee-interaction surface.
- **Observed behavior:** Instructing an employee requires the Objectives → task form path (title, brief, assignee, submit) and reading the reply requires the task detail page. The owner could not find task creation from the Work page at all, and the form-per-exchange model contradicts the product's stated purpose (owner gives orders and approvals; the hub carries everything else). Direct owner quotes above; observed twice in one session (navigation failure + explicit request for chat).
- **Severity:** high (usability-foundational) — the primary user cannot comfortably perform the product's primary loop. No data risk; purely an interaction-model gap.
- **Root cause:** Every employee interaction is modeled as a formal one-shot task; there is no conversational surface, though the storage model (per-task message rows) already records exchanges in conversational shape.
- **Resolution (owner-directed, built 2026-08-15):** Employee Chat — one standing conversation per (workspace, employee); each owner message becomes an ordinary pinned task (budgets/approvals/audit unchanged) whose input carries a bounded transcript window; clean owner messages are message rows with run_id NULL; thread UI at /p/<key>/agents/<id>/chat with a Chat button on Employees. Migration 0064 (conversations + tasks.conversation_id), RLS-guarded like api_tokens. 10 new tests (4 unit transcript, 6 live-DB integration incl. RLS path, idempotent thread identity, transcript carry-forward).
- **Disposition:** SHIPPED pending release ceremony. Follow-up candidates (not built; awaiting evidence): approvals-first mobile summary ("I just wanna okay stuff"), GM fan-out from chat.
