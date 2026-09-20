# VER-002 External-Runner — Implementation Plan

Companion to `external-runner-design.md` (rev. 4). Turns the design into an ordered set of
**independently reviewable PRs**. Nothing here is implemented yet; no resources are provisioned, no
money is spent, nothing is deployed, staging/production migrations remain paused, and StressProbe is
untouched.

**Sequencing principle.** Every PR merges safely with **ingestion still disabled**
(`VERIFICATION_RUNNER_MASTER_SECRET` unset ⇒ the ingest path rejects everything). Nothing goes live
until the final enablement ceremony. Each PR is reviewable on its own and verified on **disposable
databases / throwaway buckets only**; because staging/prod migrations are paused, merged migrations
are **not** applied to staging/prod in this phase.

## Two gates carried forward (apply wherever named below)
- **Gate A — provider is a proposal, not a fact.** `STORAGE_DRIVER=s3` is a dev default; it does
  **not** establish AWS S3 as the chosen provider. Storage work is written against the existing
  `ObjectStore` port, and S3 is selected only by an explicit owner decision (PR-4) plus a passing
  acceptance run (PR-5). No enforcement property (size/checksum/no-overwrite) may be *claimed* until
  PR-5 is green against the actual endpoint+SDK.
- **Gate B — quota is reclaimed only on proof an upload cannot still complete.** A reservation is
  never released on URL expiry. PR-6 must **document and enforce a maximum upload duration** so the
  drain window is provably longer than any in-flight PUT, then confirm absence with a `HEAD`.

---

## Ordered PRs

| # | PR | What it lands | Independently reviewable because | Turns anything on? |
|---|----|----|----|----|
| **1** | **Evidence immutability + FK RESTRICT** | `rls.sql` revoke UPDATE/DELETE on `verification_evidence` + `app.forbid_mutation()` trigger; flip verification FKs `cascade → restrict`; journaled migration; `PRODUCTION_PINS` bump; regression. | Pure DB hardening of an existing table; no runner, storage, or auth. Corrects a confirmed current gap. | No |
| **2** | **Machine-principal auth foundation** | `verification_runner_keys` table (hash-at-rest); pre-tenant `keyId` lookup (`SECURITY DEFINER` fn); `requireRunnerOrTenant` guard; endpoint permission matrix; signing-key version + revocation checks on both paths. | Auth layer only; human path unchanged; ingestion stays disabled. | No |
| **3** | **Contract retrieval + catalog pin** | `GET …/requests/assigned` (runner-auth, read-only); `catalog_version`/`catalog_digest` columns pinned at creation; ingest rejects `catalog_mismatch` and non-matching commands. | Extends the existing create/ingest paths; no storage/runner. | No |
| **4** | **Upload-grant endpoint (mechanism only)** | `POST …/uploads` issuing a presigned PUT via the `ObjectStore` port; opaque server-generated object IDs + validated logical paths; server-generated keys. **Claims no enforcement yet.** | Mechanism behind the existing port; **Gate A** — provider chosen here, not assumed. | No |
| **5** | **Provider acceptance tests (§4.7)** | The suite proving size / checksum-encoding / no-overwrite against a **throwaway** bucket + pinned SDK. Flips upload docs from "intended" to "enforced" only when green. | Test-only; **Gate A** unblock. Live run deferred until the owner authorizes a disposable bucket (provisioning/spend — not now). | No |
| **6** | **Quota accounting + in-flight reclamation** | Atomic reservation/finalize; **Gate B** — max-upload-duration enforcement + drain-window reclamation + `HEAD` proof; orphan handoff to cleanup. | Builds on PR-4 keys; self-contained accounting. | No |
| **7** | **Recoverable retention path** | `verification_purge_jobs` table; retention role + `SECURITY DEFINER` purge fn; retried/audited object deletion; enables safe parent deletion again. | Closes the deletion side of PR-1's RESTRICT; governed, role-authorized. | No |
| **8** | **Runner reference client** (external repo/CI) | Two-stage runner: isolated execution harness → attestation (sign + upload + submit). *Design already specifies; build is a later, separate effort — explicitly not now.* | External to the Hub; consumes stable Hub APIs. | No |
| **9** | **Enablement ceremony** | Set `VERIFICATION_RUNNER_MASTER_SECRET` (≥32 chars) in **staging** behind the signed-receipt migration process; apply the accumulated migrations; run PR-5 acceptance against a disposable bucket; then production. | The only step that goes live. Paused now. | **Yes** |

PRs 1–3 are pure Hub/DB and can proceed as soon as the first-slice decisions below are made. PRs 4–6
depend on the provider decision (Gate A). PR-7 can land any time after PR-1. PR-8/9 are gated on the
owner explicitly authorizing provisioning/spend/deploy, which is **out of scope now**.

---

## First slice = PR-1: Evidence immutability + FK RESTRICT

Chosen first because it is the smallest independently reviewable unit, corrects a **confirmed**
gap (evidence still grants `UPDATE/DELETE` to `app_server`), depends on no provider/runner/secret,
and is a precondition for the whole evidence model. It also resolves a concrete conflict: the
verification FKs are **currently `onDelete: 'cascade'`**, so once the append-only trigger exists a
cascaded parent delete would fire the trigger and abort — the FKs must move to `RESTRICT` in the same
PR.

