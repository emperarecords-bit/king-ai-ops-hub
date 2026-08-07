# Staging backup/restore rehearsal plan

Status: executable specification only. **Do not run without a separately approved change window.** This plan never restores into, migrates, or mutates the persistent staging database.

## Preconditions and stop conditions

- Owner names the IC, DB operator, application verifier, evidence location, approved window, RPO/RTO targets, and cleanup owner.
- Record staging app/image/source identity, database system identifier, migration endpoint/hash, expected tenant-safe aggregate counts, storage driver, and current health.
- Use a fresh backup created during the ceremony; never reuse an expired receipt as proof of freshness.
- Allocate a new isolated temporary database with a name/identity that cannot equal staging or production. Set `REQUIRE_DISPOSABLE_DB=1` where repository tools support it.
- Stop before backup or restore if any target identity is ambiguous, credentials are unavailable through the approved secret channel, staging is degraded, or cleanup cannot be guaranteed.
- Never print connection strings, secret values, customer payloads, private keys, or unrestricted table contents.

## Procedure

1. **Create backup (owner-gated).** Request a fresh provider snapshot or logical backup of staging. Record provider backup ID, requested/created timestamps, retention, stored size, staging DB system identifier, and operator.
2. **Verify source evidence.** Confirm backup belongs to the expected staging database and predates no required migration. If using the migration receipt flow, verify the receipt anonymously and record its canonical hash; do not expose signing material.
3. **Create isolated restore target (owner-gated).** Provision a temporary database in a non-production account/project or isolated cluster. Deny public access, use distinct credentials, and confirm its system identifier differs from staging/production.
4. **Restore.** Restore the fresh backup into the empty temporary target. Capture provider operation ID, start/end times, and exit status. Never use the persistent staging connection as a restore target.
5. **Schema verification.** Read only: verify migration journal count/endpoint through `0057`, expected tables/functions, `app_server` attributes, RLS enabled/policies present, and no migration is pending relative to the rehearsed source commit.
6. **Data/integrity verification.** Compare pre-approved aggregate counts for core tables, foreign-key/integrity checks, required audit/usage/run-step presence, and object metadata references. Do not export row bodies into evidence.
7. **Tenant-isolation verification.** Run the repository rollback-only RLS probe using the temporary target and approved roles. The probe must leave zero residue and must fail if the runtime role is privileged.
8. **Application compatibility.** Point an isolated, non-public application process built from the exact rehearsed immutable image at the temporary DB. Check `/api/live`, `/api/health`, login/session validation with a designated test account, tenant scoping, read-only task/history pages, queue diagnostics, and object-storage behavior. Do not enable schedulers, workers, paid providers, or live execution.
9. **Object-storage compatibility.** If the database references managed objects, use an isolated read-only test identity or a rehearsed bucket copy selected by the owner. Verify sampled metadata/hash consistency without mutating staging objects.
10. **Record result.** Produce a redacted evidence package containing identities/hashes, timings, aggregate comparisons, test results, deviations, and pass/fail decision.
11. **Cleanup (owner-gated).** Destroy the temporary app, database, credentials, and any temporary object copy using provider controls. Independently verify absence and close the evidence record. Never delete the source backup until its approved retention expires.

## Success criteria

- Correct source backup restored into a provably distinct temporary target.
- Restore completes within the owner-approved RTO and backup age meets RPO.
- Migration endpoint/hash, required schema/functions, RLS and role properties match expectations.
- Approved aggregate/integrity checks reconcile or have documented acceptable differences.
- Exact application image is live and ready against the restore without running migrations or external executions.
- Tenant-isolation probe passes and leaves no residue.
- Cleanup is independently verified and the redacted evidence package is retained.

Any unmet criterion is a failed rehearsal. A failed rehearsal blocks production launch until corrected and rerun; it does not authorize repairs against persistent staging.
