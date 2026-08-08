# Phase 3 executor threat model

**Status:** Accepted for the non-live foundation  
**Date:** 2026-08-08  
**Decision:** establish a typed, server-only, off-by-default executor boundary before any side-effecting implementation.

## Existing boundary

- Model text can only propose a closed `ActionType` through `extractProposedActions`; malformed or unknown proposals are discarded.
- Proposals are stored in tenant-scoped approval rows with canonical payload hashes. Approval authorizes but does not execute.
- `requireTenant` constructs trusted user/org/project/role context; database queries also scope org/project and use RLS.
- `writeAudit` appends hash-chained, tenant-associated events. Existing executor eligibility is authoritatively empty.
- There is no `executeApprovedAction`, external executor, live broker adapter, or browser/client execution path.

## Trusted path

Model proposal → hostile-text parse → closed action schema → stored approval/payload hash → human decision → trusted server context → approval re-read → executor capability resolution → policy/idempotency decision → intent audit → dry-run dispatch → result audit.

Model output and browser input are data only. Neither may supply trusted authorization, capability registration, execution identity, risk policy, or an approval state.

## Risk classes

| Class | Examples | Foundation policy |
|---|---|---|
| Read-only | bounded internal lookup or validation | Contract may represent; no live executor in this foundation. |
| Reversible internal write | workspace-scoped file draft | Dry-run preview only. No filesystem write. |
| External reversible | branch/PR, email draft publication | Prohibited. |
| Financial or regulated | payment, trade, regulated-data mutation | Prohibited. |
| Destructive or irreversible | deletion, deploy, direct push, irreversible mutation | Prohibited. |

The only runnable reference implementation is `noop_dry_run`, declared for a `file_write` preview classified as `reversible_internal_write`. It has no filesystem, network, provider, credential, broker, database, or deployment capability.

## Threats and required controls

| Threat | Control |
|---|---|
| Prompt injection/direct model execution | Model output remains untrusted proposal data; trusted dispatch is a separate server-only path. |
| Forged browser request | Server reconstructs tenant/actor context and re-reads the approval; client fields never establish authority. |
| Cross-workspace object ID | Approval, task, actor, action, and execution scope must agree with trusted org/project context. |
| Payload substitution | Recompute canonical payload hash and compare with the immutable approved hash and confirmation binding. |
| Capability confusion | Closed registry; exact executor/action/risk/mode match; unknown values fail closed. |
| Stale or absent consent | Require approved, unexpired authorization and fresh payload-bound confirmation where policy requires it. |
| Duplicate consequence | Require an idempotency key and durable same-scope claim before dispatch; unsafe duplicates are blocked. |
| Timeout/unknown provider state | Never report success; mark ambiguous, require reconciliation, and prohibit automatic retry. |
| Fake `not_executed` result | Only trusted registered executor results are accepted and wrapped with server-created provenance/audit facts. |
| Audit leakage/tampering | Store bounded hashes/identifiers and decisions, not secrets or full sensitive payloads, in append-only audit. |

## Authorization and confirmation

The dispatch path must require an authenticated actor with project-admin execution authority, matching org/project scope, an approved and unexpired row, matching action type and canonical payload hash, a registered and explicitly enabled executor, an allowed risk class/mode, and a unique idempotency key. Consequential classes require a fresh confirmation bound to the same payload hash. Foundation policy rejects every live mode.

## Retry and reconciliation

Validation/policy rejection is safe to correct and resubmit with a new legitimate request. A dispatched result that could have reached an external system is never automatically retried when its outcome is unknown. It becomes `ambiguous`, `reconciliation = required`, and the idempotency key stays consumed until an authorized reconciler proves the result. Although the no-op cannot create an ambiguous provider result, the contract represents it so future executors cannot collapse ambiguity into failure or success.

## Storage decision

No migration is required for PR A. The contract and no-op are pure. PR B will first use existing append-only `audit_logs` for durable attempted-execution evidence and evaluate whether its bounded detail plus approval identity can safely enforce idempotency. If safe durable uniqueness cannot be proven with current storage, work stops for the required schema decision memo before any migration is generated.

## Deferred/prohibited

Real `file_write`, Git, database, deployment, email/social, HTTP, financial, destructive, broker, paid-provider, and production/staging executors are prohibited. Enabling a capability, adding credentials, provisioning infrastructure, or relaxing live-mode rejection requires a new threat model, owner approval, and dedicated rehearsal.

