# Production configuration specification

Specification only. Values in angle brackets are owner-supplied placeholders, not credentials. Completing this checklist does not authorize provisioning, secret creation, deployment, migration, or provider calls.

## Identity and infrastructure

| Setting | Required specification | Validation / owner decision |
|---|---|---|
| Production application identity | `APP_NAME=<production-app-name>`; canonical repository `emperarecords-bit/king-ai-ops-hub`; `APP_URL=https://<production-host>` | Must differ from staging; approve domain, region, account/project, machine topology, min/max web and worker counts |
| Database application | `TARGET_APPLICATION=<production-app-name>`; `DATABASE_NAME=<production-db-name>` | Must differ from staging/local and match receipt target |
| Database identity | `DATABASE_SYSTEM_IDENTIFIER=<provider-verified-uint64>` | Read from target using approved operator channel; never guessed or copied from staging |
| Runtime DB URL | `DATABASE_URL=postgresql://app_server:<secret>@<host>/<db>` | `app_server` must be LOGIN, NOSUPERUSER, NOBYPASSRLS, non-owner; pool/SSL limits approved |
| Migration DB URL | `DATABASE_MIGRATION_URL=postgresql://<ddl-owner>:<secret>@<host>/<db>` | Available only to release command; never web/worker runtime |
| Source volume | `SOURCE_VOLUME_ID=<production-volume-or-provider-source-id>` | Bind backup/receipt to exact production source; must not equal staging volume |

## Backup and receipt gate

| Setting | Placeholder / policy | Required decision |
|---|---|---|
| Receipt base URL | `GBACKUP_RECEIPT_BASE_URL=https://<public-evidence-host>/<prefix>/` | HTTPS, anonymously readable, immutable object/version policy |
| Receipt host allowlist | `GBACKUP_RECEIPT_ALLOWED_HOSTS=<exact-host[,exact-host]>` | Exact hosts only; no wildcard, credentials, IP literals, redirects to unlisted hosts, or query-token dependency |
| Signing environment | GitHub Environment `<production-signing-environment>` | Required reviewers, branch restrictions, no fork execution, least-privilege secret access |
| Signing key ID | `GBACKUP_KEY_ID=<production-key-id>` | Unique, non-staging, rotation/revocation convention and custodian approved |
| Signing key | `GBACKUP_RECEIPT_SIGNING_KEY_B64=<secret>` | Secret store only; never workflow input, log, artifact, repository, or local handoff |
| Trust bundle | `GBACKUP_RECEIPT_TRUST_BUNDLE_JSON=<public-json>` | Reviewed public key/purpose/key ID; separate trust-change review before use |
| Backup retention | `BACKUP_RETENTION_DAYS=<approved-integer>` | Meet receipt self-verification minimum plus RPO/legal/business retention |
| Snapshot age | `GBACKUP_MAX_SNAPSHOT_AGE_SECONDS=<approved-integer>` | Derived from measured backup/deploy duration; never relaxed during incident |
| Receipt age | `GBACKUP_MAX_RECEIPT_AGE_SECONDS=<approved-integer>` | Bounded release window; expired receipts are replaced, never edited |

## Authentication and web security

| Setting | Placeholder / policy | Required decision |
|---|---|---|
| Supabase URL | `NEXT_PUBLIC_SUPABASE_URL=https://<production-project>.supabase.co` | Dedicated production project |
| Publishable key | `NEXT_PUBLIC_SUPABASE_ANON_KEY=<publishable-key>` | Public by design; still supplied via approved configuration |
| Site URL | `https://<production-host>` | Exact origin, HTTPS only |
| Redirect allowlist | `https://<production-host>/auth/**` plus exact required callback paths | Remove localhost/staging/wildcards from production policy |
| Signup/email policy | `<closed-or-invite-only>`; `<verified-email-required>` | Open signup must be disabled before public exposure unless explicitly approved |
| MFA/session policy | `<mfa-policy>`; `<session-lifetime>`; `<refresh-policy>` | Owner/security approval |
| Cookies/TLS | Secure, HttpOnly auth cookies; SameSite policy from Supabase SSR; HTTPS/HSTS at edge | Verify real response headers and domain scope during rehearsal |
| CSP | Production nonce-based CSP from middleware | Verify no `unsafe-eval`; document any required external `connect-src` before adding |

## Scheduler, worker, storage, and controls

| Setting | Placeholder / policy | Required decision |
|---|---|---|
| Standing scheduler | `SCHEDULER_MECHANISM=<provider-cron>`; `SCHEDULER_CADENCE=<approved-cadence>` | Single logical tick, authenticated invocation, overlap policy, failure alert owner |
| Worker topology | `WORKER_MIN=<n>`; `WORKER_MAX=<n>`; `<cpu/memory>` | Begin at one until isolated multi-worker rehearsal; define queue/lease scale triggers |
| Object storage | `STORAGE_DRIVER=s3`; `S3_ENDPOINT=<https-url>`; `S3_REGION=<region>`; `S3_BUCKET=<production-bucket>` | Dedicated bucket/account, TLS, lifecycle/versioning, backup and outage policy |
| Object credentials | `S3_ACCESS_KEY_ID=<secret>`; `S3_SECRET_ACCESS_KEY=<secret>` | Secret store only, least privilege to exact bucket/prefix, rotation owner |
| Run rate limit | `RATE_LIMIT_RUNS_PER_MINUTE=<approved-positive-integer>` | Choose from load/provider/budget baseline; alert on sustained rejection/exhaustion |
| Timeouts/retries | `RUN_TIMEOUT_MS=<n>`; `PROVIDER_TIMEOUT_MS=<n>`; `PROVIDER_MAX_RETRIES=<n>` | Keep total run within lease; ambiguous outcomes never auto-retry |
| Spend limit | `DEFAULT_MONTHLY_SPEND_LIMIT_MICROS=<approved-integer>` | Business owner approval; alerts before hard block |
| Cleanup/retention | Production defaults or explicit `CLEANUP_QUIET_MS`, `PURGE_RETENTION_MS` | Never copy staging's shortened acceptance values |

## Health, logs, monitoring, and alerting

- Liveness: `GET /api/live`; dependency-free, expected 200 while web process runs.
- Readiness: `GET /api/health`; expected 200 only when database, migration compatibility, worker/backlog, and object storage are ready.
- Log destination: `LOG_DESTINATION=<owner-selected-service>`; `LOG_LEVEL=info`; JSON stdout ingestion; redact at source and destination; retention/access owner-approved.
- Required dashboards: web availability/latency/errors; readiness dependencies; worker restarts/heartbeat; queued/running/failed/reconciliation jobs; oldest queue and lease age; retry counts; provider failures; review verdict/parser counts; migration/gate failures; database/storage saturation.
- Alert destination: `ALERT_DESTINATION=<on-call-system>` with named primary/secondary recipients and SEV routing.
- Numeric thresholds, SLOs, paging windows, and retention are OWNER-GATED until baselines are measured and approved.

## Pre-provisioning approval record

The owner must sign off the exact non-secret identities, providers, regions, topology, RPO/RTO, retention, auth policy, scheduler, worker limits, monitoring destination, alert routes, thresholds, key custodians, and evidence location. Secret values are then entered directly into provider secret stores by authorized operators and never pasted into this checklist.
