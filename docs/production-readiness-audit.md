# Production-readiness gap audit

Audit date: 2026-08-07  
Repository baseline: protected main `41ce96b3277c4f45c46d20a99f85b5e48f2e6f5b`  
Scope: repository and configuration inspection only. No cloud resource, persistent database, secret, receipt, snapshot, provider, broker, or deployment operation was performed.

## Classification

- **READY** — implemented, tested, and not dependent on an unresolved launch decision.
- **PARTIAL** — useful controls exist, but a repository or rehearsal gap remains.
- **MISSING** — no adequate implementation or operational procedure exists.
- **OWNER-GATED** — implementation depends on an owner-controlled identity, credential, vendor configuration, threshold, or irreversible infrastructure action.

## Readiness matrix

| # | Requirement | Status | Repository evidence | Gap / completion condition |
|---:|---|---|---|---|
| 1 | Production application infrastructure | OWNER-GATED | `Dockerfile`; `fly.toml`; `DEPLOYMENT.md` | `fly.toml` is explicitly staging-specific. Owner must choose production app name, region, topology, domains, scale, and create resources. |
| 2 | Production database | OWNER-GATED | `scripts/migrate.ts`; `src/db/rls.sql`; CI fresh/legacy DB matrices | No production cluster, database identity, runtime role password, connection pool policy, or capacity baseline exists. |
| 3 | Production signing key and trust bundle | OWNER-GATED | `scripts/backup/receipt-key-bundle.ts`; `.github/workflows/sign-staging-receipt.yml` | Production key ceremony, key ID, protected signing environment, public trust entry, rotation/revocation owner, and approval policy are unset. |
| 4 | Backup creation | PARTIAL | receipt producer/gate; `scripts/backup.ps1`; `docs/gbackup-staging-receipt.md` | Mechanisms exist, but production snapshot provider, retention, ownership, and a successful production-equivalent rehearsal are absent. |
| 5 | Restore procedure | PARTIAL | `scripts/restore-verify.ps1`; `DEPLOYMENT.md` | Current executable drill is local. A cloud staging drill into an isolated temporary database is documented only after PR-2 and remains unexecuted. |
| 6 | Receipt-gated migrations | READY | `scripts/backup/premigration-gate.ts`; `scripts/migrate.ts`; receipt v2 tests; migration-stage tripwire | Repository gate fails closed and is covered. Production values/trust are separately owner-gated under rows 2–4. |
| 7 | Deployment procedure | PARTIAL | `fly.toml` release command; `DEPLOYMENT.md`; staging receipt workflow | Staging procedure is proven, but there is no production-specific immutable release ceremony or approved rollback thresholds. |
| 8 | Rollback procedure | PARTIAL | additive migration notes; `DEPLOYMENT.md`; migration rollback docs | Image rollback is described; post-migration rollout failure, restore decision authority, commands, and stop conditions need a unified runbook. |
| 9 | Monitoring | PARTIAL | `/api/health`; JSON app logs; `scripts/observe.ts` | No production monitoring destination, dashboards, service-level objectives, retention, or tested ingestion. |
| 10 | Alerting | MISSING | health endpoint can return 503 | No alert rules, routing destination, on-call ownership, severity thresholds, or notification rehearsal. |
| 11 | Structured logging | PARTIAL | `src/lib/log.ts`; redaction tests | Application logger is structured/redacted, but `scripts/worker.ts` still uses ad-hoc console text and correlation/error-class fields are inconsistent. |
| 12 | Health/readiness endpoints | PARTIAL | `src/app/api/health/route.ts`; health integration tests | One public endpoint mixes liveness and dependency readiness; it returns bounded raw error text and lacks explicit migration endpoint identity. |
| 13 | Worker health | PARTIAL | queue aggregate in `/api/health`; worker lease/reconcile code | Backlog/recent activity is indirect. No worker identity/heartbeat age, process-specific health check, or alert threshold exists. |
| 14 | Queue/job observability | PARTIAL | `run_jobs`; lease fencing; `scripts/observe.ts` | No stable operational snapshot for queued/running/failed/reconciliation counts, retry distribution, oldest age, or lease age. |
| 15 | Authentication | PARTIAL | Supabase `getUser()` boundary; middleware refresh; CSP | Runtime boundary is sound, but production provider settings, redirect origins, mail policy, MFA/session policy, and signup closure are owner-controlled. |
| 16 | Authorization | READY | `requireTenant`; server-action gates; admin rubric tests; approval tests | Server-side identity and role checks are broadly tested; PR-3 must still audit direct-object and server-action coverage for regressions. |
| 17 | Workspace/tenant isolation | READY | `withTenant`; RLS policies; non-superuser CI matrix; isolation tests | App filtering plus database RLS and cross-tenant tests provide independent controls. Production must use the specified `app_server` role. |
| 18 | Secrets management | PARTIAL | `env.server.ts`; `.env.example`; secret scan; encryption/rewrap code | Fail-fast validation and repository hygiene exist. Production secret store, rotation owners, cadence, break-glass access, and managed-DB rotation rehearsal are unset. |
| 19 | Supabase production auth configuration | OWNER-GATED | `.env.example`; auth client/middleware | Owner must configure production project, site URL, exact redirect allowlist, signup/email/MFA policy, and publishable key. |
| 20 | Scheduler/standing-work execution | PARTIAL | standing-work domain; `scripts/run-standing-work.ts`; Windows registration script | No cloud scheduler is provisioned or rehearsed; duplicate-tick and failure alert behavior needs an operational contract. |
| 21 | Multi-worker concurrency | PARTIAL | `FOR UPDATE SKIP LOCKED`; lease token/fencing; stale recovery tests | Claim and stale-worker safety are tested, but multiple real worker processes under load have not been rehearsed or capacity-bounded. |
| 22 | Incident response | MISSING | scattered failure notes in deployment/backup docs | No single severity model, incident roles, communications cadence, stop conditions, or scenario runbooks currently cover the requested failure set. |
| 23 | Disaster recovery | PARTIAL | backups, receipt gate, local restore verifier | RPO/RTO, isolated cloud restore drill, failover ownership, compatibility checks, and evidence package are not approved or rehearsed. |
| 24 | Evidence retention | PARTIAL | audit logs; receipt artifacts; workflow artifacts | No production retention schedule, immutable evidence destination, access policy, legal/business retention decision, or deletion procedure. |
| 25 | Security review | PARTIAL | `SECURITY.md`; CI secret/security review; extensive auth/RLS/prompt tests | Automated gates exist. PR-3 must finish the requested repository-focused review and record findings/fixes. Independent pre-launch review remains an owner decision. |
| 26 | Rate limiting / abuse controls | PARTIAL | atomic per-scope run limiter in `src/domain/usage/rate-limit.ts` | Run creation is bounded, but login/provider abuse posture, proxy/IP trust, global exhaustion controls, thresholds, and alerting are not production-specified. |

