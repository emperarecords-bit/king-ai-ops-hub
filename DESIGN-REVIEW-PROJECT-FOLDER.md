# Design Review — Workspace Project Folder (Retrieval-Augmented Context)

> Requested 2026-07-24. Review only; nothing here is built. This is the
> largest feature since the early sprints, it adds dependencies and one
> possible extension, and it has a genuine build/buy fork — so it enters the
> way workforce and K1 did: a short review and one decision before code.
> Grounded in the current code (context loader, knowledge schema, runner) and
> the live database (Postgres 17, no pgvector).

## Verdict up front

**~60% of this already exists**, and the isolation half — the dangerous half —
is done. What's missing is a document-ingestion layer and a retrieval step.
The smallest honest slice is buildable without a new AI provider, without new
per-file cost, and without leaving Postgres. There is one real decision for
you (§5), and one small gap the request assumes is already true but isn't (§3).

## 1. What already exists (and must not be rebuilt)

| Requirement | Already true |
|---|---|
| "Only retrieve from the current workspace — isolation" | `loadApprovedContext` (context.ts) is the highest-risk read in the system and already enforces I1 three ways: WHERE clause, RLS, and a per-row tenancy **re-assertion** that throws `TenantViolationError` on any mismatch. The new retrieval reuses this exact guard — isolation is not re-solved, it is inherited. |
| "Always include the workspace charter" | The charter is already an `active` knowledge item and is **already injected into every task** via `loadApprovedContext`. This requirement is met today. |
| "Searchable index instead of sending every file" | The `knowledge_items` model (versioned, scoped, status-gated) is the template; documents are a sibling table, not a redesign. |
| "Show which documents were retrieved" | `run_steps` + the task-detail Review-panel pattern already render per-step provenance; retrieved docs render the same way. |

So the isolation invariant, the charter injection, the transparency surface,
and the injection point in the runner are all in place. This feature is
**additive plumbing into a socket that already exists**, not a new subsystem.

## 2. What's genuinely new

1. **Documents + chunks tables.** `documents` (one row per file: path, kind,
   sha256, size, indexed_at, status) and `document_chunks` (the searchable
   unit: text + a Postgres `tsvector`). Both carry `org_id`+`project_id`
   `NOT NULL` per D-008, both get RLS, both join the every-table RLS test.
2. **An ingestion step.** Read a folder, parse supported files to text, split
   into chunks, compute `tsvector`, store. Re-runnable: a file whose sha256 is
   unchanged is skipped; changed files re-chunk; deleted files archive. This
   is "refresh when files change."
3. **A retrieval step in the runner.** Before the primary call, run the task
   text as a `tsquery` against this project's chunks, take top-K by `ts_rank`,
   and inject them alongside the always-present charter — inside the existing
   `<untrusted-context>` delimiters, because a project file is exactly the
   prompt-injection surface SECURITY.md T2 describes.
4. **A documents screen + the retrieved-docs list on task detail.**

## 3. The gap the request assumes is already closed — it isn't

> "Always include … the selected objective in the task context."

Tasks can attach to an objective (D-010), but **the objective is not injected
into the prompt today** — the runner loads knowledge and task input, not the
task's objective. This is a ~15-line fix (load the attached objective, prepend
its title + description + open criteria as a context block) and it is worth
doing regardless of the rest, because an employee working a task blind to its
objective is the exact disconnect O-9 measured. Recommend folding it into
slice 1.

## 4. Isolation & safety analysis (the part that must be right)

- **Retrieval reuses `loadApprovedContext`'s guard verbatim** — same
  WHERE+RLS+re-assertion. A document chunk from another project surfacing in a
  query is caught by the same fire alarm that guards knowledge.
- **Files are untrusted input.** Parsed document text enters the prompt inside
  `<untrusted-context>` and is stripped of delimiter-spoofing exactly as
  context is today. A PDF that says "ignore your instructions" is data, and
  the no-execution invariant (I4) means the worst it can do is get retrieved.
- **No new egress.** Full-text search is in-database; nothing about indexing
  or retrieval calls a model or an external service (see §5). Ingestion reads
  files the owner explicitly linked; it never crawls outside a linked folder.
- **Storage.** Slice 1 indexes files from a **local folder path** the owner
  links. It stores extracted *text and a hash*, not the binary — so no secret
  file content lands in a blob store, and re-index re-reads from source. (A
  later slice can add Supabase Storage upload; not needed to prove the value.)

## 5. The one real decision: how to rank relevance

| | **A — Postgres full-text (recommended)** | **B — Vector embeddings** |
|---|---|---|
| New dependency | none (built into PG 17) | `pgvector` extension **+** an embedding provider |
| Per-file cost | $0 | an embedding call per chunk, per re-index |
| Per-query cost | $0 | an embedding call per task |
| Determinism | exact, explainable ranking (`ts_rank`) | opaque similarity; harder to show *why* a doc matched |
| Relevance quality | good for keyword/term overlap; weaker on paraphrase | stronger semantic match |
| Fits platform ethos | D-018 (no unverifiable dependencies), insights-determinism, cost-consciousness | adds exactly the unverifiable, metered dependency the platform has avoided |

**Recommendation: A.** It satisfies the literal request ("a searchable index
instead of sending every file") with zero new provider, zero per-token cost,
transparent ranking you can show the user, and it stays inside the Postgres
you already back up nightly. Embeddings are a real upgrade in relevance and a
clean **slice 2** — the `document_chunks` table can gain a nullable `embedding`
column later without disturbing anything, so choosing A now does not foreclose
B. Choosing A is reversible; choosing B commits a dependency and a cost line
before we know the feature earns its keep (which is the whole point of the
validation period we're in).

## 6. File-type scope for slice 1

| Type | Slice 1 | Why |
|---|---|---|
| `.md`, `.txt` | ✅ | zero new dependencies; proves the whole pipeline end to end |
| `.pdf`, `.docx` | slice 1.5 | each needs a parser dependency (`pdf-parse`, `mammoth`); real, but they're leaf additions once the pipeline exists. Splitting them out means slice 1 ships with no new npm dependencies at all. |

## 7. Recommended build plan

**Slice 1 — the pipeline, MD/TXT, full-text (no new dependencies):**
`documents` + `document_chunks` migration with RLS and tenancy-test coverage ·
link-a-folder + index action · retrieval in the runner (top-K by `ts_rank`,
injected as untrusted context) · objective injection (§3) · documents screen ·
retrieved-docs list on task detail · integration test proving a KodiScan query
cannot retrieve an AccurateBids chunk.

**Slice 1.5 — PDF/DOCX** (adds two parser deps behind the existing pipeline).

**Slice 2 — embeddings** (only if full-text relevance proves too weak in real
use — decided from evidence, not assumed).

Slice 1 is roughly a full sprint of work: it's a migration, an ingestion
pipeline, a change to the highest-risk code path in the system, and two
screens. It is not an hour's lifecycle fix, which is the other reason it gets
a review and an explicit go-ahead rather than a "yes start."

## 8. What I need from you

1. **Ranking method — A (Postgres full-text) or B (embeddings)?** I recommend
   A and can start immediately on it.
2. **Folder linking:** confirm slice 1 indexes a **local folder path** you
   provide per workspace (simplest, no upload UI, re-reads from source on
   refresh). Upload-based folders can come later.
3. **Break the freeze for this?** It's the largest build since Sprint 5. I'd
   treat slice 1 as its own short sprint rather than an in-freeze patch — but
   the objective-injection fix (§3) I'd do now regardless, since it's tiny and
   closes a measured gap.
