# Production-readiness foundation exit assessment

Assessment date: 2026-08-07  
Starting protected-main baseline: `41ce96b3277c4f45c46d20a99f85b5e48f2e6f5b`  
Assessment baseline: protected main after PRs #23–#28  
Scope: repository hardening and documentation only. No cloud resource, production/staging deployment, persistent database, secret, receipt, snapshot, broker, provider, or live executor operation was performed.

## Verdict

**PRODUCTION-READINESS FOUNDATION COMPLETE WITH FOLLOW-UPS.**

The planned repository-only readiness work is complete: gaps are inventoried; liveness and readiness are separated; public errors and worker logs are bounded/redacted; incident, rollback, restore, configuration, and release-ceremony contracts exist; and the repository-focused security review found no demonstrated critical bypass. This is not production authorization. Production remains blocked on owner-controlled infrastructure, configuration, provider rehearsal, monitoring/alerting, and release evidence.

## Completion record

| PR | Outcome |
|---:|---|
| #23 | Audited 26 production-readiness requirements and recorded completion conditions. |
| #24 | Added dependency-free `/api/live`, bounded `/api/health`, structured/redacted worker events, and regression tests. |
| #25 | Added incident/rollback/restore runbooks and an isolated staging restore rehearsal specification. |
| #26 | Completed the repository security review and removed raw caught-message logging from jobs/tasks. |
| #27 | Specified production identities, receipt/auth/scheduler/worker/storage/observability configuration and owner approvals. |
| #28 | Specified the evidence-producing production release ceremony, failure boundaries, rollback triggers, and rehearsal exit. |

Each merged PR passed the five protected checks: security review, migration integrity, static analysis, fresh-current database, and accepted-legacy database.

## Updated readiness matrix

`READY` means the repository implementation/procedure is present and tested where executable. It does not imply that external production configuration exists. `PARTIAL` requires repository-adjacent rehearsal or added operational capability. `OWNER-GATED` requires an owner/provider decision or state change. No item remains `MISSING`.

| # | Requirement | Exit status | Remaining completion condition |
|---:|---|---|---|
| 1 | Production application infrastructure | OWNER-GATED | Approve and provision production identity, region, domain, topology, and capacity. |
| 2 | Production database | OWNER-GATED | Approve and provision the cluster, runtime/DDL roles, pool limits, capacity, RPO/RTO, and maintenance policy. |
| 3 | Production signing key and trust bundle | OWNER-GATED | Perform the protected key ceremony, custody/rotation setup, trust publication, and approval policy. |
| 4 | Backup creation | PARTIAL | Execute a production-equivalent backup rehearsal with approved provider, retention, and evidence. |
| 5 | Restore procedure | PARTIAL | Execute the isolated staging restore rehearsal and close findings. |
| 6 | Receipt-gated migrations | READY | Populate approved production bindings and demonstrate them in rehearsal. |
| 7 | Deployment procedure | READY | Execute the documented ceremony against the approved rehearsal target. |
| 8 | Rollback procedure | READY | Exercise decision authority and rollback branches during rehearsal. |
| 9 | Monitoring | PARTIAL | Select destination/SLOs, configure ingestion/dashboards, and validate signals. |
| 10 | Alerting | OWNER-GATED | Approve on-call ownership, destinations, thresholds, and escalation; then rehearse delivery. |
| 11 | Structured logging | READY | Validate ingestion/redaction in the selected production log destination. |
| 12 | Health/readiness endpoints | READY | Validate edge routing and real dependency behavior during rehearsal. |
| 13 | Worker health | PARTIAL | Add/approve direct worker heartbeat identity and alert-age policy. |
| 14 | Queue/job observability | PARTIAL | Establish dashboards/alerts for counts, retry distribution, oldest queue, and lease age. |
| 15 | Authentication | PARTIAL | Configure and validate production signup, email, MFA/session, cookies, redirects, and proxy posture. |
| 16 | Authorization | READY | Continue regression review for new actions and resources. |
| 17 | Workspace/tenant isolation | READY | Use the specified non-owner `app_server` role and validate with production-like identities. |
| 18 | Secrets management | PARTIAL | Select the store, owners, cadence, break-glass flow, and run rotation rehearsal. |
| 19 | Supabase production auth configuration | OWNER-GATED | Create/configure the dedicated production project and exact origins/policies. |
| 20 | Scheduler/standing work | PARTIAL | Provision and rehearse one authenticated logical tick, overlap behavior, and failure alert. |
| 21 | Multi-worker concurrency | PARTIAL | Run isolated multi-process load/lease rehearsal and approve scale boundaries. |
| 22 | Incident response | READY | Assign real roster/communications and tabletop the scenario set. |
| 23 | Disaster recovery | PARTIAL | Approve RPO/RTO and complete isolated restore/failover evidence. |
| 24 | Evidence retention | OWNER-GATED | Approve immutable destination, access, legal/business retention, and deletion policy. |
| 25 | Security review | READY | Obtain any owner-required independent pre-launch review and threat-model live executors before enabling them. |
| 26 | Rate limiting/abuse controls | PARTIAL | Establish production baselines, proxy/IP trust, global exhaustion controls, thresholds, and alerts. |

Exit totals: **9 READY, 11 PARTIAL, 6 OWNER-GATED, 0 MISSING**.

## Readiness percentage

Using the declared scoring rule `READY = 1`, `PARTIAL = 0.5`, and `OWNER-GATED/MISSING = 0`:

- Overall launch-readiness score: `(9 + 11×0.5) / 26 = 55.8%` (reported as **56%**).
- Repository-controllable maturity, excluding the six owner-gated rows: `(9 + 11×0.5) / 20 = 72.5%` (reported as **73%**).

These are transparent progress indicators, not probabilities of a safe launch. A production launch remains a no-go until all owner gates are resolved and the rehearsal evidence closes the applicable partial items.

## Completion plan

1. Owners approve the production configuration record: identities, providers, regions, RPO/RTO, retention, auth posture, scheduler/workers, observability, alerting, key custody, and evidence destination.
2. Authorized operators provision those resources and enter secrets directly in approved stores; repository agents do not handle secret values.
3. Execute the isolated staging backup/restore and multi-worker/scheduler rehearsals; remediate findings through reviewed PRs.
4. Configure dashboards, alerts, direct worker health, queue/job views, rate/abuse thresholds, and incident roster; exercise alert and incident paths.
5. Run the exact release rehearsal on an approved non-production target, including fresh backup, immutable receipt publication, anonymous verification, gated migration, rollout, rollback decision, and evidence review.
6. Hold an owner go/no-go review. Production proceeds only with all critical evidence present, no unresolved stop condition, and explicit authorization.

## Phase 3 recommendation

Phase 3 design and repository implementation may begin in parallel **only behind an off-by-default boundary**. Do not provision or enable a live executor, broker, paid provider, production credential, or irreversible action path until its threat model, tenant/approval boundaries, idempotency and ambiguous-outcome handling, kill switch, spend/rate limits, audit evidence, and dedicated rehearsal are reviewed and accepted. Production-readiness follow-ups remain a separate launch gate and must not be treated as completed by Phase 3 code progress.
