# Sprint 3 Plan — "Prove It Live" (Revised per Executive Decisions, 2026-07-23)

> Status: **awaiting owner approval. No implementation has begun.**
> Supersedes the Sprint 3 scope sketched in [SPRINT-02-REPORT.md](SPRINT-02-REPORT.md) §9.
> Inputs: Executive Decisions memo (2026-07-23), CTO review, ROADMAP.md,
> OBJECTIVES.md, AGENT_CATALOG.md.

---

## 1. Decision intake — what was approved and how it lands

| # | Executive decision | Disposition | Where it lands |
|---|---|---|---|
| 1 | Spend limits ($100/$100/$40/$30/$30/$30) | Accepted; one clarification needed (§2.1) | M1, config + seed |
| 2 | Defaults: GPT-5.2 mini primary, Claude Sonnet reviewer; flagship reserved | Accepted; routing strategy in §4 | M1 |
| 3 | First live run = first milestone | Accepted | M1 |
| 4 | Objectives ASAP without destabilizing Sprint 3 | **Split**: dark schema in Sprint 3, product vertical in Sprint 4 (§5) | M4 |
| 5 | Departments in data model, minimal UI | Accepted | M4 (same migration) |
| 6 | FTUX design spec, no implementation | Accepted → `ONBOARDING.md` | M4 |
| 7 | Approval expiry 24 h | No change needed | — |
| 8 | Single-owner, keep designing multi-user | No change needed | — |
| 9 | Local-only until 5 listed gates pass | Accepted; 2 of 5 gates already closed (encryption, git) | M0/M1 close two more |
| 10 | Automated backups = high priority | Accepted; strategy in §6 | **M0 (first)** |
| 11 | No pricing/branding work | Accepted | — |
| 12 | Success criteria on Objectives | Accepted; model in §5.3 | Spec now, schema in Sprint 4 |

## 2. Conflicts and corrections (review requested by the memo)

### 2.1 "King AI Operations Hub" is not a workspace (correction required)

The budget table lists six rows, but only five workspaces exist. "King AI
Operations Hub" is the platform itself.

**Recommendation:** create a **sixth workspace, `king-ai-ops-hub`**, holding the
$100 budget, used for platform self-development tasks (docs review, planning,
release notes — dogfooding). This matches the memo's intent, gives the hub a
place to eat its own cooking, and exercises "create a new workspace" for the
first time since seeding — itself a useful test. **Needs a yes/no at approval.**
If no: the $100 is unallocated and the other five budgets stand as written.

### 2.2 Reviewer economics (caution, not a conflict)

At approved rates, the reviewer is the expensive half of the default pair:
Sonnet output is $15/M vs. mini's $2/M. A typical reviewed task will spend
roughly 60–80 % of its cost on the review step. This is accepted as the price
of the differentiator — flagging it so the Usage screen numbers don't surprise.
If budgets bite later, Claude Haiku 4.5 ($1/$5) is the drop-in cheaper
reviewer; **no change now**, Sonnet stands per the decision.

### 2.3 Future auto-routing has one security constraint (design guardrail)

Automatic model selection must be **deterministic and content-independent of
model output**: the router may read task metadata and the human's category
choice, never a model's own judgment of "this looks complex" — otherwise
injected content in a task could talk the router into flagship spend
(cost-escalation via prompt injection). The §4 design respects this; recorded
here so it survives into the implementing sprint.

**No other architectural, security, scalability, or product conflicts found.**
Every decision fits inside existing invariants I1–I8; none touches the
approval model, tenancy, or provider abstraction.

## 3. Revised roadmap deviations

ROADMAP.md Phase 2 ("review hardening") remains Sprint 3's core. Changes on
approval:

1. Phase 2 gains: backups (new M0), budget/model config, live-proof milestone.
2. Phase 2 gains a **dark-schema** tail (Objectives + Departments migration,
   no UI) so Phase-2.5/Sprint-4 is pure product work. ROADMAP "Phase 2.5 —
   Objectives" will be added between Phases 2 and 3.
3. FTUX spec (`ONBOARDING.md`) authored in Sprint 3; implementation scheduled
   into Sprint 4 alongside the Objectives UI (they are the same screens).
4. Phase 3 (executors) shifts one sprint later. Nothing depended on its date.

## 4. Model routing strategy (recommendation, implements decision #2)

**Now (Sprint 3): two named tiers, resolved in code, manual override.**

```
tier "standard"  → primary gpt-5.2-mini      reviewer claude-sonnet-5
tier "flagship"  → primary gpt-5.2           reviewer claude-opus-4-8
```

- `src/orchestration/routing.ts`: a pure function
  `resolveModels(tier, primaryProvider)` — keeps D-005 cross-vendor pairing in
  both tiers and both directions.
- Task form gets one control: **"Use flagship models"** checkbox (default off)
  plus a required category dropdown when checked (architecture / security /
  database / refactor / strategy / complex reasoning / release review — the
  approved reserved list). The category is stored on the task and audited, so
  flagship spend is always attributable to a stated reason.
- Agent Settings keeps full manual override per agent (existing capability,
  unchanged) — settings win over tier defaults when explicitly set.

**Later (documented, not built): auto-selection.** A deterministic classifier
(keyword/category rules in config, then optionally a *fixed cheap model* whose
output can only choose `standard` — it can never select flagship; only rules
or a human can). Router decisions logged to `audit_logs` either way. This
honors §2.3 and gives a clean upgrade path without a schema change (tier and
category already stored from Sprint 3).

