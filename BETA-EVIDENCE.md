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