## Highest-priority repository work

1. Make worker/job logging structured and correlated, and expose a bounded internal operational snapshot for queue/review/migration signals.
2. Split public liveness from authenticated or non-public readiness diagnostics; never return exception text publicly.
3. Add incident, rollback, provider/storage/database outage, receipt rejection, and signing-key compromise runbooks with explicit stop/owner gates.
4. Document—but do not execute—an isolated staging backup/restore rehearsal.
5. Audit server actions, direct-object access, logging fields, prompt boundaries, receipt trust, and future executor isolation.
6. Publish production configuration and release-ceremony specifications using secret placeholders only.

## Owner-gated launch decisions

- Production Fly account/app/region/domain/topology and capacity.
- Production Postgres provider, identities, runtime/DDL roles, pool limits, RPO/RTO, retention, and maintenance policy.
- Production signing environment, approvers, key ID, key custody/rotation/revocation, trust publication, receipt host, and evidence retention.
- Monitoring/log destination, alert thresholds, on-call recipients, escalation path, and evidence retention periods.
- Supabase production project and authentication policy.
- Scheduler mechanism and cadence; worker count and scaling limits.
- Object-storage bucket/region/endpoint, lifecycle, access identity, backup coverage, and outage policy.

These decisions block a production launch, but not the repository-only hardening work in PR-2 through PR-5.
