# Supabase approved-SQL — risk model & v1 decision (Phase 2C)

**Decision: Option B — validation / dry-run only. Live DML execution is NOT enabled in v1.**

This note settles the risk model *before* implementation, as required by the Phase 2C SQL kickoff
(issue #135). It is deliberately conservative: it does not choose a live path by assertion.

## The question

The dispatch choke point (`src/domain/execution/dispatch.ts`) permits execution only for the risk
classes `reversible_internal_write` and `external_reversible`. `destructive_irreversible` is blocked
by construction. The kickoff asks: can a single parameterized `INSERT`/`UPDATE`/`DELETE` against one
explicit linked-project table be *proven* reversible, so it could legitimately run live under
`external_reversible`? If not, ship validation/dry-run only rather than weakening the gate.

## Why generic reversibility cannot be proven here

A "compensating operation" (delete the inserted row / restore the pre-image / re-insert the deleted
row) does **not** generically restore the database to its prior state for an arbitrary external
Supabase table:

1. **Triggers / rules.** `BEFORE`/`AFTER` triggers and rewrite rules can perform *irreversible* side
   effects on the write (increment counters, write other tables, call `pg_notify`, enqueue jobs,
   call external services via extensions). Deleting the inserted row — or applying any compensating
   statement — fires triggers *again*; it does not undo the first firing.
2. **Foreign-key cascades.** `ON DELETE CASCADE` / `ON UPDATE CASCADE` can mutate rows in other
   tables that we never captured. A compensating op cannot restore rows it never saw.
3. **Sequences / identity / defaults.** `serial`/`identity` sequences and `DEFAULT` expressions
   (`now()`, `gen_random_uuid()`, `nextval`) advance and are not rolled back; a re-insert of a
   deleted row cannot reproduce the original generated values, and sequence state is permanently
   advanced.
4. **Generated / computed columns & partial state.** Generated columns and expression indexes may
   not round-trip through a naive pre-image restore.
5. **Concurrency.** Between the write and any later "rollback", other transactions may read or act on
   the intermediate state. Compensation is not atomic with the observers.
6. **No trusted topology.** The Hub reaches the project only through the Supabase Management API and
   does not hold a trusted, current view of the target table's triggers, rules, cascades, generated
   columns, or RLS. Without that, "this table has no irreversible side effects" is unprovable from
   the Hub's position, and a payload-supplied claim is not trustworthy.

Because at least one of these breaks reversibility for a general table, **the honest risk class of a
live DML mutation is `destructive_irreversible`** — the same class as the existing `db_mutation`
action type. Relabelling it `external_reversible` to pass the dispatch gate would be exactly the
"do not weaken the global destructive-risk policy" the kickoff forbids.

## What v1 ships instead (Option B)

- A real **parser/AST policy** (`pgsql-ast-parser`, allow-list, fail-closed) that accepts *only* a
  single `INSERT`/`UPDATE`/`DELETE` against one explicitly-named `schema.table`, with a mandatory
  `WHERE` for `UPDATE`/`DELETE`, and rejects everything else — multi-statement, CTEs, DDL
  (`CREATE/ALTER/DROP/TRUNCATE`), `GRANT/REVOKE/ROLE`, `EXTENSION/FUNCTION/TRIGGER/POLICY`,
  transaction control, `COPY`, `DO`, `CALL`, `SET`, `VACUUM/ANALYZE`, `LISTEN/NOTIFY`, temp objects,
  and comment-as-bypass. Rejection is by AST shape (and parse failure), never regex alone.
- A **validation / dry-run** surface that is strictly **side-effect-free and performs no Supabase
  network call** in v1: it runs the AST policy and resolves the target project against the
  workspace's links (offline). It reports the normalized statement, operation, target
  schema/table, mandatory-WHERE status, referenced parameters, the declared max-affected-rows
  ceiling, the risk class (`destructive_irreversible`), the rollback-evidence story, and —
  explicitly — `liveExecutionAvailable: false`. (A non-mutating `EXPLAIN`-based enrichment is
  deliberately deferred so dry-run never contacts the write-capable Management SQL endpoint.)
- **No live write path exists.** There is no `execute_supabase_sql` confirm action and no registered
  executor. The action type `supabase_sql` is added (one additive enum migration) and classified
  `destructive_irreversible`, which the dispatch choke point blocks by construction — so even if a
  future change wired an executor and an approval of this type, live execution remains gated. A test
  asserts dispatch blocks a `supabase_sql` approval.

## The bar for a future Option A (live)

A later PR may enable a *narrow* live path only if it can prove reversibility for the specific target
before writing — e.g. by introspecting the target table (via a trusted read path) to establish it has
**no** triggers/rules, **no** cascading FKs touching it, **no** generated columns, and the predicate
selects rows by a **stable primary key** within a **bounded** row count, then capturing a full
pre-image and defining a **verified compensating operation** run under a statement timeout and
post-action verification. Only with that proof per action would `external_reversible` be honest. Until
then, live stays off and the global destructive-risk gate stays exactly as it is.
