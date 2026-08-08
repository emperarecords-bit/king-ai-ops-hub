# ADR: first real `file_write` executor

**Status:** Proposed — owner decision required before implementation  
**Date:** 2026-08-08  
**Deciders:** product owner, security owner, platform owner, database owner  
**Scope:** architecture only. This document authorizes no filesystem write, live executor, feature flag, infrastructure, credential, or migration.

## Context and verified constraints

The Phase 3 foundation on protected main is closed, typed, server-only, off by default, and dry-run only. Approval, tenant, payload-hash, confirmation, idempotency, result-provenance, ambiguity, and audit controls exist. The only implementation is `noop_dry_run`; model and browser paths cannot dispatch it directly.

The current Fly image runs web and worker commands from the same Node image as non-root user `app` under `/app`. The image filesystem is application code, not a workspace boundary. No per-workspace Fly volume is mounted, cloud documents use object storage, local project folders are explicitly local-only, and the durable worker is a database-backed job consumer with leases/checkpoints designed for model runs. Therefore a real file executor must not write inside the web/worker image and must not assume a workspace directory already exists on Fly.

Existing filesystem code is either read-only validation or local/dev/document/CI tooling. `legacy-active-bundle.ts` provides useful precedent for rejecting symlinks and checking realpath containment, but a writer has stronger TOCTOU and rollback requirements.

## Decision summary

Recommend **Option C: a dedicated ephemeral sandbox container or microVM**, launched by a separate executor service/worker, with exactly one approved workspace mounted at `/workspace`, no application source/secrets mount, no network by default, and a read-only root filesystem except the workspace and bounded scratch area. The main web/worker process records and queues intent; it never writes the target itself.

The first live capability is one atomic UTF-8 text-file create or replace. It excludes append, directory creation, rename, move, delete, chmod, binary files, links, and multi-file transactions. Live implementation must wait for owner decisions, dedicated lifecycle storage, a migration, and a non-production sandbox rehearsal.

## Sandbox options

| Dimension | A. In-process worker | B. Local child process | C. Ephemeral container/microVM |
|---|---|---|---|
| Security isolation | Weak: same process, credentials, memory, filesystem namespace | Medium-low: process boundary but normally same user/mounts/kernel | Strongest: explicit mounts, identity, network, PID/user/filesystem isolation |
| Windows/Linux portability | Node path APIs vary; reparse points/case behavior are difficult | Process controls and sandbox primitives diverge sharply | Image contract can be Linux-only; host/provider abstracts local OS |
| Deployment complexity | Low | Medium | High: executor image, scheduler/API, workspace attachment, cleanup |
| Filesystem semantics | Inherits mutable host/container semantics | Same host semantics unless namespace controls are added | Fixed Linux filesystem/mount semantics can be declared and rehearsed |
| Symlink/reparse risk | High TOCTOU exposure | Still high without mount namespace/openat-style helper | Lower with controlled mount plus descriptor-relative no-follow operations; not zero |
| Resource controls | Cooperative timeout; weak memory/CPU/disk isolation | OS-dependent job/cgroup controls | Native memory/CPU/PID/disk/time quotas |
| Observability | Easy but mixed with worker logs | Separate stdout/exit code | Per-execution logs/metrics/exit reason and sandbox identity |
| Cleanup | Application must clean temp state | Parent must reap process/temp state | Destroy ephemeral environment; reconcile orphaned sandboxes |
| Rollback | Application responsibility | Helper/parent responsibility | Explicit rollback artifact plus isolated compensating run |
| Cost | Lowest | Low | Highest per execution; bounded by short-lived, low-resource instances |
| Operational burden | Low initially, high incident blast radius | Medium, with cross-platform maintenance | Highest platform work, lowest credential/process blast radius |
| Current Fly suitability | Unsafe: current worker contains DB/provider credentials and app source | Poor unless moved to a dedicated worker Machine with restricted mounts | Best long-term; requires an executor-specific Machine/service and workspace storage decision |
| Future higher-risk executors | Unsuitable | Limited | Best reusable isolation boundary, though each executor still needs separate policy |

