# Production-readiness security and authorization review

Review date: 2026-08-07  
Scope: protected-main repository review only; no infrastructure, provider, database, secret, receipt, snapshot, broker, or executor action.

## Result

No critical authorization bypass, cross-tenant direct-object access, client-side provider boundary violation, receipt-gate bypass, or live-executor path was demonstrated. One narrow logging issue was fixed: worker/run error messages could include upstream exception text and were being written to stdout. Operational logs now retain correlation and error class while omitting raw exception/customer-derived text.

## Review matrix

| Area | Result | Evidence / finding |
|---|---|---|
| Admin-only rubric editing | PASS | Server action and domain both require project admin; reviewer role and UTF-8 byte bound are enforced; integration tests cover admin/member/viewer and unchanged denied rows. |
| Reviewer provenance | PASS | Engine supplies agent ID/name/provider/model/rubric snapshot/hash/time from trusted state; historical decoder strips unknown fields and fails malformed v2 metadata closed. |
| Task/run authorization | PASS | Request paths resolve tenant context server-side; pinned agents are workspace/role scoped; job execution restores persisted tenant identity and re-enters `withTenant`. |
| Server-only providers | PASS | Provider credentials/config live behind `server-only`; browser components receive rendered values/actions, not provider clients or keys. |
| Tenant/workspace scoping | PASS | App predicates plus PostgreSQL RLS; non-superuser fresh/legacy CI profiles and isolation tests provide independent enforcement. |
| SSR/server actions | PASS WITH FOLLOW-UP | Reviewed mutations call `requireTenant` and enforce role/domain checks. Continue requiring an authorization test with every new server action. |
| Direct-object access | PASS | IDs are combined with org/project predicates at domain boundaries; project key is resolved against membership; forbidden/not-found behavior avoids project enumeration. |
| Client imports | PASS | `env.server`, DB, provider registry, encryption, and secret modules are server-only; no demonstrated client import crosses that boundary. |
| Secret exposure | PASS WITH FIX | Secret scan/redaction exist. Raw error text in job/runner logs was removed in this PR because provider/customer-derived messages are not safe operational fields. |
| Prompt injection | PASS | Task/context/rubric/reviewer feedback use explicit untrusted boundaries; strict review schema, anchor validation, verdict set, and fail-closed parsing are independent of model instructions. |
| Receipt-gate trust | PASS | Migration gate binds DB identity, source/image/migration facts, nonce, signature/trust, time/retention, and fails before migration. No bypass is authorized for non-disposable targets. |
| Signing-key boundary | PASS WITH OWNER GATE | Workflow scopes the staging key to the protected signing environment and emits public material only. Production key custody/trust/rotation remains owner-gated. |
| Paper-trading isolation | PASS | Trading execution mode is paper-only; no live broker adapter or credentialed live execution path is enabled. |
| Future executor boundary | PASS WITH FOLLOW-UP | Current approvals authorize but cannot execute consequential actions. Phase 3 must preserve separate execution authority, dry-run, idempotency, allowlists, and audit/reconciliation controls. |

## Larger findings documented, not expanded

- Production Supabase policy, secrets custody, signing key, trust publication, monitoring/alerting, and infrastructure identities require owner decisions.
- Independent penetration testing and dependency/vendor risk review are recommended before public launch.
- Numeric abuse, latency, backlog, and rollback thresholds require production baselines; repository code must not invent them.
- Multi-worker safety is strongly unit/integration tested but still needs an isolated concurrency rehearsal before scale-out.

## Required Phase 3 entry conditions

Executor development may not weaken the existing rule that approval is not execution. Each executor needs a closed action schema, server-side allowlist, dry-run preview, idempotency key, tenant and role gate, explicit human authorization tied to immutable payload hash, bounded retry/ambiguous-outcome handling, structured redacted logs, audit evidence, and an off-by-default production flag. No live broker/executor capability was added by this review.
