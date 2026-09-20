# VER-002 External-Runner Integration — Design (rev. 2)

**Status:** DESIGN ONLY. Nothing here is implemented, and no secret, bucket, role, migration, or
credential is provisioned. Deployments and staging/production migrations remain paused. This
document exists to be reviewed and to pin down owner decisions before any build.

**Model.** The Hub is an *adjudicator* (Option A): authorized humans (or trusted Hub
orchestration) create an immutable verification **contract**; an external **runner** checks out
the pinned commit, runs the contract's required checks, uploads artifacts, and submits **signed**
evidence; the Hub decides `verified_complete` or a typed rejection. The Hub never runs commands.

Revision 2 resolves six review points and **corrects an error in rev. 1's baseline** (evidence
was described as DB-immutable; it is not yet — see §3).

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
  result record to a directory the checked-out code cannot write to (separate mount/uid, or a
  path the sandbox mounts read-only to the test stage and read-write only to the harness). The
  attestation stage (§4/§6) reads authoritative records **only** from that location — never from
  files the test code could have written.
- **Consequence:** even a malicious dependency that writes a fake `results.json` into the
  checkout cannot influence the signed evidence, because the signer reads the harness's records,
  not the checkout's.

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

---

## 4. Concrete storage-provider guarantees

Object Lock alone does **not** prevent a *new version* from being written over a key, so it is not
sufficient. Specify the following, provider-side:

1. **No-overwrite of accepted evidence — pick one and pin it:**
   - **(A) Conditional create:** issue presigned PUTs with `If-None-Match: *` (S3 conditional
     writes) so a PUT to an existing key fails; keys are never reused (§4.3). **Preferred** for
     simplicity.
   - **(B) Pinned versions:** if bucket versioning is on, the Hub records the exact `versionId`
     returned on first upload in the evidence row and **only ever reads that versionId**; a later
     version of the same key is ignored. Object Lock (compliance mode) additionally prevents
     deleting/overwriting that specific version. Use this only if versioning must stay on.
2. **Safe, server-generated keys:** the Hub computes every storageKey
   (`org/<id>/project/<id>/request/<requestId>/attempt/<attemptId>/<path>`). The runner never
   supplies or influences the key, so it cannot target another tenant's prefix or an existing
   accepted object. Per-attempt namespacing means retries never collide (§5).
3. **Checksum + size enforced by the store, not just the Hub:** the presign binds
   `x-amz-checksum-sha256` (declared digest) and a `content-length-range` policy (min…max), so the
   store rejects a body whose digest or size differs from what was declared. Ingest re-verifies
   digest on read (belt and suspenders).
4. **Size limits:** per-artifact hard cap (proposed **25 MB**) and per-submission aggregate
   (proposed **100 MB**), both encoded into the presign policy.
5. **Atomic aggregate-quota accounting:** issuing grants must not oversubscribe a project's
   storage/aggregate cap under concurrency. Reserve quota **transactionally** in the DB before
   returning a grant (a single `UPDATE … SET used = used + :n WHERE used + :n <= :cap` that
   fails atomically when it would exceed the cap), tie the reservation to the `attemptId`, and
   finalize/release it on confirmed upload or grant expiry. No read-then-write race; the DB row
   is the single serialization point.

---

## 5. Attempt IDs, retries, and accepted-vs-verified

- **Attempt identity:** every execution is a distinct `(runId, attemptId)`; a rerun of a failed
  check at the **same commit** is a **new attempt** with a new `attemptId` and a new
  `idempotencyKey`, producing a **new** evidence row. Earlier attempts are never overwritten
  (append-only, §3). Storage keys are per-attempt (§4.2), so artifacts never collide.
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
- **Contract verification state is derived, not stored-by-mutation:** "is this contract
  verified?" is computed from its accepted evidence rows (a verified attempt exists), never by
  editing a status field on an earlier row.

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
3. **Harness isolation (§2.2):** a repo that writes a forged `results.json` into the checkout is
   ignored — the accepted exit codes/timestamps come from the out-of-tree harness; a probe
   asserts the test stage cannot write the authoritative record location.
4. **Evidence immutability (§3):** as `app_server`, a direct `UPDATE`/`DELETE` on
   `verification_evidence` is rejected (grant revoked + trigger); an accepted row is unchanged by
   any later submission.
5. **Storage guarantees (§4):** a second PUT to an accepted key fails (conditional-create or
   pinned-version); an oversize or checksum-mismatched body is rejected by the store; a
   runner-supplied key is refused (server generates keys); concurrent grants cannot exceed the
   aggregate cap (atomic reservation).
6. **Attempts & retries (§5):** a failed check re-run at the same commit appends a new
   `attemptId` row without touching the earlier one; an identical resubmission is an idempotent
   no-op; `accepted=true, status=verification_failed` is distinct from a later
   `verified_complete`.
7. **Machine auth (§6):** a valid runner key creates evidence with **no cookie**; a revoked or
   expired key is rejected on the next request (pre-tenant lookup); a retired signing-key version
   is rejected on **both** the machine and human submission paths; the global kill-switch (unset
   master) disables ingestion.
8. **Full happy path:** assigned contract → out-of-tree harness runs pinned-catalog commands →
   presigned per-attempt upload → sign (versioned key) → submit → `verified_complete`; plus
   stale-commit and wrong-repo (case-insensitive, per #105) rejections.

---

## 8. Remaining owner decisions

1. **CI substrate:** GitHub Actions (`source: 'github_actions'` already modeled) vs a self-hosted
   runner — drives the OIDC-to-secret exchange and network posture for the attestation stage.
2. **Storage no-overwrite strategy:** conditional-create keys (§4.1A, preferred) vs versioning +
   pinned `versionId` + Object Lock (§4.1B). Confirm a dedicated verification bucket and that the
   Hub role may presign while the runner holds no standing bucket credentials.
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

---

### Change log
- **rev. 2:** runner cannot author requirements (§1); catalog version/digest pinned to contract +
  out-of-tree harness (§2); **corrected** evidence-immutability baseline and specified the grant
  revoke + append-only trigger + migration/pins (§3); concrete storage guarantees incl. conditional
  writes / pinned versions, server keys, checksum/size, atomic quota (§4); attempt IDs, retries,
  accepted-vs-verified (§5); pre-tenant key lookup, endpoint matrix, signing-key
  version/revocation on both paths, HMAC trust-boundary statement (§6); acceptance plan expanded to
  exercise all of the above (§7). Related fix: PR #105 (repository-name consistency), unmerged.
