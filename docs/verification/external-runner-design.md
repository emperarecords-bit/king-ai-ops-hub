# VER-002 External-Runner Integration — Design (rev. 4)

**Status:** DESIGN ONLY. Nothing here is implemented, and no secret, bucket, role, migration, or
credential is provisioned. Deployments and staging/production migrations remain paused. This
document exists to be reviewed and to pin down owner decisions before any build.

**Model.** The Hub is an *adjudicator* (Option A): authorized humans (or trusted Hub
orchestration) create an immutable verification **contract**; an external **runner** checks out
the pinned commit, runs the contract's required checks, uploads artifacts, and submits **signed**
evidence; the Hub decides `verified_complete` or a typed rejection. The Hub never runs commands.

Revision 2 resolved six review points and **corrected an error in rev. 1's baseline** (evidence
was described as DB-immutable; it is not yet — see §3). Revision 3 pinned the upload mechanism and
added append-only-trigger/FK-cascade, harness isolation, and out-of-order derivation. **Revision 4**
tightens four things the review flagged: it separates *historical pass evidence* from *current
verification/deliverability* and demotes "any pass wins" from a default guarantee to an explicit,
still-undecided owner policy, adding append-only withdrawal/invalidation and artifact-expiry
behavior (§5.1–5.4); commits to **AWS S3 as the single initial provider**, removes the earlier
blanket S3/R2/GCS portability claims, documents exact SDK signing + checksum encoding, and gates all
size/checksum/no-overwrite enforcement claims on provider acceptance tests (§4.0, §4.7); makes
retention **crash-recoverable** via a durable purge job and authorizes it by **restricted role +
`SECURITY DEFINER` function, not a GUC** (§3.1–3.2); and closes upload-lifecycle gaps with opaque
server-generated object IDs (validated logical paths) and quota that is **not** released on URL
expiry while bytes can still land (§4.3, §4.6).

---

## 0. Corrected baseline (what the reviewed code actually does today)

| Piece | State in reviewed code |
|---|---|
| Contract creation | `POST …/verification/requests` → `createVerificationRequest`. Human-authenticated (admin/member; viewer 403; non-member 403). Immutable, idempotent, 409 on divergence. |
| Evidence ingest | `POST …/verification` → `requireTenant` **(user session)** *then* `ingestEvidence` (HMAC verify → freshness → binding → checks → artifact availability → adjudicate). |
| Signing | Per-project key = `HMAC(VERIFICATION_RUNNER_MASTER_SECRET, "verification-runner:v1:<org>:<project>")`, derived server-side; master unset ⇒ ingestion disabled. No prod secret provisioned. |
| Contract immutability | `verification_requests`: `grant select, insert` + `revoke update, delete`. **Immutable — correct.** |
| **Evidence immutability** | `verification_evidence`: `grant select, insert, update, delete to app_server` (rls.sql line ~1065). **NOT immutable — this is a gap (see §3).** Rev. 1 wrongly claimed evidence was DB-immutable. |
| Artifact availability | Artifact referenced by tenant-scoped `storageKey` (under `org/<id>/project/<id>/…`); Hub reads bytes from shared `ObjectStore` and confirms stored + retrievable + sha256-matched. No conditional-write / versioning / quota logic yet. |
| Evidence row shape | Already has `attempt_id`, `run_id`, `runner_id`, `accepted` (bool), `status` (TaskVerificationStatus), `deliverable`, `submission_sha256`, idempotency `unique(org, project, request_id, idempotency_key)`. |

---

## 1. Runner role: retrieve assigned contracts and submit evidence — never author requirements

**Principle.** A runner is an *evidence producer*, not a requirements author. It cannot create a
contract, cannot alter one, and cannot relax its own required checks/artifacts.

- **Contract creation stays with:** (a) authorized humans (admin/member via session), or (b)
  **trusted Hub orchestration** — a distinct internal server-side principal (the orchestrator/GM
  path), never the runner bearer credential. Creation is not a runner-facing capability.
- **Runner-facing endpoints are exactly three:**
  1. `GET …/verification/requests/assigned` — list contracts assigned to this runner's project
     (and/or `GET …/verification/requests/:id` for one it was handed). Read-only.
  2. `POST …/verification/uploads` — request short-lived presigned upload grants (§4).
  3. `POST …/verification` — submit signed evidence for an existing contract.
- **The contract is the source of requirements.** Ingest reads required checks/artifacts from the
  stored contract, never from the submission. A submission that omits or narrows a required check
  is a rejection, not a redefinition. (This is already true for checks/artifacts; §2 extends it
  to the command catalog.)
- **Endpoint permission matrix** (see §6.2) makes "runner cannot create/modify contracts"
  explicit and enforced at the guard and by RLS.

---

## 2. Pin the approved command catalog to the contract; keep the harness outside the checkout

