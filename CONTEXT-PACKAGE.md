# Context Package Assembly (O-14)

> How the prompt's context is assembled before a run. Retrieval (D-020) is
> unchanged; this document describes the layer *above* it that builds a
> balanced package and records why each part was included.

## Purpose

Retrieval alone returns the highest-ranked task-specific chunks. For "Review
Episode 1 for continuity" that correctly fills every slot with Episode 1
material — but a continuity review should also honour established canon
(Character Bible, Story Bible) that relevance ranking crowds out. The context
package reserves room for foundational references and records the provenance
of the whole assembly.

## Scope

- **In:** deterministic assembly of Objective + Charter + Retrieved + Core
  reference + Production status; a provenance manifest; the "Context used"
  panel.
- **Out (unchanged):** ranking and indexing (D-020), the `AIProvider`
  interface, tenant isolation (I1), the approval gate. No embeddings, no
  vector search.

## The sources

Assembled in `startRun` ([src/domain/tasks/runner.ts](src/domain/tasks/runner.ts)),
in this order. Sources 1–5 are **documents & knowledge** (O-14); 6–10 are
**operational state from Hub records** (O-15) — structured facts about work,
never inferred from documents.

| # | Source | Always? | Origin | How selected |
|---|--------|---------|--------|--------------|
| 1 | **Objective** | when the task has one | `loadObjectiveForRun` | The attached objective's title, description, open criteria — injected as owner intent (O-9). |
| 2 | **Charter** | yes | `loadApprovedContext` | Every `active` knowledge item for the workspace (the auto-provisioned charter plus any curated knowledge). |
| 3 | **Retrieved by relevance** | yes | `retrieveRelevant` (D-020) | Top-K task-specific chunks. **Unchanged.** |
| 4 | **Core reference (quota)** | up to 2 | `selectCoreReferences` | Foundational docs by filename, in priority order, **deduped** against #3. |
| 5 | **Production status** | if present | `selectProductionStatus` | The workspace's production-status doc, deduped against #3–4. |
| 6 | **Objective progress** | when the task has an objective | `selectObjectiveProgress` | The objective's status, criteria-met count, and attached-task completion. |
| 7 | **Active work** | if any | `selectRelatedTasks` | `running` + `pending` tasks, objective-attached first, bounded to 5. |
| 8 | **Blockers** | if any | `selectRelatedTasks` | `failed` (with error) + `awaiting_approval` (blocked on a human) tasks, bounded to 5. |
| 9 | **Recent outcomes** | if any | `selectRelatedTasks` | `completed` tasks with a **summarized** result (240 chars, never the full transcript), bounded to 5. |
| 10 | **Pending reviews** | if any | `selectPendingReviews` | `pending` rows in `approvals`, bounded to 5. |
| 11 | **Task dependency graph** | if any edges | `assembleTaskGraph` | Bounded neighborhood of explicit task dependencies (O-18). |
| 12 | **Decision memory** | if any accepted | `assembleDecisionMemory` | Accepted organizational decisions, ranked + bounded (O-19). |

### Decision memory (O-19)

A first-class `decisions` entity — approved operational or creative conclusions
the org remembers across tasks. **Not** conversation history, **not** document
retrieval: a new Level-1 source parallel to project state and the dependency
graph. Only structured memory is stored (title, summary, rationale, supporting
refs, originating task/run, author, type, status) — never prompts or
transcripts.

**Lifecycle:** `proposed` → `accepted` (human approval) → optionally
`superseded`; or `rejected`. Decisions are never auto-created — a human files a
candidate and an admin approves it
([src/domain/decisions/decisions.ts](src/domain/decisions/decisions.ts),
Decisions screen).

**Selection** (`selectRelevantDecisions`): only `accepted` decisions, bounded to
**10**, ranked deterministically by (1) same originating task, (2) same
objective's tasks, (3) shared document reference, (4) recency. Superseded
decisions are never retrieved, so they can never outrank their replacement; when
a retained decision superseded an earlier one, the block names the old one as
*historical — do not apply*, satisfying "acknowledged only as historical."

**Prompt:** the Level-1 block instructs the model not to contradict an accepted
decision and to say so explicitly if a proposal would overturn one. Manifest
entries carry title · status · originating task · date, persisted in
`context_manifest` and shown in the Context used panel.

### Suggestions vs. accepted memory (O-20)

Completed runs may *suggest* decision candidates, but **a suggestion is not
organizational memory** — only an `accepted` Decision is Level-1 context. The
distinction is first-class:

| Kind | `status` | `suggested_by_run_id` | In Decision Memory? |
|---|---|---|---|
| AI suggestion | `proposed` | set | **No** |
| Human-filed proposal | `proposed` | null | No |
| Accepted decision | `accepted` | either | **Yes** |
| Superseded decision | `superseded` | — | No (historical) |
| Rejected decision | `rejected` | — | No |

