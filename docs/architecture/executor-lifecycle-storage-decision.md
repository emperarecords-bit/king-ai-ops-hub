# Schema decision memo: executor lifecycle storage

**Status:** Proposed — migration required before any real executor  
**Date:** 2026-08-08  
**Constraint:** no migration SQL is created by this memo.

## Decision

Choose **Option B: dedicated execution records**. Existing `audit_logs`, `run_jobs`, and run checkpoints remain supporting evidence but are not the source of truth for a side effect.

Audit JSON was sufficient for no-op idempotency because dispatch and result were one database transaction with no external effect. A real sandbox call cannot safely hold the audit transaction across launch/write/reconciliation. JSON fields have no typed state machine or database uniqueness for scoped idempotency, leases, attempts, confirmation consumption, pre/postconditions, rollback, and reconciliation. `run_jobs` is coupled to model runs and its lease/retry semantics could repeat a consequential write. Reusing it would blur approval, model execution, and side-effect lifecycles.

## Options

| Dimension | A. Audit/job JSON | B. Dedicated execution records |
|---|---|---|
| Initial change | No migration | Migration and domain layer |
| Idempotency | Advisory/query convention | Database unique constraint |
| Lifecycle/querying | Untyped JSON scans | Typed state and indexed operational queues |
| Leases/attempts | Coupled to run jobs or custom JSON | Executor-specific lease/attempt rows |
| Reconciliation | Difficult to claim/coordinate | Explicit state, owner, deadline, observation |
| Audit integrity | Append-only evidence | Dedicated state plus append-only audit events |
| Compatibility | Lowest short-term work | Clean boundary for future executors |
| Failure risk | High once side effect leaves DB transaction | Lower; intent commits before dispatch |

## Proposed schema (no SQL)

### `executor_executions`

- `id uuid primary key`
- `org_id`, `project_id`, `approval_id`, nullable `task_id`, nullable `run_id`
- `executor_id`, `executor_version`, `action_type`, `risk_class`, `mode`
- `workspace_storage_id`, `normalized_target`, `target_collision_key`
- `payload_sha256`, `precondition_kind` (`absent|sha256`), nullable `precondition_sha256`, `desired_sha256`
- `confirmation_id`, `confirmation_sha256`, `confirmed_by`, `confirmation_expires_at`
- `actor_id`, `idempotency_key`, `correlation_id`
- `state`, `reconciliation_state`, nullable `reconciliation_owner`, nullable `reconcile_after`, nullable `reconciliation_deadline`
- nullable `result_code`, `result_detail` (bounded/redacted JSON), nullable `rollback_artifact_id`, nullable `rollback_sha256`
- `attempt_count`, `created_at`, `claimed_at`, `started_at`, `side_effect_checkpoint_at`, `completed_at`, `updated_at`, `version`

Constraints/indexes:

- unique `(org_id, project_id, idempotency_key)`;
- unique `confirmation_id` (single use);
- unique live target guard `(org_id, project_id, workspace_storage_id, target_collision_key)` for states that can write/reconcile;
- indexes on `(state, reconcile_after)`, `(org_id, project_id, created_at desc)`, `approval_id`, and `(workspace_storage_id, target_collision_key)`;
- checks for SHA-256 shape, live mode requiring confirmation, completion timestamps matching terminal states, ambiguity requiring reconciliation, and nonnegative attempt count.

### `executor_execution_attempts`

- `id uuid primary key`, `execution_id`, `attempt_number`
- `sandbox_id`, `sandbox_image_digest`, `workspace_mount_identity`
- `lease_token_hash`, `leased_by`, `lease_expires_at`
- `state`, `started_at`, `pre_write_checkpoint_at`, `atomic_install_checkpoint_at`, `finished_at`
- nullable `observed_precondition_sha256`, `observed_postcondition_sha256`, `temp_artifact_identity`
- nullable `exit_code`, `timeout_stage`, `result_detail` (bounded/redacted JSON), `created_at`

Constraints/indexes: unique `(execution_id, attempt_number)`; unique active lease per execution; indexes on `lease_expires_at` and `(state, lease_expires_at)`. Lease expiry never authorizes another write; it authorizes reconciliation only.

Append-only `audit_logs` continue to record requested/blocked/intent/claimed/checkpoint/result/reconciliation/enablement events, referencing `executor_executions.id`. They are evidence, not mutable state.

## State machine

`proposed → confirmed → claimed → sandbox_starting → precondition_verified → writing → verifying → succeeded`

Any pre-side-effect validation may become `blocked` or `definitely_not_executed`. From `sandbox_starting` onward, crash/timeout/audit uncertainty becomes `ambiguous → reconciling → reconciled_succeeded | reconciled_not_executed | manual_resolution_required`. `failed` is allowed only with proof no side effect occurred. Terminal records are immutable except append-only reconciliation annotations; rollback is a new linked execution, not a state rewind.

## Tenant isolation and authorization

Both tables carry `org_id` and `project_id`, composite foreign keys must keep approval/task/run/execution references in the same tenant, and RLS is enabled and forced. Ordinary workspace reads use tenant GUCs. Cross-workspace claim/reconciliation uses narrowly scoped `SECURITY DEFINER` functions owned by `app_system`, following the current job pattern; runtime roles receive execute-only grants, never BYPASSRLS/table-wide mutation.

## Compatibility, retention, and rollback

- Additive schema; current no-op/audit records remain readable and are not backfilled into fake executions.
- Dispatch remains dry-run/off until schema, RLS, domain state machine, and tests are deployed and separately enabled.
- Retain execution identity/state/audit for the approved business/security period; sensitive rollback bytes use separate encrypted object storage with shorter retention and deletion evidence.
- Application rollback can stop creating new rows while retaining the additive tables. Do not drop lifecycle records during rollback. Migration rollback is a later reviewed cleanup only after the feature is retired and evidence retention permits deletion.

## Authorization implication

This migration creates no authority by itself. Live dispatch additionally requires the multi-layer enablement and confirmation policy. Migration generation/merge requires explicit owner approval after accepting this memo.