### 2.1 Catalog pinning
Required check **names** map to approved commands via a version-controlled, per-project catalog
(`verification-checks.<project>.json`), reviewed like code. To stop a runner (or tampered repo)
from redefining what a check *means*:

- The contract **records the catalog identity at creation**: `catalog_version` and
  `catalog_digest` (sha256 of the canonical catalog file). These are pinned, immutable contract
  fields.
- Evidence declares the `catalog_version`/`catalog_digest` it executed under. Ingest **rejects**
  any evidence whose catalog digest ≠ the contract's pinned digest (`catalog_mismatch`).
- Each submitted check's `command` must equal the approved command for that name in the pinned
  catalog — not merely be non-empty. A command that doesn't match the pinned catalog entry is a
  rejection.
- Changing a check's command is a reviewed catalog bump → a **new** `catalog_version` → new
  contracts pin the new digest; existing contracts stay bound to what they were reviewed against.

### 2.2 Harness and authoritative records outside the checkout's writable boundary
A signer must not trust mutable scratch-file claims produced *by* the code under test.

- **Execution harness is not part of the checkout.** The harness binary/script lives outside the
  working tree and is not modifiable by the checked-out code. It invokes each approved command.
- **Authoritative exit code + timestamps come from the harness**, captured by the parent process
  (wall-clock `startedAt`/`finishedAt`, real `exitCode`), not self-reported by the test process.
  Repo code cannot write these values.
- **Records land outside the checkout's writable boundary.** The harness writes a per-check
  result record to a directory the checked-out code cannot write to. The attestation stage
  (§4/§6) reads authoritative records **only** from that location — never from files the test
  code could have written.
- **Consequence:** even a malicious dependency that writes a fake `results.json` into the
  checkout cannot influence the signed evidence, because the signer reads the harness's records,
  not the checkout's.

### 2.3 Isolation is enforced by process + filesystem boundaries, not just a path
"Outside the checkout" is a location; it is not, by itself, protection. On a shared machine a test
process can still reach a sibling directory, read another process's environment, or `ptrace` the
collector. The harness records and the signing/upload credentials must be protected by OS-level
isolation:

- **Separate, unprivileged uid for check execution.** Untrusted commands run as a dedicated
  low-privilege user with **no** read/write access to the harness result sink or the attestation
  stage's files/env. The result sink is owned by the harness uid, mode `0700`; the checkout is
  writable by the test uid but the sink and the harness binary are not.
- **Namespace/sandbox, not just a folder.** Run checks in a container or microVM with the checkout
  on a writable overlay and the authoritative result sink either mounted **read-only** into the
  sandbox or, better, kept **out of the sandbox entirely** — the harness collects exit
  code/timestamps in a parent/collector process and the sandboxed command streams stdout/stderr to
  it over a pipe or unix socket it cannot tamper with.
- **No lateral reach to the collector.** The collector/attestation process runs as a different uid
  the test process cannot signal or `ptrace` (distinct uid + `ptrace_scope`/no `CAP_SYS_PTRACE`),
  so the test cannot inspect or inject the exit codes, nor read the signing/bearer secrets from the
  collector's memory or environment.
- **Network egress off** in the execution sandbox by default (a check that needs network is a
  declared exception in the catalog, §2.1), so a check cannot exfiltrate or phone home.
