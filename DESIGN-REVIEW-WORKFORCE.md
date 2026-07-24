# Design Review — AI Workforce Management Platform

> Requested by the Executive Product Direction Update (2026-07-24). Review
> only; nothing here is implemented. Inputs: ARCHITECTURE.md, DECISIONS.md
> (D-001…D-014), OBJECTIVES.md, KNOWLEDGE.md, AGENT_CATALOG.md, TEAM.md,
> SPRINT-03-PLAN.md, and the current schema (migrations 0000–0002).

## Verdict up front

The vision is a **vocabulary and UX evolution, not an architecture change**.
Roughly 80% of what "AI Workforce Management" needs already exists under
different names, most of it decided in D-010 through D-014 after the last CTO
review. The remaining 20% is additive: new columns, two new tables, and a
re-centered task form. Nothing in the engine, the security model, or the data
model fights this direction — the platform was accidentally-on-purpose built
for it. One element of the proposed hierarchy deserves a pushback (§6).

## 1. What already supports this vision

| Vision concept | Existing mechanism | Gap |
|---|---|---|
| Employee | `agents` table: name, role, provider, model, system prompt, sampling, enabled, per-project | Missing: title, department, responsibilities, reporting line — all additive columns |
| "Provider is an implementation detail" | Already true below the UI: the engine consumes an `EngineAgent`; nothing in orchestration knows or cares which vendor until the adapter registry resolves it | The **task form** is the one place users pick a vendor — this is the gap to close |
| Departments | **Decided** (D-012), catalog already organized by department, schema landing in Sprint 3 M4 | Not yet in the DB; M4 should ship it as a table, not an enum (§4) |
| Company → Project | `organizations` → `projects` — the top of the proposed hierarchy has existed since migration 0000 | None. "Company" is `organizations` wearing a suit |
| Objectives as highest business concept | **Decided** (D-010); OBJECTIVES.md specifies the schema; M4 ships it dark | UI in Sprint 4 as planned |
| Knowledge, consulted before work | **Decided** (D-011); KNOWLEDGE.md specifies the system; and the behavior already runs: `loadApprovedContext()` injects the project's approved knowledge into every prompt today | The full versioned knowledge store is future work, but the *consult-before-work* invariant is live now |
| Responsibilities | AGENT_CATALOG.md documents purpose/responsibilities/escalation per agent in prose | Structuring them onto the employee row is one `text[]` column when needed |
| Performance metrics | Raw material fully recorded: per-step verdicts (`run_steps`), per-step cost (`usage_events`), immutable transcripts | Metrics are derived reads — views/queries, no new write path |
| Workload | `tasks`/`runs` already attribute work to agents via `primary_agent_id` / `reviewer_agent_id` | A count over existing data |
| "Managing a company" feel | TEAM.md authority matrix, approval gates, audit trail — the *accountability* half of workforce management is the part that's hardest to retrofit, and it's done | Presentation |

## 2. What would eventually be needed (smallest set, in order)

1. **Employees are `agents` plus columns — not a new table.** Add, over time:
   `title` (text), `department_id` (FK), `responsibilities` (text[]),
   `reports_to` (self-FK, nullable). Keep the DB name `agents`; present
   "Employee" in the UI. A rename buys nothing but migration risk; the word is
   a presentation concern.
2. **`departments` as an org-scoped reference table** (id, org_id, key, name),
   seeded with the eight standard departments, FK from agents. A table (vs the
   enum planned in M4) because the vision explicitly grows the list (Sales,
   Legal, Research…) and custom departments are inevitable in a workforce
   product. This is the only M4 change (§5).
3. **Assignee-first task creation.** The form's question becomes "Who should
   perform this work?" — a picker of employees (grouped by department),
   replacing the provider radio. `provider_selection` stays as a derived,
   stored fact (it drives D-005 cross-vendor review pairing); the user just
   stops seeing it. The flagship tier toggle survives as an escalation choice
   ("assign the senior version of this role"), keeping D-014's
   attribution requirement intact.
4. **Knowledge tables** per KNOWLEDGE.md §Schema, scoped org/project/
   department/employee, versioned, human-curated. `project_context_items`
   migrates in as the first knowledge kind. (Scheduled work, not soon —
   the runtime behavior it governs already exists.)
5. **Derived metrics views** — approval-rate-as-reviewer,
   revision-rate-as-primary, cost-per-employee, open-workload — computed from
   `run_steps` + `usage_events`. No schema change at all.