After a run reaches `completed`, a **separate, bounded, one-shot** extraction
step ([src/domain/decisions/extraction.ts](src/domain/decisions/extraction.ts))
runs ONE structured call on the *primary* provider, returning strict JSON of at
most 3 candidates (zero is expected and valid). Each is validated server-side
against the run's provenance — supporting document refs must resolve to the
context manifest, a supersession target must be a real accepted decision,
duplicates of accepted decisions are suppressed. Valid candidates are saved
`proposed` with `suggested_by_run_id`, `suggestion_confidence`, and an evidence
statement, and surface in a **Suggested decisions** review queue on task detail
labeled *"AI suggestion — not an accepted decision."* An admin may accept,
edit-and-accept, reject, or defer; **only acceptance** activates O-19 memory.

Guarantees: the AI can never self-approve (the save path hardcodes `proposed`);
extraction is idempotent (`runs.candidate_extraction_status`); and extraction
failure never fails or rolls back the completed task. Accepted-decision ranking
(O-19) is unchanged.

### Task dependency graph (O-18)

Explicit, Hub-recorded workflow *structure* — never inferred. A single canonical
directed edge per row in `task_dependencies` (prerequisite → dependent); "blocked
by" / "successor" are the reverse reading, derived. Both endpoints carry
org_id + project_id (D-008), the pair is unique, and a self-edge is rejected by a
CHECK constraint.

`buildTaskGraph` ([src/domain/dependencies/dependencies.ts](src/domain/dependencies/dependencies.ts))
walks the neighborhood of the current task — direct prerequisites, direct
dependents, and siblings sharing a prerequisite — bounded to **depth 2 / 15
nodes**, and derives:

- **blockers** — incomplete prerequisites (task is BLOCKED until they finish);
- **unlocked on completion** — dependents whose only incomplete prerequisite is
  this task;
- **siblings** — tasks sharing a prerequisite (parallel work, *not* blocking);
- **critical incomplete chain** — longest chain of incomplete prerequisites;
- **cycle** — detected via Kahn's algorithm and *reported*, never recursed.
  `addDependency` also refuses an edge that would create a cycle (bounded
  forward-reachability check).

The graph is injected as a Level-1 Hub context block that states the
distinctions explicitly — "blocked because prerequisite incomplete" vs
"independent work" vs "no dependency information available" — and instructs the
model to respect order (never recommend work whose prerequisites are
incomplete). The manifest carries `{ nodeCount, edgeCount, rootTask, cycle }`,
shown in the Context used panel and persisted in `context_manifest`.

### Operational-state model (O-15)

No schema change — every field is derived from existing tables
([src/domain/state/project-state.ts](src/domain/state/project-state.ts)):

- A task's **operational class** comes from its `status`: `failed` /
  `awaiting_approval` → *blocker*; `running` / `pending` → *active work*;
  `completed` → *recent outcome*; `cancelled` → excluded.
- **Owner** is the latest run's primary agent (employee); `unassigned` when no
  run exists.
- **Objective relationship** is `this objective` / `other objective` /
  `unattached` from `tasks.objective_id`.
- **Blocker detail** is the failed run's error, or "awaiting human approval".
- **Outcome detail** is the run's consolidated result, whitespace-collapsed and
  truncated — full transcripts are never injected.
- **Priority** within bounds: blocked, then in-progress, then recently
  completed, then pending; objective-attached preferred within each group.

The five state sources are assembled into one **"Project state (Hub records)"**
text block plus per-record manifest entries, so the model reads current
structured status alongside the documents — and should not, for example,
recommend building a tracker the Hub already maintains.

### Core-reference priority (deterministic)

`CORE_REFERENCE_TYPES` in [documents.ts](src/domain/documents/documents.ts),
matched against the filename:

1. Character Bible — `/character[ _-]?bible/i`
2. Story Bible — `/story[ _-]?bible/i`
3. Dialogue Bible — `/dialogue[ _-]?bible/i`
4. Character Arc Tracker — `/character[ _-]?arc[ _-]?tracker/i`

The quota (default 2) takes the highest-priority matches not already
retrieved, one representative chunk (chunk 0, the overview) each. Production
status uses a deliberately specific `/production[ _-]?status/i` so an
unrelated file that merely ends in "status" is not mistaken for it.

## Dedup (requirement #3)

Each stage excludes paths already chosen by earlier stages: retrieval fills a
`seen` set, core references skip anything in it and add themselves, production
status skips both. A document is never represented twice.

## Isolation & provenance (requirement #4)

Every selection query is scoped by `org_id` + `project_id` and re-asserts
tenancy on each returned row (`assertTenant`), throwing `TenantViolationError`
on any mismatch — identical to `loadApprovedContext` and `retrieveRelevant`,
because all three feed the prompt. Tested: a workspace with no bibles returns
an empty core quota; the quota never crosses workspaces.

## Authority contract (O-16)

Assembling the right context is not enough — the model must know how to *weigh*
it. Without that, it sometimes discounted correct Hub state as "conversation
context" or "not a live tracker," weakening otherwise-right answers.

Each context item now carries an **authority tier**
([prompts.ts](src/orchestration/prompts.ts) `AUTHORITY`), the prompt groups the
context by tier under labeled headers, and the system prompt states a contract
for weighing them:

