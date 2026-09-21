# PR-3 — Contract retrieval + catalog pinning (implemented per owner decisions)

Third slice of the external-runner plan (#107). This brief records the owner decisions **as decided**
and the implementation that realizes them. Both machine-auth and credential-issuance controls remain
**disabled**; the new retrieval control ships **default-off**. Deployments, staging/production
migrations, provisioning, runner execution, and StressProbe remain paused.

## Owner decisions (as implemented)
- **D1 — Trusted, preserved catalogs.** Catalogs are version-controlled files in the Hub repo
  (`config/verification-catalogs/versions/<version>.json`, immutable per version; `current.json` the
  trusted per-project/default pointer). Resolved **server-side only** — a caller can never supply
  catalog contents or an authoritative digest. Digest = **SHA-256 over canonical JSON** (recursively
  sorted keys) of the version object. Immutable version files mean a contract pinned to an old version
  stays verifiable after the catalog updates. Missing pinned content **fails closed**
  (`catalog_unavailable`).
- **D2 — Machine-only retrieval control.** Human project members (incl. **viewers**) may always read
  their project's contracts. A **machine** principal may retrieve only when *both* machine-auth and
  `VERIFICATION_RUNNER_RETRIEVAL_ENABLED` are on.
- **D3 — Legacy contracts fail closed.** New columns default to an explicit `'unpinned'` sentinel;
  ingestion of an unpinned contract is **rejected** (`catalog_unpinned`) — validation is never
  skipped. We do **not** assume staging/production is empty. The upgrade only ADDs columns, so existing
  contract fields and evidence are preserved (verified: evidence byte-identical, contract fields
  intact, catalog → `unpinned`). *Replacing an unpinned contract:* because the contract is immutable
  and the `(org, project, task, expected_commit_sha)` uniqueness key blocks a second contract for the
  same task+commit, an unpinned contract can be superseded only by (a) verifying at a **new commit**
  (a new contract, which pins the current catalog), or (b) removing the unpinned contract through the
  governed retention path (PR-7) so a fresh, pinned contract can be created for the same task+commit.
- **D4 — Exact command matching.** A required check's reported command must **exactly equal** the
  pinned catalog entry (`invalid_checks` otherwise). **Unknown required check names are rejected at
  contract creation.** The catalog identity is carried **inside the signed evidence payload** and
  validated on **both** authentication paths.
- **D5 — Default-off flag.** `VERIFICATION_RUNNER_RETRIEVAL_ENABLED=0`.

## Scope implemented
- **Schema (migration `0075`):** `catalog_version`, `catalog_digest` on `verification_requests`
  (immutable, default `'unpinned'`). `PRODUCTION_PINS` → `0075`/76.
- **Creation:** `createVerificationRequest` resolves the trusted current catalog, rejects unknown
  check names, and pins `(version, digest)` — never from the payload. Contract equality includes the
  catalog identity.
- **Ingest:** re-resolves the **pinned** version server-side and requires the contract, the server
  catalog, and the signed payload to all agree; rejects `catalog_unpinned` / `catalog_unavailable` /
  `catalog_mismatch`, and a check whose command ≠ the pinned entry — on both auth paths.
- **Retrieval endpoints (project-scoped, read-only):** `GET …/verification/requests` (bounded keyset
  pagination by contract id via `?limit`/`?cursor`; `?state=open` = contracts with **no accepted
  evidence yet**, a policy-neutral definition that does not adopt the unresolved conflicting-attempt
  policy) and `GET …/verification/requests/{id}`. All of a project's credentials share read access —
  this is **not** a runner-specific assignment. Responses carry only contract fields + policy-neutral
  evidence facts (`acceptedEvidenceCount`, `hasVerifiedComplete`) — never secrets or evidence rows.
  Machine callers pass through the real middleware (like the ingest path) and self-gate.

## Acceptance tests (disposable infra)
Unit: catalog pinned at creation; unknown check name rejected; fail-closed when no catalog resolves;
ingest `catalog_unpinned` / `catalog_unavailable` / `catalog_mismatch`; exact command binding; **an
old-version contract still verifies after the catalog updates**. Integration (real HTTP + middleware):
human member/viewer read; **machine retrieval ON → 200, OFF → 403**; bounded pagination + open filter;
genuine machine-authenticated verify + replay under the pinned catalog; **caller-supplied catalog
tampering → `catalog_mismatch`**; **missing pinned catalog → fail closed**; **catalog update preserves
old-contract verification**. Migration: fresh bootstrap through `0075`; **legacy-row upgrade** (0074 →
0075) leaves evidence byte-identical + fields intact and marks the contract `unpinned` (fail closed).

## Out of scope / still paused
No upload/quota (PR-4/PR-6), retention (PR-7), or runner client (PR-8). No provisioning, deploy, or
staging/prod migration. The signing master stays unset, so ingestion remains disabled outside
disposable tests.
