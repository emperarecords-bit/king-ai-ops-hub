# Operational incident runbooks

These procedures are decision support, not authority to mutate production. Commands that deploy, migrate, restore, rotate keys, change routing, or delete resources are **OWNER-GATED** and require the named incident commander (IC) and service owner approval.

## Common incident contract

1. Declare severity: SEV1 (service unavailable/data at risk), SEV2 (major workflow unavailable), SEV3 (limited degradation), or SEV4 (low impact).
2. Assign IC, operations lead, communications lead, and scribe. Use UTC timestamps and a 15-minute update cadence for SEV1/2.
3. Capture immutable facts: release image digest, source commit, migration endpoint/hash, receipt ID/hash/expiry, database identity, request/run/job IDs, first symptom, and current `/api/live` plus `/api/health` results. Never paste secrets, prompts, customer payloads, private keys, or full connection strings.
4. Stop immediately if target identity is ambiguous, the evidence conflicts, a required backup/receipt is absent, or an action would broaden impact. Escalate to the owner.
5. Prefer traffic stop or rollback of application code over ad-hoc database edits. Never down-migrate or restore over an existing database.
6. Resolution requires health recovery, key workflow verification, evidence retention, stakeholder update, and a blameless postmortem for SEV1/2.

## Scenario matrix

| Scenario | Detect / triage | Safe repository-informed response | Mandatory stop / owner gate | Resolution evidence |
|---|---|---|---|---|
| Deployment fails before migration | Release command did not begin; migration journal unchanged | Preserve logs and image digest; keep prior machines serving; correct configuration in a reviewed change | Stop if migration start cannot be disproved. Any redeploy is owner-gated | Prior version healthy; journal unchanged; failed release identified |
| Migration succeeds, rollout fails | Migration endpoint advanced; new machines unhealthy | Freeze deploys; confirm migration is additive/compatible; assess prior image against new schema; choose prior-image rollback or isolated restore | Never down-migrate. Restore or traffic changes require IC + DB owner | Endpoint/hash, compatibility decision, health and smoke results |
| Receipt gate rejection | `db:migrate` exits before DDL with receipt/gate code | Do not bypass. Verify anonymous receipt availability, signature/trust, target DB identity, source/image digest, nonce, age, and pending migration set | Any re-sign, trust update, new snapshot, or retry against persistent DB is owner-gated | Gate input comparison and successful independent verification |
| Stale/expired receipt | Gate reports time/retention failure | Create a new backup and receipt through the approved ceremony; never extend or edit an old receipt | Backup creation and signing are owner-gated | New snapshot/receipt identifiers and anonymous verification |
| Worker crash loop | Web live; queue grows; repeated `worker.fatal`/restart | Stop automatic restart churn if it threatens dependencies; correlate error class/job ID; reproduce with inert fixtures; roll back worker image if safe | Do not retry reconciliation-required jobs or expose payloads. Scale/rollback owner-gated | Stable worker, bounded oldest queue age, no duplicate execution |
| Queue backlog | queued/oldest age rises; worker activity absent or insufficient | Check worker health, leases, provider latency, DB saturation, and per-job failures; pause new scheduled intake if authorized | Do not bulk-edit queue rows. Scaling or scheduler pause is owner-gated | Queue drains, oldest age falls, failures categorized |
| Provider outage | provider errors/rejections rise; other dependencies healthy | Stop automatic retries beyond policy; preserve completed work; communicate affected provider/workflows | Never route to another paid provider or replay ambiguous calls without owner approval | Provider recovery, bounded canary, no duplicate charge |
| Ambiguous remote execution | run/job is `reconciliation_required` | Freeze that run; compare dispatch intent, checkpoint, provider request ID/usage if safely available; owner decides reconciliation | Absolute stop: no automatic retry, no rebill, no fabricated result | Written reconciliation decision linked to run/job IDs |
| Database outage | liveness healthy, readiness database false | Stop migrations and writes; preserve application/DB logs; determine provider status and recovery ETA; allow platform-managed recovery | Failover, restore, credential change, or manual SQL is owner/DB-owner gated | Connectivity, identity, migration endpoint, RLS probe, smoke test |
| Object-storage outage | readiness storage false; DB/web may remain healthy | Disable or defer ingestion/purge workflows operationally; keep indexed DB content available; assess provider outage | Never delete metadata or rewrite object keys. Credential/bucket/routing changes owner-gated | Probe healthy; upload/download/integrity canary passes |
| Compromised signing key | suspected key disclosure or unauthorized signature | Halt all gated migrations; preserve evidence; revoke signing access; prepare a new key/trust change in separate review | No migration or receipt signing until owner declares old key revoked and new trust active | Revocation timeline, new key ID/public trust, rotation review |
| Rollback | release regression with schema still compatible | Select prior immutable digest; verify its config and compatibility; define rollback triggers before action | Rollback is owner-gated. Stop if schema compatibility is uncertain | Prior digest running, health/smoke green, incident remains monitored |
| Restore from backup | corruption/loss or rollback cannot recover | Restore only into a new isolated target first; verify identity, schema, RLS, counts/integrity, application compatibility; then plan cutover | Never restore over source. Snapshot selection and cutover are owner/DB-owner gated | Backup provenance, restore logs, checks, cutover decision |

## Rollback triggers

Thresholds are OWNER-GATED until monitoring baselines are approved. At minimum, stop rollout on any migration-gate failure, database identity mismatch, failed readiness dependency, authentication/tenant-isolation regression, reconciliation spike, sustained worker crash loop, or critical user-flow failure. Do not invent numeric error/latency thresholds during an incident.

## Post-incident record

Record impact, UTC timeline, detection source, immutable release identities, root cause and contributing controls, customer communications, recovery evidence, and action items with owner/due date. Evidence retention location and duration remain owner-gated production configuration decisions.