**Rejected as the live boundary:** A cannot prevent a path/race bug from reaching the worker’s application files or credentials. B is acceptable only as an internal helper *inside C*; a child process in the current worker is not a sandbox.

## Workspace-root policy

1. The durable execution record identifies one `(org_id, project_id, workspace_storage_id)` chosen from trusted server configuration. No model/client path selects a host root.
2. Each execution environment receives exactly that workspace mounted at the fixed absolute path `/workspace`. It receives no sibling workspace, Docker socket, host root, application source, `.env`, SSH directory, cloud credential directory, or provider token.
3. Requested target is a canonical **relative POSIX path**. Absolute Linux paths, drive letters, URL schemes, UNC paths, backslashes, NUL/control characters, empty/`.`/`..` segments, repeated separators, trailing slash, and non-normal form are denied.
4. V1 uses a deliberately portable ASCII filename subset: segments match `[A-Za-z0-9][A-Za-z0-9._-]{0,99}`. Unicode names are denied until a reviewed NFC/case-collision design exists. Total relative path length is at most 240 UTF-8 bytes and depth at most 12.
5. Comparisons use both exact bytes and a Unicode-aware case-folded collision key at workspace indexing time. The Linux sandbox remains case-sensitive, but a target colliding under Windows/macOS semantics is denied.
6. Deny every dot-prefixed segment and these case-insensitive segments: `.git`, `.hg`, `.svn`, `node_modules`, `.next`, `vendor`, `dist`, `build`, `coverage`. Deny Windows device basenames (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`) even with extensions.
7. Deny secret/config classes by basename or suffix, including `.env*`, credential/key/token/secret/password names, private keys/cert bundles, shell profiles, package-manager auth, Docker/Kubernetes/Terraform configuration, and executable/script/binary extensions. Initial allowlist: `.txt`, `.md`, `.json`, `.yaml`, `.yml`, `.csv`.
8. Every existing parent and target is descriptor-walked without following links. Symlinks, junctions/reparse points, mount-point transitions, sockets, devices, FIFOs, and non-regular targets are denied. The sandbox image must use Linux; Windows reparse points are never accepted as input.
9. Hard links are denied for replacement: target link count must be exactly one. Workspace ingestion/provisioning also rejects hard-linked regular files. File identity is rechecked immediately before atomic replacement.
10. The final implementation must use descriptor-relative, no-follow operations (for example a small reviewed Linux helper using `openat2` with `RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_XDEV`, or equivalent). String normalization plus `realpath` alone is insufficient because of TOCTOU.

## First file-write semantics

Allowed operations:

- `create`: create one new regular UTF-8 text file when the approved precondition is `absent`.
- `replace`: replace one specifically approved existing regular UTF-8 text file only when its current SHA-256 equals the approved precondition hash.

Excluded: append, patch-without-final-bytes, directory creation, rename/move, delete, chmod/chown, binary content, links, multiple targets, recursive behavior, and multi-file transactions.

Initial limits and encoding:

- Valid UTF-8 without BOM; reject NUL and C0/C1 controls except tab, LF, and CRLF input.
- Normalize line endings to LF *before* preview/hash/confirmation. Do not otherwise normalize content.
- Maximum final file: **256 KiB (262,144 bytes)**. One target and one payload per action; maximum total approved content is the same 256 KiB.
- Allowed extensions remain the narrow text allowlist above. JSON/YAML syntax validation is optional preview metadata, not authorization to rewrite formatting.

Atomic procedure (future implementation only):

1. Re-resolve root and parent through no-follow descriptors; verify storage/workspace identity and same filesystem.
2. Verify target absence or regular-file identity, link count one, size bound, and approved precondition SHA-256.
3. Persist execution/attempt intent and desired postcondition hash before entering the sandbox.
4. In the target directory create `.king-write-<execution-id>.tmp` with exclusive create, mode `0600`, and no-follow semantics. Temp names are reserved/denied to users.
5. Write bounded normalized bytes, fsync the file, re-read/hash through the open descriptor, and require the intended SHA-256.
6. Atomically install in the same directory. Create uses no-replace semantics; replace rechecks target identity/precondition immediately before rename. Fsync the directory.
7. Reopen without following links, confirm regular file/link count/path identity/final hash, then record result.

No durability claim is made if the backing storage cannot honor file and directory fsync. That capability must be proven in rehearsal. Temporary files are never treated as success. On failure they are quarantined/removed only after reconciliation records their identity.

Conflict behavior: any changed/missing/unexpected target, link/mount change, temp collision, case collision, or precondition mismatch blocks without writing. A new approval is required; the executor does not merge.

Rollback artifact: before replacement, capture the previous bytes, SHA-256, mode, file identity, and timestamp into encrypted, access-controlled, tenant-scoped immutable rollback storage with a short approved retention. The audit record stores only artifact ID/hash. Creation rollback is a separately approved delete action—not automatic deletion. Rollback itself is a new execution with confirmation and preconditions.

## Confirmation policy

- Single-use confirmation; one confirmation ID maps to exactly one execution/idempotency key.
- Lifetime: **10 minutes** from server-issued preview, never later than approval expiry. Dispatch must begin before expiry; restart does not extend it.
- Bind canonical bytes to: contract/executor version, org, project, workspace storage ID/root identity, executor ID, `file_write`, operation (`create|replace`), normalized relative path and case-fold collision key, payload SHA-256, precondition (`absent` or SHA-256 plus file identity when available), intended final SHA-256, risk class, actor, approval ID, confirmation ID, and expiry.
- The diff shown before confirmation is generated from the exact precondition and intended final bytes. Any path/content/precondition/policy/executor/version/actor/workspace change invalidates it.
- Approval for file A can never authorize file B. Approval is consumed when durable execution intent is claimed, including ambiguous outcomes. Retries reuse the execution ID/idempotency key only for reconciliation, never a second write.
- After executor restart, the record resumes in reconciliation; it does not dispatch again.

## Enablement custody and kill switch

Require all of these independent controls:

1. environment allow (`executor environment = non-production rehearsal` initially; production absent/false);
2. global executor kill switch in owner-controlled server configuration;
3. executor-specific allow for `sandboxed_file_write_v1`;
4. per-workspace enablement approved by an organization owner and security/platform owner.

Default/absence is OFF. A project admin may confirm an action but may not enable the capability. Platform/security dual control enables an environment/executor; an organization owner requests workspace enablement. Every change records actor, scope, old/new state, reason, ticket/decision reference, and timestamp in append-only audit plus dedicated configuration history.

Emergency disable is available to security/platform on-call and is fail-closed when configuration cannot be read. It stops new claims immediately and sends cancellation to running sandboxes. An in-flight atomic rename cannot be safely presumed stopped: terminate at the sandbox boundary, mark the execution `ambiguous`, preserve the idempotency claim, and reconcile filesystem state. Never roll back automatically.

## Initial resource limits

| Limit | Recommendation |
|---|---|
| Wall-clock execution | 10 seconds from sandbox start; 3 seconds for the filesystem critical section |
| Memory | 128 MiB hard limit |
| CPU | 0.25 shared vCPU / equivalent quota; max 2 CPU-seconds |
| Processes | 8 PIDs; helper cannot spawn arbitrary programs |
| Network | None |
| Writable scratch | 2 MiB; workspace quota must retain at least 2× payload + rollback headroom |
| File/total payload | 256 KiB, one target |
| Output/log | 64 KiB structured metadata; no content bytes |
| Filesystem operations | One semantic target operation; bounded descriptor walk depth 12; one temp file |
| Workspace concurrency | 1 live/reconciling execution |
| Global concurrency | 4 initially, lowered by platform capacity |
| Automatic write retry | 0 |
| Automatic reconciliation | start within 30 seconds; poll up to 15 minutes |
| Operator reconciliation SLA | page at 15 minutes; owner resolution within 4 hours |

Option A cannot enforce memory/CPU/process limits reliably. B can enforce wall time and output but resource enforcement is OS-specific. C can enforce all except backing-storage durability semantics, which require provider rehearsal.

## Reconciliation design

Filesystem observation is authoritative only when bound to the recorded root/file identity and hashes:

- **Definitely executed:** target is a regular single-link file at the normalized path, intended final SHA-256 matches, no conflicting file identity exists, and the atomic-install sandbox evidence is valid. A missing result audit may then be reconstructed as reconciled success.
- **Definitely not executed:** target still satisfies the recorded precondition (`absent`, or the exact prior hash/file identity), intended final hash is absent, no temp/quarantine artifact can become visible, and the sandbox never crossed its durable pre-write checkpoint. A crash/timeout alone is never evidence.
- **Ambiguous:** all other states—target changed to an unrelated hash, temp exists, storage unavailable, identity changed, conflicting evidence, or observation cannot be completed.

Ownership is combined: a dedicated reconciliation job owns automatic observation under a separate read-only/reconcile capability; the executor worker only reports its last checkpoint. An admin operator resolves cases still ambiguous after 15 minutes, with security/platform escalation for escape/tampering signals. The original idempotency key remains consumed throughout. Audit failure before intent means no dispatch; audit/result failure after write means ambiguous and reconciliation required.

## Threat analysis

| Threat | Prevention | Detection | Recovery | Residual risk |
|---|---|---|---|---|
| `../` or absolute escape | Canonical relative grammar; descriptor-relative beneath-root resolution | Policy rejection audit | New corrected proposal | Kernel/helper defects |
| Symlink/junction/reparse escape | Linux-only mount; no-follow/no-xdev descriptor walk; deny links | lstat/statx/file-identity checks | Block/quarantine workspace | TOCTOU if helper is implemented incorrectly |
| TOCTOU path swap | `openat2`-style handles; recheck identity before rename | Pre/post identity mismatch | Ambiguous + operator inspection | Filesystem/provider semantics |
| Hard link attack | Reject link count != 1; ingestion policy | Pre/post metadata | Block and quarantine | Privileged storage actor could race |
| `.git/config`, secrets, dependencies | Denied segments/basenames/extensions; app source not mounted | Policy and mount manifest audit | Block; rotate if escape suspected | Incomplete denylist—mount isolation is primary |
| Huge payload/disk exhaustion | Byte/quota/headroom limits before sandbox | Quota and sandbox exit metrics | Block, clean temp after reconcile | Shared backing-store exhaustion |
| Malicious Unicode/case collision | V1 ASCII-only plus case-fold collision index | Workspace scan | Block and require rename | Future Unicode expansion risk |
| Concurrent/duplicate writes | Workspace concurrency 1; DB uniqueness/idempotency; precondition hash | Conflict/duplicate audit | Re-preview and new approval | External writer not using Hub |
| Stale/forged confirmation | Server-signed/stored binding, 10-minute single use | Binding mismatch audit | New preview/confirmation | Compromised authorized session |
| Cross-workspace action | Trusted storage ID/mount manifest; tenant RLS | Scope mismatch and sandbox manifest | Block, incident on mount mismatch | Platform mount bug |
| Crash before write | Durable state checkpoint before sandbox | Missing sandbox checkpoint + unchanged state | Reconcile to not-executed only with proof | Storage unavailable leaves ambiguity |
| Crash after write before result | Intended hash and sandbox checkpoint | Reconciler observes final state | Reconciled success or ambiguous | Unrelated writer can complicate proof |
| Timeout during rename | Atomic install plus postcondition hash | Timeout + filesystem observation | Never retry; reconcile | Backing filesystem atomicity failure |
| Audit failure | Intent persistence is a hard precondition | Transaction/error telemetry | No dispatch before intent; ambiguous after write | DB outage during result persistence |
| Kill switch mid-run | Cancel sandbox and block new claims | Switch/cancel/exit events | Mark ambiguous and reconcile | Rename may already have committed |

## Required actions before implementation

1. Owners accept or amend every decision in the owner package.
2. Approve workspace storage/provider and prove isolated mount/fsync/atomic-rename semantics.
3. Approve the lifecycle schema memo and migration in a separate PR.
4. Select/build the descriptor-relative sandbox helper and subject it to independent security review.
5. Implement preview/diff and confirmation binding before live dispatch.
6. Rehearse traversal/race/crash/kill-switch/reconciliation scenarios on a disposable non-production workspace.