Explicitly **not** needed: engine changes (an "employee performing work" IS an
`EngineAgent` — same shape, richer provenance), provider changes, tenancy
changes, approval changes.

## 3. What should remain unchanged

- **The orchestration engine and its bounds** (D-006). It becomes the payroll
  system nobody looks at: employees are assigned, the engine executes. Its
  invisibility to users is a UX statement, not a code change.
- **Provider adapters and the `AIProvider` contract** — the vision *increases*
  their value: "the provider simply supplies the intelligence" is D-003/D-005
  restated.
- **Tenant isolation (I1), approval gates (I4), audit (I6), budgets (I8).**
  Workforce framing raises the stakes on all four (an "employee" that leaks
  context or acts unapproved is a fireable offense with a UI now).
- **`agents` as the physical table** under the Employee presentation (§2.1).
- **All 17 existing documents** — TEAM.md, AGENT_CATALOG.md, OBJECTIVES.md,
  KNOWLEDGE.md already speak this language; they need a terminology pass
  ("agent" → "employee") at the Workforce UX sprint, not rewrites.

## 4. Roadmap movements

| Item | Was | Becomes | Why |
|---|---|---|---|
| Departments schema (M4) | pg enum + column | **org-scoped table + FK** | Vision grows the list; enum→table later is a worse migration than table now. ~1 session of extra M4 work |
| ONBOARDING.md (M4) | FTUX spec, task-centric vocabulary | Same spec, **workforce vocabulary** ("meet your team", "assign work") | Costs nothing now; re-specing later costs a sprint |
| Phase 2.5 (Objectives UI, Sprint 4) | as planned | unchanged | Already objective-first (D-010) |
| **New: Phase 2.75 — Workforce UX (Sprint 5)** | — | Employee vocabulary throughout; assignee-first task form; employee profile pages with derived metrics; departments UI | The visible half of this vision, one contained sprint |
| Knowledge system | "future" in KNOWLEDGE.md | scheduled as Phase 4.5, after artifacts, before MCP | Employees consulting knowledge is load-bearing for the vision; artifacts feed it (promotion rule) |
| Phase 3 (executors), Phase 5 (MCP), Phase 6 (repos) | as planned | shift one phase later | No dependency changes |

## 5. Does this change Sprint 3?

**Two small adjustments; everything else proceeds as approved.**

1. **M4 departments: table instead of enum.** Same milestone, slightly larger
   migration, still dark (no UI). This is the single schema decision where
   doing what was planned would create rework.
2. **ONBOARDING.md written in workforce vocabulary.** The spec was already an
   M4 deliverable; only its language changes.

Unchanged: M3 entirely (transcripts, relink fix, doc one-liners, login UX);
M4's objectives/milestones schema; all completed work (M0–M2). Nothing done so
far is invalidated — notably, the model-tier machinery (D-014) becomes the
"seniority" mechanism, and the review-value metric becomes the first employee
performance metric. Sprint 3's exit criteria stand as written.

## 6. One respectful pushback: Employee is not a containment level

The proposed hierarchy places Employee *above* Objective:

```
Company → Project → Department → Employee → Objective → Milestone → Task → Run
```

Strict containment there means an objective belongs to one employee, and an
employee belongs to one department, so cross-functional objectives ("Launch
AccurateBids Beta" needs Engineering + Marketing + Finance) either fragment
into per-employee shards or force ownership fictions. That's also not how the
organizations this models actually work: objectives belong to the *business*;
people are *assigned* to them.

**Recommendation:** keep the containment chain as decided in D-010 —

```
Company → Project → Objective → Milestone → Task → Run
```

— and make **Department → Employee an assignment dimension across it**: every
task (and later, milestone) has an assigned employee; every employee has a
department; objectives get a *sponsoring* department and an accountable
employee as attributes, not parents. Same information, no fragmentation, and
OBJECTIVES.md §Schema survives verbatim (it already models `tasks.assignee`
this way). If the strict containment reading was intentional, this needs an
explicit executive decision before the Sprint 4 Objectives UI — it changes
the schema.

## Summary for the decision log (proposed D-015, recorded on approval)

*The platform presents itself as an AI workforce: users assign work to
employees organized in departments; providers and models are implementation
details resolved per employee. Physically, employees are the existing `agents`
table progressively enriched; the engine, providers, tenancy, approvals, and
audit are unchanged. Department/Employee is an assignment dimension over the
objective hierarchy, not a containment level within it.*
