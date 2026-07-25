# O-23 Production Acceptance — Live Object Storage (sanitized report)

Scope: validate the existing `S3ObjectStore` against real S3-compatible storage
and complete the acceptance steps that can be executed without owner-only
prerequisites. No secrets appear in this report.

## Environment used

| | |
|---|---|
| Object storage | **Local MinIO** (real S3-compatible server; identical protocol to Tigris/R2/AWS) |
| Bucket | `king-lib-staging` — **private**, versioning enabled |
| Storage driver | `STORAGE_DRIVER=s3`, path-style SigV4 (`S3ObjectStore`) |
| Database | local Postgres; assertions run as the non-superuser `app_server` role |
| Command | `npm run test:s3` (live) · `npm run test:rls` (app_server suite) |

**Honesty note.** MinIO is a real S3 server exercising the exact production
signing/transport code, but it is **not the owner's managed bucket**. The steps
that require the owner's account, a deployed staging app, an authenticated
KingdomCore sign-in, or a physical phone were **not executed** and are listed as
remaining blockers rather than reported as passed.

## Step-by-step result

| Step | Status | Evidence (sanitized) |
|---|---|---|
| 1 — Provision storage | ✅ done (MinIO) / policy documented | Private bucket, versioning on, no public ACL. Minimal permission policy in DEPLOYMENT.md §11 (put/get/delete on `<bucket>/*`, list on `<bucket>`; no admin). |
| 2 — Configure staging | ✅ validated | Startup **rejects** `STORAGE_DRIVER=s3` with missing/placeholder `S3_*` (`storage-config.test`, 4/4). `/api/health` → `storage: { ok: true, detail: "driver=s3" }` against the live bucket. Credentials server-only (no `NEXT_PUBLIC_*`). |
| 3 — Live storage smoke | ✅ validated (MinIO) | Upload → object present in bucket under key `org/<org>/project/<project>/doc/<file>/<versionHash>`; DB `source=cloud_upload`; job queued → worker claimed → `active`; chunk count created **once**. Anonymous GET of the object → **403** (private). Read only via the app's authorized server path. |
| 4 — Idempotency & replacement | ✅ validated (MinIO) | Same bytes → `unchanged`, no new job, no duplicate row/chunks. Changed bytes → new hash, **stable document id**, new version object, old chunks replaced **atomically**, retrieval returns only the current version. |
| 5 — Worker restart recovery | ✅ validated (MinIO) | Job claimed (leased) → lease expired → `reconcileStaleDocumentJobs` requeued → re-drained to `active`; **no duplicate chunks**; no partial-active state. Status not hand-edited. |
| 6 — Full KingdomCore model run | ⛔ owner-gated | Needs the staging deploy + authenticated KingdomCore owner sign-in + live provider calls. The retrieval path (cloud doc → prompt, `Documents Used` provenance incl. `cloud_upload` + freshness) is proven by the O-23 suite; the interactive signed-in run was not executed. |
| 7 — Cross-workspace isolation | ✅ validated (both layers) | **DB/RLS** (`document-cloud-isolation.test`, as `app_server`): A cannot read/insert/update B's document rows or jobs. **Object layer** (`s3-live.test`): a foreign-tenant object key is refused by the ownership guard **before any fetch**; `keyBelongsToTenant` rejects it. |
| 8 — Local-source offline | ✅ validated (local variant) | With a local folder unavailable, existing local docs stay `active` (no mass-archival — O-21 stat-first guard), cloud upload + index + retrieval work fully (`document-cloud.test` Test 7). Staging-refresh UI path is owner-gated. |
| 9 — Backup & restore | ✅ validated (local drill) | `pg_dump` + `mc mirror` → restore to clean DB + backup bucket. Restored cloud row + chunks intact and queryable; **DB sha256 == backed-up object sha256 (MATCH)**; **0 cross-tenant object references** after restore. Managed-provider procedure documented (§11.6). |
| 10 — Real-device (physical phone) | ⛔ owner-gated | No physical device available here. The 375px browser flow (upload input, status, table scroll, no horizontal overflow) was validated in O-23; a real handset pass is required. |

## Deliverables

- **Sanitized acceptance report** — this file.
- **Minimal bucket permission policy** — DEPLOYMENT.md §11 (no credentials).
- **Health-check output** — `{ "storage": { "ok": true, "detail": "driver=s3" } }`.
- **Indexing + restart-recovery evidence** — `npm run test:s3` (7/7).
- **Isolation evidence** — `document-cloud-isolation.test` (RLS) + `s3-live.test`
  Step 7 (object layer).
- **Backup/restore report** — §11.6 + the drill result above.
- **Updated DEPLOYMENT.md** — §11 (policy, live-validation status, backup/restore).

## Remaining launch blockers — ranked by severity

1. **(Blocker) Validate against the owner's MANAGED bucket + credentials.** The
   S3 code is proven against real S3 (MinIO); point `S3_*` at the production
   Tigris/R2/AWS bucket and re-run `npm run test:s3` (or the Step-3 smoke) once.
   Risk: endpoint/region/addressing quirks specific to the managed provider.
2. **(Blocker) Full KingdomCore signed-in model run in staging (Step 6).** Deploy
   staging, sign in as the owner, run a task that retrieves a cloud-uploaded doc,
   and confirm `Documents Used` shows `cloud_upload` + freshness. Requires owner
   sign-in (cannot be automated here).
3. **(High) Backup/restore drill against the MANAGED instances (Step 9).** Re-run
   the drill with managed Postgres snapshot + managed-bucket versioning; confirm
   object-hash match and no cross-tenant refs on the managed side.
4. **(Medium) Physical-phone pass (Step 10).** Complete upload → status → run →
   Context used → accept/reject a suggested decision on a real handset; record any
   layout/usability blockers only.
5. **(Low) Bucket hardening review.** Confirm server-side encryption + versioning
   are enabled on the managed bucket and the storage key is bucket-scoped (the
   policy in §11 assumes this).

Items 1–3 gate a public launch; 4–5 are pre-launch hygiene. Nothing here requires
code changes — the implementation is accepted; these are validation + provisioning
steps that need the owner's account and a deployed environment.
