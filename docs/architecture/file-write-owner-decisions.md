# Owner decision package: sandboxed `file_write` v1

No item below is enabled or provisioned. Each recommendation must be explicitly accepted or amended before implementation.

| # | Decision | Recommended choice | Alternative | Security tradeoff | Operational tradeoff |
|---:|---|---|---|---|---|
| 1 | Sandbox | Ephemeral dedicated container/microVM; child helper only inside it | In-process or child in current worker | Strong mount/process/network boundary; platform remains trusted | Highest setup/cost, reusable for future executors |
| 2 | Workspace root | Trusted per-project storage ID mounted alone at `/workspace`; relative canonical paths only | Host-configured roots in worker | Prevents sibling/app/secret access | Requires workspace storage/provisioning design |
| 3 | Links | Deny symlinks, junctions/reparse points, mount transitions, and hard links; descriptor-relative no-follow resolution | Realpath-only checks | Stronger escape/TOCTOU defense | Requires Linux helper and ingestion scan |
| 4 | Operations | One UTF-8 text `create` or hash-preconditioned `replace` | Append/direct patch/directories/multi-file | Small auditable surface, atomic postcondition | Users must propose full final content; fewer conveniences |
| 5 | File limit | 256 KiB final/total action bytes | 64 KiB or 1 MiB | Limits memory/disk/log abuse | Enough for normal docs/config; large files excluded |
| 6 | Resources | 10 s wall, 3 s critical section, 128 MiB, 0.25 vCPU/2 CPU-s, 8 PIDs, 2 MiB scratch, 64 KiB logs, 1/workspace and 4 global, zero write retries | Looser cooperative worker limits | Contains denial-of-service and duplicate-effect risk | Requires sandbox quotas and capacity monitoring |
| 7 | Confirmation lifetime | 10 minutes, capped by approval expiry, single use | 5 or 30 minutes | Short replay/staleness window | Operators may need to refresh previews |
| 8 | Binding | Workspace/root, executor/version, operation, normalized path/collision key, payload/pre/post hashes, risk, actor, approval, confirmation, expiry | Payload hash only | Prevents path/scope/policy substitution | More fields invalidate previews after benign changes |
| 9 | Enablement | Environment + global + executor + per-workspace controls all required, default OFF | Single global flag | Limits accidental/broad activation | More owner coordination/config history |
| 10 | Kill switch | Security/platform dual custody; either on-call may emergency-disable; cancel and reconcile in-flight | Product admin ownership | Fast containment without assuming cancellation | Requires on-call/runbook/cancel channel |
| 11 | Reconciliation | Dedicated automatic reconciler, admin resolution after 15 min, security/platform escalation | Executor self-retry | Separates observation from write and forbids blind retry | New queue/ownership/alerts |
| 12 | Lifecycle storage | Dedicated execution + attempt records; audit remains evidence | Reuse audit/run-job JSON | Typed uniqueness, leases, postconditions, reconciliation | Additive schema/domain/retention work |
| 13 | Migration | **Required before a real write**, after memo approval; none created now | Continue audit JSON | Avoids unsafe transaction-spanning side effects | Delays live increment by one reviewed migration PR |

Additional approvals required: workspace storage provider and durability semantics; rollback artifact store/retention; allowed extensions/secret-name policy; Linux helper technology; confirmation signer/storage; enablement configuration store; on-call and reconciliation SLA; independent security review and disposable rehearsal plan.

