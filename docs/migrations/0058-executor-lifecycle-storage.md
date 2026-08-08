# 0058 executor lifecycle storage

Owner authorization: all recommendations in `docs/architecture/file-write-owner-decisions.md` accepted on 2026-08-08; authorization is limited to preparing this lifecycle migration PR.

## Purpose

Adds durable, tenant-scoped storage for a future consequential executor without implementing or enabling one:

- `executor_executions` is the lifecycle source of truth, with action/workspace/target identity, payload and pre/postcondition hashes, single-use confirmation, actor, scoped idempotency, typed state/reconciliation, result metadata, rollback references, and timestamps.
- `executor_execution_attempts` records sandbox identity, leases, checkpoints, observed hashes, timeout/exit metadata, and bounded results per attempt.

Database constraints enforce same-tenant approval/task/run/execution references, scoped idempotency uniqueness, globally single-use confirmations, one active target per workspace, one active attempt per execution, valid states/risk/mode/preconditions/hashes, and ambiguity requiring reconciliation.

Both tables receive forced `(org_id, project_id)` RLS through `src/db/rls.sql`. `app_server` receives select/insert/update only; no delete grant or cross-tenant claim function is introduced. `app_system` receives no new table grant in this migration.

## Compatibility and data handling

The migration is additive. Existing approvals, tasks, runs, no-op audit events, and executor contracts are not rewritten. It adds tenant composite unique constraints to `approvals`, `tasks`, and `runs` solely as referenced keys for the new same-tenant foreign keys.

No existing record is backfilled into a synthetic execution. Audit logs remain append-only evidence and are not replaced by lifecycle storage.

## Authority boundary

This migration does **not**:

- register or implement a file writer;
- change `executeApprovedAction` live-mode rejection;
- enable an executor, workspace, environment, or kill switch;
- launch a sandbox or worker;
- access a filesystem, provider, broker, Fly, Tigris, staging, or production.

## Rollback

Application rollback is to stop reading/writing these new tables while retaining them and their evidence. A database rollback may drop the attempt table, then the execution table, then the three added composite unique constraints only after confirming no lifecycle records need retention and no application version references them. Dropping populated lifecycle tables destroys security/operational evidence and therefore requires a separate owner-approved retention decision; this PR intentionally provides no automatic down migration.
