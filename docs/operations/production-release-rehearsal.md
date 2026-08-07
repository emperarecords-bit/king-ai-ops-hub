# Production release ceremony and rehearsal

Specification only. This is the exact evidence-producing sequence to rehearse before a first production release. It does not authorize a backup, receipt, publication, migration, deployment, secret operation, or provider call. Every provider action remains owner-gated.

## Roles and stop authority

- Release commander owns the timeline, immutable release identity, evidence index, and final go/no-go.
- Database operator owns target identity, fresh backup, restore usability, and migration observation.
- Security custodian owns the protected signing environment, key ID, trust bundle, and compromise stop.
- Application operator owns image publication, gated rollout, health verification, and rollback.
- Incident commander takes control after any stop condition. Anyone may stop; only the release commander may resume after the named owner resolves and records the condition.

Two-person approval is required for target identity, signing inputs, migration start, and rollout start. The signer must not also be the sole database or application approver.

## Rehearsal entry criteria

Record an evidence index containing timestamps, actor/approver identities, provider resource IDs, command or workflow run URLs, immutable object versions, and cryptographic hashes. Before the rehearsal begins, require:

- a reviewed commit on protected `main`, all required checks green, a clean checkout, and an immutable image reference `IMAGE_REF=<registry>/<image>@sha256:<64hex>`;
- approved values from `production-configuration-spec.md`, including a production application and database identity that cannot be confused with staging;
- the exact committed migration set and its repository-derived hashes, with no generated drift;
- approved RPO/RTO, maintenance window, rollback authority, communication channel, and incident bridge;
- a protected signing environment, production-only key ID, reviewed public trust bundle, and immutable anonymous HTTPS evidence location;
- a restore-tested backup procedure and enough capacity to preserve the pre-release state;
- dashboards and alerts visible to the assigned operators.

**Stop:** any mutable image tag, dirty/unreviewed source, missing approver, ambiguous target, missing monitoring, expired credential, or incomplete configuration record.

## Exact ceremony

### 1. Freeze and bind the release

The release commander records the protected-main commit, tree hash, CI run URLs, immutable image digest, application identity, database name and provider resource ID, database system identifier, source volume ID, and intended migration set. A second approver independently compares each value with the provider consoles and repository.

**Failure boundary:** a mismatch creates a new rehearsal. Do not edit evidence to make identities agree.

### 2. Create and verify a fresh pre-release backup

The database operator creates a new provider-native backup or snapshot of the recorded production source, waits for provider success, records the immutable backup/version ID and timestamps, and performs the approved independent usability check. Its completion must satisfy the approved RPO and receipt age windows.

**Stop:** queued/partial backup, wrong source, unverifiable completion, mutable identifier, stale timestamp, failed usability check, or unavailable restore path. An earlier backup cannot be substituted silently.

### 3. Generate a one-use deployment nonce

An authorized operator generates a cryptographically random canonical 128-bit nonce (hex32 or unpadded base64url22). Record it in the controlled release inputs. It is unique to the exact image, target, migration set, and backup and is never reused after cancellation, failure, or expiry.

### 4. Sign and self-verify the receipt

From the reviewed protected signer, submit only the recorded facts: source commit, immutable image digest, deployment nonce, application/database/volume identities, backup ID and times, exact migration hashes, receipt creation/expiry, production key ID, and receipt mode. The workflow must expose no provider deployment credentials and must sign only with the protected production key.

The signer produces the canonical signed receipt, public trust bundle, and verification metadata. A separate verification step checks schema, canonical encoding, signature, key purpose/status, target binding, backup binding, image digest, nonce, migration hashes, timestamps, and expiry.

**Stop:** signer source differs from reviewed source; key ID is staging/unknown/revoked; any input differs from steps 1–3; private material appears in output; self-verification fails. Destroy compromised output and invoke the signing-key runbook when applicable.

### 5. Publish immutable public evidence

Publish only the signed receipt and approved public trust material to the configured HTTPS origin. Preserve immutable object/version IDs and content hashes. Do not publish private keys, credentials, provider tokens, internal connection strings, or unredacted operator output.

From an anonymous, clean client with no cookies, tokens, VPN-only access, or query credentials, retrieve the exact URLs. Reject redirects to unapproved hosts. Byte-compare/hash the retrieved objects with the signed outputs, then run the repository verifier against the public URLs and exact release facts.

**Stop:** anonymous access fails, content mutates, redirects escape the allowlist, caching serves an older object, or verification differs locally and remotely.

### 6. Authorize the gated rollout

The release commander reviews the complete evidence index and obtains the explicit database and application go decisions. Recheck receipt and backup age immediately before starting. Record the migration-start timestamp; this consumes the nonce for this release attempt.

No operator may weaken the trust bundle, age limits, hostname allowlist, target binding, or migration manifest to obtain a pass.

### 7. Run migration gate and migrations

The application operator starts the release command with the exact immutable image and approved production configuration. The pre-migration gate must retrieve and verify the public receipt before any DDL. The database operator watches for the gate-success event, migration identifiers/hashes, timing, locks, errors, and schema version.

**Stop and incident:** any DDL observed before gate success; target identity mismatch; gate rejection; unexpected migration; hash drift; lock/saturation threshold breach; migration error; or ambiguous completion. Never blindly rerun an ambiguous migration. Follow the deployment-before-migration or migration-success/rollout-fail runbook as appropriate.

### 8. Roll out and verify

Only after confirmed migration success, roll out the same immutable image. Verify in order:

1. process start and dependency-free `GET /api/live`;
2. `GET /api/health` readiness for database, migration compatibility, worker/backlog, and storage;
3. authentication and tenant isolation using approved synthetic accounts;
4. one non-destructive synthetic queue/job lifecycle with correlation IDs;
5. worker heartbeat, queue age, error/retry rates, database/storage saturation, receipt/gate events, dashboards, and alert delivery.

Use an observation window approved from measured startup and workload behavior. Do not declare success from liveness alone.

**Rollback trigger:** readiness remains unhealthy beyond the approved window, tenant/auth isolation fails, error/latency or saturation crosses approved thresholds, workers cannot make safe progress, evidence cannot be correlated, or data integrity is uncertain. Rollback application code only when schema compatibility is proven; migrations are not automatically reversed.

### 9. Close, retain, and expire

Record final image and instance identities, schema/migration state, health samples, synthetic result, monitoring screenshots/exports, alert test, decisions, exceptions, incidents, and final timestamp. Revoke temporary access, remove local transient public-only artifacts, and leave immutable provider evidence under the approved retention policy. Mark the nonce consumed and receipt closed; neither may authorize another attempt.

## Successful rehearsal exit

A rehearsal passes only when every step was executed against an explicitly approved non-production rehearsal target, every stop condition was respected, independent verification succeeded, rollback/incident decisions were exercised, and the evidence index can reconstruct who approved what and which immutable artifacts ran. A tabletop review or CI pass alone is not a production rehearsal.

Production authorization remains a separate owner decision after review of the rehearsal evidence, unresolved risks, and rollback capability.