### Owner decisions needed for PR-1 (only these)
1. **Parent-delete semantics — flip verification FKs `cascade → RESTRICT`?**
   *Recommended default: **Yes, RESTRICT.*** Deleting an org/project/task/request that has
   verification evidence is then **blocked** until the governed retention path (PR-7) exists. This
   preserves the audit record and is the correct default for immutable evidence. Trade-off: until
   PR-7 lands, a project/task with evidence cannot be deleted through the app — acceptable pre-launch
   (evidence volume is tiny and disposable DBs are dropped wholesale in dev/test).
2. **Retention deferral — accept "no delete path" until PR-7?**
   *Recommended default: **Yes.*** PR-1 makes evidence genuinely append-only with no purge; PR-7
   adds the governed, recoverable delete. Confirm it's acceptable that evidence is undeletable in the
   interim (it is, given nothing is applied to staging/prod yet and no real tenant data exists).
3. **Migration application timing.**
   *Recommended default: **merge the code + migration now; do NOT apply to staging/prod** (migrations
   remain paused).* PR-1 is verified on disposable DBs only; the `PRODUCTION_PINS` bump is mechanical
   and required by the migration-integrity gate.

Everything else in the design (provider, quota, catalog, auth, runner) is **not** a PR-1 decision and
is deliberately left out of this slice.

### PR-1 acceptance criteria
All verified on a disposable `*_test` DB as the non-superuser `app_server` role (never prod creds):

1. **Grants:** after migration, `app_server` has `SELECT, INSERT` and **not** `UPDATE`/`DELETE` on
   `verification_evidence` (matching `verification_requests`).
2. **Direct mutation rejected:** a direct `UPDATE` and a direct `DELETE` on `verification_evidence`
   as `app_server` both raise (grant + `app.forbid_mutation()` trigger).
3. **Cascade no longer silently deletes evidence:** with FKs at `RESTRICT`, deleting a parent
   org/project/task/request that has evidence is **blocked** (error), and the evidence row survives;
   the trigger is confirmed to fire on the cascaded path, not only a direct delete.
4. **Happy path unchanged:** the existing ingest `INSERT` (idempotent `onConflictDoNothing` +
   reselect) still succeeds — revoking UPDATE/DELETE is functionally inert for normal operation
   (the verification unit + integration suites stay green).
5. **Migration integrity:** `drizzle-kit generate` shows no drift; the new migration is the latest;
   `PRODUCTION_PINS` endpoint+count match it; committed SQL is LF-only; `STAGING_PINS` unchanged.
6. **Regression test added:** a test asserts (1)–(3) as `app_server`, mirroring the existing
   request-immutability test, so the guarantee can't silently regress.
7. **CI:** all release gates green on the PR's final commit; **not** merged/applied to staging/prod
   here.

---

## Gate detail carried into later slices (recorded now so it isn't lost)

### Gate A — AWS S3 is proposed, not established (PR-4/PR-5)
- The upload endpoint is written against the `ObjectStore` port; the S3 adapter is one implementation
  selected by an explicit owner decision at PR-4, **not** inferred from `STORAGE_DRIVER=s3`.
- No size/checksum/no-overwrite property is described as *enforced* until PR-5's acceptance suite
  passes on the actual endpoint + pinned SDK (exact signed headers; `x-amz-checksum-sha256` = base64
  of the raw digest; `412` on `If-None-Match: *`). Until then the path is "intended, unverified" and
  ingest-side digest re-verification is the backstop.

### Gate B — max upload duration, so quota reclamation is provable (PR-6)
A reservation is released only when an upload **cannot still complete**. Because S3 evaluates a
presigned URL's expiry at request *start*, a PUT begun just before expiry can keep writing after it,
so "URL expired" is not proof. PR-6 makes the in-flight window **bounded and enforced**:

- **Bounded object size** (per-artifact cap, §4.5) puts a ceiling on bytes to transfer.
- **Short presign expiry `T_url`** (e.g. 5 min): no *new* PUT can start after `T_url`.
- **Enforced maximum upload duration `T_max`:** the worst-case time a PUT started before `T_url` can
  still be writing. It is enforced by (a) the size cap, (b) the storage provider's own
  request/idle-connection timeout (S3 aborts a stalled request), and (c) a configured hard ceiling
  used to compute the window; a request exceeding `T_max` is guaranteed aborted, not silently
  lingering. `T_max` is documented as an explicit constant with its basis (size cap ÷ assumed floor
  throughput, plus provider idle-timeout margin).
- **Reclamation only after the drain window `T_url + T_max`,** and only after a `HEAD` confirms **no
  object landed**; if an object is present it is finalized (if referenced by accepted evidence) or
  handed to cleanup as an orphan, and quota is released **only after** that deletion is confirmed.
- **Acceptance (PR-6):** a simulated slow PUT that lands *after* `T_url` must keep holding quota
  until it is finalized or proven absent after `T_url + T_max`; reclamation must never fire at
  `T_url` alone.

---

### Notes
- Constraints in force: no implementation, no provisioning, no spend, no deploy, no staging/prod
  migration application, no StressProbe. This document is docs-only.
- Related merged work: contract creation (#104), repository-name consistency (#105), design doc
  (#106). PR-1 here is the first build step against that design.
