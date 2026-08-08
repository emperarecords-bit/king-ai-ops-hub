# Phase 3 executor foundation exit

Date: 2026-08-08  
Starting protected main: `d61d2058c39fc2970b37423939175a482459430e`  
Scope: repository-only, non-live executor foundation. No provider, broker, filesystem action, Git action, database mutation, deployment, credential, external account, staging, or production operation.

## Roadmap verification

Protected-main `ROADMAP.md` defines Phase 3 as **Approval executors**: a single `executeApprovedAction()` choke point, payload-hash/approval revalidation, dry-run previews, rollback/audit records, and eventual executors in the order `file_write`, Git, database mutation, deployment. The foundation implements the safety boundary and a no-op `file_write` preview only. It does not claim the roadmap’s eventual real sandboxed `file_write` exit criterion.

## Foundation result

**PHASE 3 FOUNDATION COMPLETE.**

- Closed typed action, capability, risk, authorization, confirmation, idempotency, correlation, result, reconciliation, and provenance contracts exist.
- Capabilities declare `enabledByDefault: false`; dispatch defaults to no enabled executor.
- `noop_dry_run` is the only runnable implementation. It validates the full contract and deterministically reports `not_executed`; it has no side-effect authority.
- Trusted server-only dispatch re-reads the tenant-scoped approval/task, requires admin authority, approved/unexpired state, canonical payload-hash match, allowed risk/action/mode, explicit enablement, and fresh payload-bound confirmation.
- Live mode, prohibited risks/actions, unknown/malformed fields, tenant mismatch, and missing authority fail closed.
- Idempotency is claimed durably in append-only `audit_logs` while holding the existing per-organization transaction advisory lock. Duplicate keys cannot race past the claim.
- Every parsed attempt emits bounded append-only evidence. Intent/result records contain identifiers, hashes, decisions, risk/mode/outcome, and reconciliation state, not full payloads or secrets.
- Result provenance is checked against the trusted action. Ambiguous outcomes require reconciliation and forbid retry.
- Model text remains proposal data; orchestration and client components do not import dispatch. UI is status/preview-only and contains no execution form or button.

## Risk policy

| Risk class | Foundation behavior |
|---|---|
| Read-only | Representable; no live executor. |
| Reversible internal write | `file_write` contract preview through no-op only; no filesystem write. |
| External reversible | Prohibited. |
| Financial or regulated | Prohibited. |
| Destructive or irreversible | Prohibited. |

## Test evidence

Focused suites cover: unauthorized execution, cross-workspace execution, malformed action/request, unknown executor/action/risk, disabled executor, duplicate idempotency, missing/stale confirmation, forged client authority, model prompt direct-execution attempt, timeout/ambiguous result, fake `not_executed`, retry after ambiguity prohibition, deterministic dry-run success, audit payload minimization, client import boundary, and live-mode rejection.

The PR quality gate includes typecheck, lint, production build, secret scan, focused tests, and protected CI’s security, migration-integrity, static-analysis, fresh-current database, and accepted-legacy database profiles.

## Schema decision

No migration was required. Existing approval payload/hash/state plus append-only audit detail and its transaction advisory lock are sufficient for this dry-run foundation’s durable intent/result evidence and race-safe idempotency claim. A future side-effecting executor may require a dedicated execution/rollback/reconciliation table; that decision must return for owner approval before migration SQL is generated.

## Remaining owner decisions and roadmap work

- Approve the first real executor’s sandbox technology, workspace-root identity, path/symlink policy, resource limits, kill switch, and rollback record.
- Approve confirmation freshness, executor enablement/config custody, operator roles, and incident/reconciliation ownership.
- Decide whether future live execution needs a dedicated schema for lifecycle uniqueness, rollback, leases, and reconciliation.
- Threat-model and rehearse each executor separately. Git, database, deployment, email/social, HTTP, financial, destructive, broker, and paid-provider capabilities remain prohibited.

No live executor capability was enabled.