Seed/agent changes on approval: all five (six) workspaces' default agents
switch to `gpt-5.2-mini` / `claude-sonnet-5`; flagship agents remain available
via the tier toggle rather than as separate agent rows.

## 5. Objectives: earliest practical implementation (answers decision #4)

**Recommendation: dark schema in Sprint 3 (M4), full vertical in Sprint 4.**

Why not the full feature in Sprint 3: the schema is the cheap 20 % —
the value is the UI (create/attach/rollup/report), which is a full sprint of
screens plus RLS tests plus tenancy-suite extension plus golden-path E2E.
Folding that into Sprint 3 would push the live-proof and streaming work — the
things that de-risk everything else — behind new surface area. That is the
"unnecessary delay" direction, just pointed the other way.

What "dark schema" buys: the Sprint-4 migration risk goes to ~zero (it will
already be applied, RLS'd, and tenancy-tested in Sprint 3), and `tasks` gains
its nullable `objective_id` now so no backfill is ever needed.

Sprint 3 M4 migration (all additive, per OBJECTIVES.md §Schema):
`departments` enum + `agents.department` column; `objectives`;
`milestones`; `tasks.objective_id` + `tasks.milestone_id` (nullable FKs);
RLS policies; tenancy tests extended to the new tables. **No UI.**

### 5.3 Success criteria in the Objective model (answers CTO addendum)

Add to the Sprint-4 schema (spec'd now in OBJECTIVES.md):

```
objectives.success_criteria  jsonb NOT NULL DEFAULT '[]'
-- array of:
{ "label":  "100 beta users",          // human-readable
  "metric": "beta_users",              // machine key
  "target": 100, "unit": "users",      // comparable value
  "source": "manual",                  // manual | usage | integration:<id>
  "status": "unmet",                   // unmet | met | waived
  "verified_by": null, "verified_at": null }
```

Rules (consistent with MISSION.md verification-based completion):
- An objective **cannot reach `completed` while any criterion is `unmet`** —
  criteria are met or explicitly **waived by a human**, and both are audited.
- `source: "manual"` at launch; `usage` later lets criteria bind to platform
  data (e.g., cost-per-outcome); `integration:` reserved for Phase 6+.
- Criteria changes after activation are new audit events, not silent edits —
  goalposts move only in daylight.

## 6. Backup strategy (answers decision #10)

Windows-native, zero new services, restore-tested:

1. **Nightly logical dump** — `scripts/backup.ps1`: `docker exec pg_dump -Fc`
   → `%USERPROFILE%\Backups\king-ai-hub\king_ai_hub-<date>.dump`, then copy to
   `%USERPROFILE%\OneDrive\Backups\king-ai-hub\` (off-machine via OneDrive
   sync). 30-day retention both sides.
2. **Registered via Task Scheduler** at 03:00 daily (`scripts/register-backup-task.ps1`).
3. **Pre-migration dump** — `npm run db:migrate` takes a dump before applying
   anything (hook in `scripts/migrate.ts`).
4. **Restore drill** — `scripts/restore-verify.ps1` restores the latest dump
   into a throwaway container and row-counts core tables; run monthly and at
   M0 to prove the path works before we rely on it.

M0 exit: one automated nightly dump exists in both locations and a restore
drill has passed. (Closes deployment gate #3 from decision #9.)

## 7. Sprint 3 milestones

| M | Name | Contents | Exit criterion |
|---|---|---|---|
| **M0** | Operational safety | Backup scripts, scheduled task, restore drill | Verified restore from an automated dump |
| **M1** | Prove it live | Spend limits applied (+ 6th workspace if approved); default agents → mini/Sonnet; tier toggle + category; live smoke run in **every** workspace; E2E suite green with real credentials | Evidence pack in SPRINT-03-REPORT: usage rows, audit chain verify, screenshots; all decision-#3 checks pass |
| **M2** | Observable review | Structured verdicts (Zod: verdict + issues[] w/ severity) + `run_steps.verdict_detail jsonb`; SSE streaming on task detail; review-value card on Usage | A `both` task streams live and renders a structured review panel; revise/reject rate visible |
| **M3** | Pin & polish | Golden-transcript suite (recorded against approved default models); email-relink fix + regression test; 5 doc one-liners; login sign-up UX fix | `npm run verify` green incl. transcripts; no High doc debt |
| **M4** | Dark foundations | Additive migration (departments, objectives, milestones, task FKs) + RLS + tenancy tests; `ONBOARDING.md` FTUX spec; ROADMAP/DECISIONS/OBJECTIVES updates (D-014 routing, D-015 departments, §5.3 criteria) | Migration applied & tenancy-tested with zero UI change; FTUX spec review-ready |

Order is deliberate: nothing irreversible happens before backups exist (M0),
and nothing new is built before the existing engine is proven live (M1).

Estimated effort: ~8 focused sessions (M0: 1, M1: 2, M2: 2.5, M3: 1.5, M4: 1).

## 8. Approval requested

1. The plan as scoped (M0–M4).
2. §2.1 — create the sixth `king-ai-ops-hub` workspace with the $100 budget? **yes / no**
3. §5 — Objectives dark-schema-now / product-vertical-Sprint-4 split.

On approval, work starts at M0 the same session. Budgets, agent model
switches, and the workspace change land in M1 and are reported with evidence.
