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

## The five sources

Assembled in `startRun` ([src/domain/tasks/runner.ts](src/domain/tasks/runner.ts)),
in this order:

| # | Source | Always? | Origin | How selected |
|---|--------|---------|--------|--------------|
| 1 | **Objective** | when the task has one | `loadObjectiveForRun` | The attached objective's title, description, open criteria — injected as owner intent (O-9). |
| 2 | **Charter** | yes | `loadApprovedContext` | Every `active` knowledge item for the workspace (the auto-provisioned charter plus any curated knowledge). |
| 3 | **Retrieved by relevance** | yes | `retrieveRelevant` (D-020) | Top-K task-specific chunks. **Unchanged by this sprint.** |
| 4 | **Core reference (quota)** | up to 2 | `selectCoreReferences` | Foundational docs by filename, in priority order, **deduped** against #3. |
| 5 | **Production status** | if present | `selectProductionStatus` | The workspace's production-status doc, deduped against #3–4. |

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
value, a selector that returns chunks (tenant-scoped + `assertTenant`), a
dedup step in the runner's assembly, a manifest mapping, and a panel label.
Candidates already anticipated:

- **Project state** — open objectives, at-risk milestones for the workspace.
- **Task history** — prior runs on the same objective.
- **Approvals** — pending decisions relevant to the task.

Each is a new source in the same shape; none requires a change to ranking,
indexing, or the provider interface.

## Related

[D-020 retrieval](src/domain/documents/documents.ts) ·
[OBSERVATIONS O-13](OBSERVATIONS.md) (the retrieval fix this builds on) ·
[ARCHITECTURE.md](ARCHITECTURE.md) · [SECURITY.md](SECURITY.md) (I1).