| Level | Tier | What it is | Rule |
|---|---|---|---|
| 1 | **Current Hub operational state** | objective status & criteria, task statuses, blockers, approvals, recent outcomes, owners, timestamps | The authoritative live snapshot for this run. Treated as present fact — never "conversational" or "hypothetical". |
| 2 | **Approved workspace controls** | charter, policies, approved knowledge | Authoritative for creative & procedural rules. |
| 3 | **Linked project documents** | production files, scripts, canon, references | Useful, but may be out of date relative to Level 1. |
| 4 | **Historical outcomes** | prior evidence | Not automatically current. |
| — | **Model inference** | the model's own reasoning | Allowed, must be labeled inference, never overrides 1–4. |

**Conflict rules** (in the contract, enforced by the model, surfaced not
reconciled):

- Document (L3) says done, but Hub state (L1) shows the criterion/task
  incomplete → **Hub state is the current status**; state the conflict and
  recommend verifying/updating the Hub record — do not declare completion.
- Document conflicts with charter/canon (L2) on a creative rule → **charter/
  canon controls**; surface the conflict.
- Claim information is missing **only** when the specific field is genuinely
  absent — do not plead lack of access/current status when L1 state is present.

The contract does **not** loosen injection defense: every item is still wrapped
`<untrusted-context>` and is data, never instructions (SECURITY.md T2).
Authority is operational trust (which fact is current); injection-trust
(whether content may issue commands) is separate and unchanged.

The runner tags each source: project state → L1 (with a run timestamp),
approved knowledge → L2, all documents → L3.

## Freshness signals (O-17)

Authority decides which source *controls*; freshness explains *how current* the
evidence appears — a separate axis from authority, injection-trust, and
relevance. Each context item carries
([src/domain/context/freshness.ts](src/domain/context/freshness.ts)):

| Field | Meaning | Set from |
|---|---|---|
| `observedAt` | when the Hub assembled the item | run time |
| `sourceUpdatedAt` | source record's last update | objective/criterion/task update (Hub); indexed file mtime (documents) |
| `contentEffectiveAt` | explicit date the content states | conservative parser, only labeled patterns |
| `confidence` | high / medium / low / unknown | high = parsed effective date or Hub record; medium = file mtime; unknown = no date |
| `basis` | which timestamp was used | short deterministic note |

**The parser is deliberately conservative.** It accepts only *labeled* patterns
in the document header (`Status as of July 23, 2026`, `Last updated: 2026-07-23`,
`Effective date: 07/23/2026`). A bare year in prose, a file's creation time, and
the run clock are **never** treated as content-effective dates.

**Precomputed comparison.** When a production-status (operational-claim)
document is present with a usable date, the Hub precomputes the relationship
between Level-1 Hub state and that document — `hub_newer`, `document_newer`,
`same_date`, or `not_comparable` — and injects it as a "FRESHNESS COMPARISON"
note. The model uses it directly rather than parsing dates itself
(`buildPrimaryUserTurn`'s `freshnessComparison`).

**Authority is unchanged by freshness.** Even when the document appears newer,
Level-1 Hub state still controls operational status; the note then instructs the
model to recommend verifying the document and *updating the Hub* — never to
silently override it. When not comparable, the model applies the authority
hierarchy and does not treat file metadata as proof of currency.

Freshness is persisted per-record in `context_manifest` and shown compactly in
the Context used panel (updated date · effective date · confidence).

## The manifest (requirement #5)

Persisted to `runs.context_manifest` (migration 0008) as
`ContextManifestEntry[]`:

```ts
interface ContextManifestEntry {
  source: 'objective' | 'charter' | 'retrieved' | 'core_reference' | 'production_status';
  label: string;   // doc path, objective title, or knowledge title
  detail?: string; // 'chunk 0 · relevance 0.039' or the core-reference type
}
```

The task-detail **"Context used"** panel groups entries by `source` in the
canonical order, so a reader sees exactly why each document was in the prompt.
`runs.retrieved_documents` is still written (retrieval-only provenance); the
panel falls back to it for pre-O-14 runs.

## Extending it (the point of writing this down)

New context kinds slot in **without touching retrieval**: add a `ContextSource`
value, a selector that returns records (tenant-scoped + tenancy re-assertion), a
dedup/merge step in the runner's assembly, a manifest mapping, and a panel
label. **Project state (O-15) was added exactly this way** — proof the pattern
holds for non-document sources.

Still anticipated, same shape:

- **Task history** — prior runs on the same objective, beyond the recent-outcome
  summary (e.g. a decision timeline).
- **Cross-objective dependencies** — blockers owned by another objective.

None requires a change to ranking, indexing, or the provider interface.

## Related

[D-020 retrieval](src/domain/documents/documents.ts) ·
[OBSERVATIONS O-13](OBSERVATIONS.md) (the retrieval fix this builds on) ·
[ARCHITECTURE.md](ARCHITECTURE.md) · [SECURITY.md](SECURITY.md) (I1).