- **Secrets are never mounted into the execution sandbox** (restating §6.4's split): the signing key
  and bearer credential exist only in the attestation stage, which the checked-out code never
  enters.

The distinction matters for the threat model: a path outside the checkout defends against *accidental*
overwrite; process + filesystem isolation is what defends against a *hostile* dependency actively
trying to forge a passing result or steal a credential.

---

## 3. Evidence immutability — required enforcement changes (corrects the baseline)

**Problem (confirmed in code):** `verification_evidence` grants `update, delete` to `app_server`,
so an accepted evidence row could be altered or deleted by the app role. Only
`verification_requests` is locked down. Adjudicated evidence must be append-only.

**Required changes (to implement later; not applied now):**

1. **Revoke write-after-insert in `rls.sql`:** change the evidence grant to
   `grant select, insert on verification_evidence to app_server;` and
   `revoke update, delete on verification_evidence from app_server;` — mirroring
   `verification_requests`. The app only ever `INSERT`s evidence (idempotent
   `onConflictDoNothing` + reselect), so revoking UPDATE/DELETE is **functionally inert** for the
   happy path and removes the tamper surface.
2. **Defense in depth — append-only trigger:** attach the existing `app.forbid_mutation()`
   pattern (already used for messages/audit logs) to `verification_evidence` so UPDATE/DELETE is
   rejected even for a role that somehow retains the grant.
3. **Migration + pins:** ship as a new journaled migration (`db:generate`), bump
   `PRODUCTION_PINS` endpoint+count (STAGING_PINS unchanged), and add a regression test asserting
   a direct `UPDATE`/`DELETE` on `verification_evidence` as `app_server` is rejected (the request
   test already does this for requests).
4. **Correction/withdrawal semantics:** because evidence is append-only, a mistaken or superseded
   submission is never edited — a new attempt is appended (§5), and the contract's current state
   is *derived* from the accepted rows, never by mutating a row.

### 3.1 Append-only triggers vs. foreign-key cascades
A `BEFORE DELETE` append-only trigger on `verification_evidence` **fires during a cascade** — a
cascaded delete is still a delete on the child row — so an `ON DELETE CASCADE` from a parent
(org → project → task → request → evidence) would hit the trigger and the whole parent delete would
abort. That interaction must be designed, not discovered in production:

- **Parent FKs to evidence/requests use `ON DELETE RESTRICT` (or `NO ACTION`), not `CASCADE`.**
  Deleting a project/task/request that has evidence is blocked while evidence exists, which is the
  correct default for an immutable audit record — you cannot silently erase verification history by
  deleting a parent. (This also makes the failure explicit and early, rather than a cascade
  aborting deep in a trigger.)
- **The trigger distinguishes "app mutation" from "governed retention", by ROLE — not a settable
  flag.** Reject `UPDATE` unconditionally and reject `DELETE` from `app_server`. A `DELETE` is
  permitted **only** when the current database role is the dedicated retention role *and* the delete
  is happening inside the retention `SECURITY DEFINER` function that owns the purge lifecycle
  (§3.2). Authorization is the **restricted role + function ownership**, established by grants and
  `pg_has_role`/`current_user` checks — **not** possession of a custom GUC. A GUC, if used at all,
  is only an in-transaction assertion the definer function sets for its own bookkeeping; setting it
  never confers permission. `app_server` has neither the DELETE grant nor the ability to execute the
  function, so ordinary code can never delete.

### 3.2 Retention / erasure cleanup — recoverable, role-authorized (the sanctioned delete path)
Immutable ≠ eternal. Legal retention windows and tenant-offboarding erasure still need a way to
remove evidence — through a governed, **crash-recoverable** lifecycle, never `app_server`, and never
authorized by a GUC alone:

- **Authorization** is a dedicated least-privilege **retention role** (analogous to `purge_agent`)
  that holds the only `DELETE` grant on `verification_evidence`, and a `SECURITY DEFINER` function
  owned by that role that is the *only* way to perform a purge. `app_server` cannot execute it. The
  function enforces the policy (age-based expiry or an explicit erasure request) and writes an
  audit row for every action.
- **Durable purge job recorded BEFORE any reference is removed.** In one transaction the function
  (1) inserts a `verification_purge_jobs` row capturing the **exact object keys and `versionId`s**
  to delete (plus tenant, reason, requester, timestamp), and (2) removes/tombstones the evidence
  references. Because the job row is committed with the reference removal, the object identifiers
  are never lost even if the process dies immediately after — the keys to clean up are durably
  recorded first.
- **Object deletion is retried and audited, out of band.** A separate retention worker reads open
  purge jobs and deletes each listed object (conditional-create keys removed outright; pinned
  versions deleted by `versionId`, only after any Object-Lock retention lapses), marking each object
  `deleted` with an audit entry and **retrying** transient failures. A purge job is complete only
  when every listed object is confirmed gone; a crash mid-job is resumed from the recorded list, so
  no object is orphaned and no deletion is silently skipped.
- **Order of operations across FKs:** because parents are `RESTRICT`, offboarding deletes child-up
  (evidence → requests → task → project) through the retention function, each step audited, so there
  is no cascade racing the trigger.
- **Effect on contract status:** removing required artifacts changes a contract's *current*
  deliverability (§5.4), never its historical evidence record.

---

## 4. Concrete storage-provider guarantees

Object Lock alone does **not** prevent a *new version* from being written over a key, so it is not
sufficient. This section pins the initial provider, the exact upload mechanism, and how one signed
grant *intends* to jointly enforce size, checksum, and no-overwrite — with the explicit caveat
(§4.7) that none of these enforcement properties may be claimed as guaranteed until provider
acceptance tests pass against the actual provider and SDK version.

### 4.0 Initial provider: AWS S3 (single target; no portability claim)
The initial and only targeted provider is **AWS S3** (the project already runs `STORAGE_DRIVER=s3`).
This document does **not** claim portability to GCS, R2, MinIO, or other S3-compatible stores:
conditional writes, checksum headers, and presign hoisting behavior differ between them, and each
would need its own acceptance-test pass (§4.7) and possibly its own conditional-header syntax before
it could be added. Adding a second provider is a future, separately-verified decision (§8), not an
assumed capability.

### 4.1 Mechanism: presigned **PUT**, not POST
Two candidate mechanisms and why PUT is chosen (S3):

| Property | Presigned **PUT** (SigV4 signed headers) | Presigned **POST** (browser form policy) |
|---|---|---|
| No-overwrite | **Native & atomic** — sign `If-None-Match: *` as a required header (S3 conditional writes); the PUT fails `412` if the key already exists. | No first-class conditional-create; you fall back to unique keys + a separate existence check (a TOCTOU race). |
| Size | **Exact** — sign the `Content-Length` header; the store rejects any other length. | **Range** — `content-length-range` min…max policy condition. |
| Checksum | Sign `x-amz-checksum-sha256`; the store computes and **rejects a mismatch** server-side. | `x-amz-checksum-sha256` allowed as a form field / policy condition. |
| Single object | URL is bound to one exact key + verb. | Policy can allow a key *prefix* (`starts-with`) — looser. |

**Decision: presigned PUT.** Its `If-None-Match: *` conditional gives atomic no-overwrite (the
property we care most about, §4.4), and because the runner already declares each artifact's exact
`sizeBytes` and `sha256` in the grant request (§3-runner flow), the Hub can sign an **exact**
`Content-Length` rather than a loose range. POST's only advantage (a size *range*) is unnecessary
when the size is known up front, and POST lacks conditional-create. All enforcement claims are
subject to §4.7.

### 4.2 How one grant jointly enforces size + checksum + no-overwrite
The Hub issues a presigned PUT to a **server-generated key** (§4.3) with three signed constraints,
all enforced by the provider on the single PUT — the client cannot drop or alter any of them
without invalidating the signature:

- **Size:** signed `Content-Length: <declared sizeBytes>` (exact). A longer/shorter body → the PUT
  is rejected. The declared size is also range-checked against the per-artifact cap (§4.5) *before*
  signing, so an oversize artifact never gets a grant.
- **Checksum:** signed `x-amz-checksum-sha256: <declared sha256>`. The store recomputes the digest
  on receipt and returns `400 BadDigest` on mismatch — the runner cannot upload bytes that differ
  from what it declared. Ingest re-verifies the digest on read as defense in depth.
- **No-overwrite:** signed `If-None-Match: *`. If an object already exists at that key the PUT
  returns `412 PreconditionFailed`, so an accepted artifact can never be clobbered by a replayed or
  racing PUT. (S3 conditional-write semantics; see §4.7 — this must be acceptance-tested against the
  live endpoint before it is relied on.)

These three *are intended to* ride on **one** signed PUT so there is no window in which a body of the
wrong size, wrong digest, or targeting an existing key is accepted. That the SDK actually signs each
header (rather than hoisting or dropping it) is exactly what §4.7 verifies.

### 4.3 Safe keys: opaque server-generated object IDs, validated logical paths
The runner never supplies or influences the storage key. To avoid any path-injection or malformed-key
risk, the storage key's leaf is an **opaque server-generated object ID (UUIDv4)**, not a
client-supplied filename:

`org/<id>/project/<id>/request/<requestId>/attempt/<attemptId>/<objectId>`

The artifact's **logical path** (e.g. `test-results.json`) is carried separately as *validated
metadata* on the evidence/grant row — validated for allowed charset, length, and no traversal
(`..`, leading `/`, backslashes, control bytes rejected) — and is used only for display and for
matching required-artifact names, never as a storage-key segment. This decouples the object location
(opaque, collision-free, tenant-scoped) from any user-controlled string. Per-attempt namespacing
means retries never collide (§5).

### 4.4 No-overwrite of accepted evidence — pick one and pin it
- **(A) Conditional create (preferred):** the `If-None-Match: *` PUT above; keys are never reused,
  so a create that finds the key present fails atomically. Simplest, and needs no versioning.
- **(B) Pinned versions:** if bucket versioning must stay on, the Hub records the exact `versionId`
  returned on first upload in the evidence row and **only ever reads that versionId**; a later
  version of the same key is ignored, and Object Lock (compliance mode) prevents deleting/overwriting
  that specific version. Use only when versioning cannot be disabled — note Object Lock alone still
  allows *new* versions, so it must be paired with version pinning, not relied on by itself.

### 4.5 Size caps
Per-artifact hard cap (proposed **25 MB**, checked before signing and enforced by the signed exact
`Content-Length`) and a per-submission aggregate (proposed **100 MB**) reserved atomically (§4.6).

### 4.6 Atomic aggregate-quota accounting, and in-flight grants
Issuing grants must not oversubscribe a project's storage/aggregate cap under concurrency. Reserve
quota **transactionally** in the DB before returning a grant (a single
`UPDATE … SET used = used + :n WHERE used + :n <= :cap` that fails atomically when it would exceed
the cap), tie the reservation to the `(attemptId, objectId)`. No read-then-write race; the DB row is
the single serialization point.

**A grant's quota reservation is NOT released on URL expiry.** A presigned URL's expiry is checked by
S3 at the *start* of the request, so a large PUT that began before expiry can still land afterward —
releasing the reservation at expiry would let those bytes exceed the cap. The reservation is released
only when the upload is **definitively resolved**:

- **Finalize:** on confirmed upload (the object exists with the declared size/checksum) the
  reservation converts from *reserved* to *committed* — no change in bytes counted, just state.
- **Confirmed-absent after a drain window:** a reservation may be reclaimed only after a drain
  window **longer than the maximum allowed upload duration**, and only after a `HEAD` confirms **no
  object landed** at the key. Then the reserved bytes are released.
- **Orphan (grant expired but bytes landed):** if the drain-window `HEAD` finds an object that no
  accepted evidence references, it is an orphan; it is handed to the cleanup path (§3.2 delete
  semantics) and the reservation is released **only after** that deletion is confirmed. Because keys
  are conditional-create and unique per `(attempt, objectId)`, a late orphan can never overwrite
  accepted evidence.

So bytes that can still land keep holding quota until they are proven gone.

### 4.7 Provider acceptance tests — required before any enforcement claim
The size/checksum/no-overwrite properties above are **intended behavior, not yet guaranteed**. They
may be described as *enforced* only after the following pass against the actual S3 endpoint and the
pinned AWS SDK version (run in the disposable acceptance harness, §7, against a throwaway bucket —
no production bucket, no provisioning here):

1. **Exact SDK signing behavior:** presign a `PutObject` with `ContentLength`, `ChecksumSHA256`, and
   `IfNoneMatch: '*'`, and assert each is in `SignedHeaders` and is sent as a *signed header* (not
   hoisted to the query string, not silently dropped). Tampering any of the three after signing must
   break the signature (`403 SignatureDoesNotMatch`).
2. **Checksum encoding:** `x-amz-checksum-sha256` must be the **base64** encoding of the raw 32-byte
   SHA-256 digest — **not** the hex string the runner declares in evidence. The grant path must
   convert hex→base64; assert a correctly base64-encoded digest is accepted and a hex-string value is
   rejected. Ingest continues to store/compare the hex form.
3. **Size:** a body whose length ≠ the signed `Content-Length` is rejected.
4. **Checksum mismatch:** a body whose bytes don't match the declared digest returns `400 BadDigest`.
5. **No-overwrite:** a second PUT to an existing key with `If-None-Match: *` returns
   `412 PreconditionFailed`.

Until items 1–5 pass on the chosen endpoint+SDK, the doc/implementation must say "intended,
unverified", and the ingest-side re-verification (digest on read) remains the backstop.

---

## 5. Attempt IDs, retries, and accepted-vs-verified

- **Attempt identity:** every execution is a distinct `(runId, attemptId)`; a rerun of a failed
  check at the **same commit** is a **new attempt** with a new `attemptId` and a new
  `idempotencyKey`, producing a **new** evidence row. Earlier attempts are never overwritten
  (append-only, §3). Storage keys are per-attempt (§4.3), so artifacts never collide.
- **Idempotency vs. retry:** the idempotency unique key `(org, project, request_id,
  idempotency_key)` makes an *identical* resubmission a no-op replay, while a *new attempt* (new
  key) is a fresh row. Submitting a changed bundle under a reused idempotency key is a conflict,
  not an overwrite.
- **Accepted ≠ verified_complete (already modeled; make it explicit):**
  - `accepted = true` means the submission was admissible and **recorded** — it passed
    signature/binding and is a legitimate attempt. It says nothing about pass/fail.
  - `status = verified_complete` (+ `deliverable = true`) is the only state that authorizes a
    "this task's result is delivered" claim; a non-zero exit or missing artifact yields
    `accepted = true, status = verification_failed`.
  - So a failed attempt is a real, accepted, immutable record; a later attempt at the same commit
    can reach `verified_complete` **without** deleting the failed one.
- **Contract state is derived, not stored-by-mutation:** whether a contract is currently verified is
  *computed* from its accepted, non-invalidated evidence rows and present artifact availability — see
  §5.1 — never by editing a status field on an earlier row.

### 5.1 Historical pass evidence vs. current verification / deliverability
Two distinct questions, deliberately **not** conflated:

- **Historical evidence (immutable fact):** "did an accepted attempt at the pinned commit report
  `verified_complete`?" A permanent property of the append-only rows; never rewritten, and
  out-of-order arrival doesn't change any row's facts.
- **Current verification / deliverability (derived, present-tense):** "may we act on this contract as
  verified *right now*?" A computed judgment — never a mutated flag — that depends on (a) the
  owner-selected resolution policy over conflicting attempts (§5.2), (b) whether any attempt has been
  withdrawn/invalidated (§5.3), and (c) whether the required artifacts are still present and
  retrievable (§5.4). It can move from deliverable to not-deliverable with **no** historical row
  changing.

A contract can therefore hold historical pass evidence yet **not** be currently deliverable —
conflicting results unresolved by policy, an invalidated attempt, or purged artifacts.

### 5.2 Conflicting / out-of-order attempts — resolution is an OWNER DECISION, not a guarantee
All attempts are retained and visible; arrival order never changes the recorded facts. How conflicts
resolve into a *current* verdict is an explicit owner choice (§8). **This document does not assert
"any pass wins" as an established guarantee.**

- Candidate policies over the same immutable evidence set: **(P1)** any accepted pass at the pinned
  commit ⇒ deliverable (permissive, order-independent, flake-tolerant); **(P2)** the latest accepted
  attempt must be `verified_complete` (treats a later failure as a regression signal); **(P3)** no
  failing accepted attempt may exist at the pinned commit (zero-tolerance).
- **Default until the owner selects a policy:** a contract whose accepted attempts *disagree* is
  surfaced as **`conflicting` (undecided)** and is **not** treated as deliverable. Conflicts are
  always shown (attempt counts + a `conflicting` flag), whatever policy is later chosen. The system
  does not silently adopt P1.
- An attempt reporting internal inconsistency (`invalid_checks`) is not `accepted` as verified in the
  first place, so it never contributes a pass. Idempotent duplicates (same idempotency key) are one
  logical attempt — neither a second pass nor a conflict.

### 5.3 Append-only withdrawal / invalidation
Evidence is never edited or deleted, but an attempt can be **withdrawn or invalidated** without
breaking immutability by *appending* an immutable **invalidation record** — its own row — referencing
the target `attemptId` with actor, reason, and timestamp (e.g. the runner key was later found
compromised, tampering was discovered, or the attempt ran in the wrong environment):

- **Governed:** only an authorized human (admin) or trusted Hub orchestration may append an
  invalidation — never the runner that produced the evidence.
- **Audit-preserving:** the target row stays; you can always see the attempt existed and that it was
  invalidated, by whom and why.
- **Excluded from the current verdict:** derivation (§5.1) ignores invalidated attempts — an
  invalidated pass no longer counts toward deliverability under *any* policy, and an invalidated fail
  no longer counts as a conflict.
- This is **not** the retention/erasure delete path (§3.2): the bytes and rows remain; only their
  standing in the current verdict changes.

### 5.4 When required artifacts expire or are purged
Current deliverability requires the contract's **required artifacts to still be present and
retrievable** — the availability check applies at query time, not only at submission. If required
artifacts expire under a retention window or are removed by the purge path (§3.2):

- The contract can no longer satisfy availability → its **current** status drops from deliverable to
  **`evidence_expired` (unverifiable-now)**, even though the historical fact "an attempt once passed"
  is retained in the (possibly tombstoned) evidence record.
- Regaining deliverability requires a **new attempt** at the same commit that re-uploads the required
  artifacts — never a mutation of past rows.
- The purge job (§3.2) records the transition, so the drop to `evidence_expired` is auditable and
  explained, not a silent disappearance.

---

## 6. Machine authentication across both ingestion paths

### 6.1 Key lookup *before* tenant context exists (the chicken-and-egg)
Authenticating a machine caller must not itself require tenant context (RLS GUCs), because those
GUCs are derived *from* the key.

- Runner presents `Authorization: Bearer <keyId>.<secret>`.
- A dedicated **pre-tenant lookup** resolves `keyId` without tenant scoping: either a
  `SECURITY DEFINER` function that returns only `{orgId, projectId, secretHash, status,
  expiresAt, revokedAt, signingKeyVersion}` for that `keyId`, or a minimal system connection that
  may read only the `verification_runner_keys` table by id. No other table is reachable on this
  path.
- The Hub verifies the secret against `secretHash` in constant time, checks `active` (not expired,
  not revoked), then **builds the TenantContext from the key's own org/project** and stamps the
  RLS GUCs. From that point every query is tenant-scoped exactly as a human session's would be.
- Guard: `requireRunnerOrTenant(projectKey, req)` — runner credential path (above) **or** the
  existing `requireTenant` human path, never both; neither ⇒ 401. The resolved tenant's
  `projectId` must equal what `projectKey` resolves to, or 403.

### 6.2 Explicit endpoint permissions
| Endpoint | Human session | Runner credential | Hub orchestration |
|---|---|---|---|
| Create contract (`POST …/requests`) | admin/member (viewer 403) | **denied** | allowed (internal) |
| Read assigned contract(s) (`GET …/requests…`) | project member | allowed (own project) | allowed |
| Upload grant (`POST …/uploads`) | denied | allowed (own project) | denied |
| Submit evidence (`POST …/verification`) | allowed (signature still required) | allowed | n/a |

Enforced twice: in the guard (principal type) and by RLS (GUCs stamped from the resolved
principal, never the payload).

### 6.3 Signing-key version + revocation on **both** paths
- The signature envelope carries the **signing-key version** used. Ingest recomputes the HMAC
  with the pinned/currently-valid version(s) and rejects an unknown/retired version
  (`bad_signature_version`), whether the caller authenticated as machine or human.
- **Revocation** is enforced at ingest regardless of path: a revoked bearer key (machine) and a
  retired signing-key version both reject; unsetting the master secret disables all ingestion.
  Human-session submitters do not bypass any of this — the **signature is always required and its
  version/revocation always checked**.

### 6.4 Trust boundary — what HMAC does and does not prove
HMAC proves **who signed** (the project's signing key) and that the **payload was not altered in
transit**. It does **not** prove the execution was truthful — a signer with a valid key can sign
false claims. Truthfulness rests on §2: the exit codes/timestamps are captured by an out-of-tree
harness the checked-out code cannot forge, and the command catalog is pinned to the contract.
The signature and the harness are complementary; neither alone is sufficient. This limitation is
stated so no reviewer over-reads "signed" as "proven-executed."

---

## 7. Disposable end-to-end acceptance plan (exercises every boundary above; runs only when built)

Same discipline as prior VER-002 runs: throwaway `*_test` DB, non-superuser `app_server` role,
local stubs, real cleanup, never prod creds.

1. **Runner cannot author requirements (§1):** runner credential `POST …/requests` → **denied**;
   a submission that drops/narrows a required check or a required artifact → rejection; contract
   requirements are read from the store, not the payload.
2. **Catalog pin (§2.1):** evidence whose `catalog_digest` ≠ the contract's pinned digest →
   `catalog_mismatch`; a check whose `command` ≠ the pinned catalog entry → rejection.
3. **Harness process/filesystem isolation (§2.2–2.3):** a repo that writes a forged `results.json`
   into the checkout is ignored (records come from the out-of-tree harness); and, beyond the path,
   a probe run as the execution uid **cannot** write the harness result sink (mode `0700`, other
   uid), cannot read the collector's env/secrets, and cannot `ptrace` the collector; network egress
   from the execution sandbox is blocked unless the catalog declares the check needs it.
4. **Evidence immutability + cascade + recoverable retention (§3):** as `app_server`, a direct
   `UPDATE`/`DELETE` on `verification_evidence` is rejected (grant revoked + trigger); a parent
   delete that would `CASCADE` into evidence is **RESTRICTed** (blocked) while evidence exists; the
   trigger fires on a cascaded delete path, not only a direct one; a purge runs **only** via the
   retention role's `SECURITY DEFINER` function (merely setting a GUC as `app_server` does **not**
   authorize a delete); and a simulated crash *after* the purge-job row commits but *before* object
   deletion leaves the job resumable — the recorded keys/versionIds are re-read and the objects are
   deleted on retry, with an audit row per object.
5. **Storage joint enforcement — provider acceptance (§4.7):** against a throwaway S3 bucket + the
   pinned SDK, one presigned **PUT** simultaneously rejects (a) a wrong `Content-Length`, (b) a
   checksum-mismatched body, and (c) a PUT to an already-present key (`If-None-Match: *` → 412);
   `x-amz-checksum-sha256` is verified to be **base64** of the raw digest (a hex value is rejected);
   each constraint header is confirmed **signed** (post-signing tampering → `403`); a runner-supplied
   key is refused (server generates opaque object IDs); a logical path with traversal/backslash/
   control bytes is rejected as metadata. Until these pass, enforcement is "intended, unverified".
6. **Quota vs. in-flight grants (§4.6):** a reservation is **not** released at URL expiry; it is
   released only on finalize, or after a drain-window `HEAD` confirms no object landed, or after a
   late orphan is deleted — a simulated slow PUT that lands *after* expiry keeps holding quota until
   resolved.
7. **Historical vs current status, withdrawal, expiry (§5.1–5.4):** a failed re-run at the same
   commit appends a new `attemptId` without touching the earlier row; `accepted=true,
   status=verification_failed` is distinct from a later `verified_complete`; **conflicting** attempts
   are surfaced and, absent a selected policy, the contract is **not** deliverable (P1 is not
   auto-applied); an appended **invalidation** record drops an attempt from the current verdict while
   the row remains for audit; and purging a required artifact moves current status to
   `evidence_expired` while the historical pass record persists.
8. **Machine auth (§6):** a valid runner key creates evidence with **no cookie**; a revoked or
   expired key is rejected on the next request (pre-tenant lookup); a retired signing-key version
   is rejected on **both** the machine and human submission paths; the global kill-switch (unset
   master) disables ingestion.
9. **Full happy path:** assigned contract → out-of-tree harness runs pinned-catalog commands →
   presigned per-attempt upload → sign (versioned key) → submit → `verified_complete`; plus
   stale-commit and wrong-repo (case-insensitive, per #105) rejections.

---

## 8. Remaining owner decisions

1. **CI substrate:** GitHub Actions (`source: 'github_actions'` already modeled) vs a self-hosted
   runner — drives the OIDC-to-secret exchange and network posture for the attestation stage.
2. **Storage provider + no-overwrite strategy:** confirm **AWS S3** as the initial provider (§4.0)
   — a second/alternative provider is a separate, acceptance-tested decision, not assumed. Within S3,
   conditional-create keys (§4.4A, preferred) vs versioning + pinned `versionId` + Object Lock
   (§4.4B). Confirm a dedicated verification bucket and that the Hub role may presign while the runner
   holds no standing bucket credentials. **Enforcement claims gate on §4.7 acceptance tests.**
3. **Catalog location & change process:** in-repo `verification-checks.*.json` reviewed via PR
   (recommended) vs a DB table changed by an admin action.
4. **Size/quota caps:** ratify per-artifact (25 MB), per-submission (100 MB), and the per-project
   aggregate cap + what happens when it's hit.
5. **Contract-creation orchestration principal:** define the trusted internal principal that
   creates contracts on the runner's behalf (the GM/orchestrator path) and how it is authorized,
   distinct from any runner credential.
6. **Runner-key backend:** the Hub's own `verification_runner_keys` (hash-at-rest, one-time
   secret) vs an external secrets manager. Master HMAC secret stays a single server-side env
   value either way.
7. **`verified_complete` → `task.status`:** keep separate (no enum change) or gate task
   completion on a verified contract, and when.
8. **Enable trigger:** first setting of `VERIFICATION_RUNNER_MASTER_SECRET` (≥32 chars) in
   staging, behind the existing signed-receipt migration ceremony — the point at which ingestion
   goes from "safely disabled" to live.
9. **Conflict-resolution policy (§5.2) — REQUIRED, currently undecided:** choose P1 (any accepted
   pass ⇒ deliverable), P2 (latest accepted must pass), or P3 (no failing attempt may exist). Until
   chosen, conflicting contracts are surfaced as `conflicting` and are **not** deliverable — "any
   pass wins" is not a default guarantee.
10. **Retention/erasure policy (§3.2):** define the age-based retention window and the
    tenant-offboarding erasure path, run by the governed retention role via its `SECURITY DEFINER`
    function (never `app_server`, never a GUC alone), with the recoverable purge-job lifecycle.
11. **Artifact-expiry behavior (§5.4):** confirm that expiring/purging required artifacts drops a
    contract to `evidence_expired` (current), preserving the historical pass record, and requires a
    fresh attempt to regain deliverability.

---

### Change log
- **rev. 4:** separated historical pass evidence from current verification/deliverability, demoted
  "any pass wins" to an explicit undecided owner policy (default: conflicting ⇒ not deliverable),
  added append-only withdrawal/invalidation and artifact-expiry → `evidence_expired` (§5.1–5.4);
  committed to AWS S3 as the single initial provider and removed blanket S3/R2/GCS portability claims,
  documented exact SDK signing + `x-amz-checksum-sha256` base64 encoding, and gated size/checksum/
  no-overwrite claims on provider acceptance tests (§4.0, §4.7); made retention crash-recoverable via
  a durable purge job recorded before reference removal + retried/audited object deletion, and
  authorized it by restricted role + `SECURITY DEFINER` function rather than a GUC (§3.1–3.2); closed
  upload-lifecycle gaps with opaque server-generated object IDs + validated logical paths and quota
  that is not released on URL expiry while an in-flight upload can still land (§4.3, §4.6); acceptance
  plan + owner decisions updated (§7, §8). CI on the prior rev. 3 commit `12f4e26`: all 5 gates green.
- **rev. 3:** upload mechanism pinned to presigned **PUT** with the PUT-vs-POST tradeoff and how one
  signed PUT jointly enforces exact `Content-Length`, `x-amz-checksum-sha256`, and `If-None-Match: *`
  no-overwrite (§4.1–4.2); append-only trigger × FK cascade (parents `RESTRICT`, trigger fires on
  cascade) and the governed retention/erasure delete path (§3.1–3.2); harness protection via
  process/filesystem isolation — separate uid, sandbox, no-ptrace, network-off — not merely a path
  (§2.3); contract-status derivation under conflicting/out-of-order attempts (existence-based,
  monotonic, conflict-flagged) (§5.1); acceptance plan + owner decisions updated (§7, §8). CI on the
  prior rev. 2 commit `c6982a3`: all 5 gates green.
- **rev. 2:** runner cannot author requirements (§1); catalog version/digest pinned to contract +
  out-of-tree harness (§2); **corrected** evidence-immutability baseline and specified the grant
  revoke + append-only trigger + migration/pins (§3); concrete storage guarantees incl. conditional
  writes / pinned versions, server keys, checksum/size, atomic quota (§4); attempt IDs, retries,
  accepted-vs-verified (§5); pre-tenant key lookup, endpoint matrix, signing-key
  version/revocation on both paths, HMAC trust-boundary statement (§6); acceptance plan expanded to
  exercise all of the above (§7). Related fix: PR #105 (repository-name consistency), unmerged.
