# Ops Chat Approval Content — Production Release Evidence (v82)

**Status:** ✅ Deployed to production 2026-10-19 (release **v82**). Infrastructure acceptance passed (§7).
Feature acceptance (§8) is **PENDING**: it needs the owner signed in to `/ops` with a legitimate pending approval.
**Scope:** Ships #158. Ops Chat shows the owner the actual stored content of a pending approval (`get_approval_detail`,
admin-only) and on the `decide_approval` confirm card. The content is bounded and credential-redacted, and it is
rendered from the stored approval row. The release also adds the system-prompt rule that approval, customer and
external content is untrusted data. **No migration, no executor change, no governance change, no config change**
other than the one-use `DEPLOYMENT_NONCE`.

This document is the permanent release record. It also records the **aborted first attempt (v81)**, a correct
fail-closed event of the G-Backup source-binding gate.

---

## 1. Release identity

| Field | Value |
|---|---|
| Fly release | **v82** (`complete`, created `2026-10-19T01:08:34Z`) |
| Fly app | `king-ai-ops-hub-prod` |
| Source commit | `6449376e7f366385e4c524464782aff2de2ddf6d` (== `origin/main` at release time; squash merge of #158, reviewed head `d211d8c`) |
| Image digest | `sha256:0970ccbe3a585a9ceea439b2d2eb4a107ebd827d8e480aab4227d5fcaf2f837e` |
| Image ref | `registry.fly.io/king-ai-ops-hub-prod@sha256:0970ccbe3a585a9ceea439b2d2eb4a107ebd827d8e480aab4227d5fcaf2f837e` (label `v81-6449376`, built once and reused for v82; no rebuild) |
| Deploy config | `fly.production.toml` |
| Previous release | v80, image `sha256:b4d268009be3266f3a5a5f364b66bd2b527b614cd18318972a801629d337f407` (source `8e9a6a744d3e4dc895aeee164c6cdd195517e003`) |

## 2. Image provenance (pre-sign verification)

The image was built from the clean, dedicated worktree `C:\Users\baldd\dev\king-prod-build-6449376` (detached at
`6449376`, 0 local changes) with `fly deploy --build-only --push -c fly.production.toml` and these build args:

- `--build-arg SOURCE_COMMIT=6449376e7f366385e4c524464782aff2de2ddf6d`
- `--build-arg PORTABLE_MIGRATION_SET_HASH=92c30b02742f998a6e5db29fab61aa6bc9d402c6cf64af67e9a02cd81d2f3780`

The hash is unchanged from v79/v80. `git diff 8e9a6a7 6449376` touches no `drizzle/` file, `scripts/migrate.ts`,
`Dockerfile`, `fly.production.toml` or `package*.json`, and the committed migration count stays 86.

The image was pulled **by digest**. Its `/app/source-identity.json` contained exactly `sourceCommit = 6449376e…` and
`portableMigrationSetHash = 92c30b02…`. The server bundle contained the new code: the `UNTRUSTED CONTENT` rule in the
Ops Chat route chunk and the confirm-card renderer in the client chunk.

## 3. Aborted first attempt: v81 (fail-closed, not a defect)

| Field | Value |
|---|---|
| Attempt | `fly deploy -c fly.production.toml --image <0970ccbe… digest>` at `2026-10-19T00:13:26Z` |
| Release machine | `8655774fe19008` (throwaway; destroyed) |
| Gate output | `Pre-migration gate (environment=production)…` → `PreMigrationGateError: receipt verification failed (verify): source_commit_mismatch` (`code: 'verification_failed'`) at `00:13:55Z` |
| Outcome | `release command failed - aborting deployment`; Fly release **v81 = `failed`** |
| Production machines | **unchanged**: all 4 machines stayed on v80 / `sha256:b4d26800…f407`; `/api/health` 200 |
| Database | **no change**: the gate runs before any `migrate()`/`rls.sql`; still 86 applied, system id unchanged (§4) |
| Config | **no change**: secrets digest list identical to the pre-attempt baseline; nothing staged |
| Root cause | The operator assumed a `NO_PENDING` release needs no receipt. That held under G-Backup-A, but the v2 gate requires a fresh signed receipt for **every** production deploy, including NO_PENDING, because `rls.sql` can still mutate state. The live `DEPLOYMENT_NONCE` still pointed at v80's receipt, which is bound to source `8e9a6a7`. The gate compared it with the baked `6449376` and refused. |
| Correction | Full v2 receipt ceremony (§4–§6), then a re-deploy of the **same** digest as v82 |

This attempt shows the gate's source binding working as designed: a stale receipt for a different source cannot
authorize a release.

## 4. Pre-release baseline (re-established after v81, read-only)

| Field | Value |
|---|---|
| DB app / database | `king-ai-hub-db-prod` / `king_ai_ops_hub_production` |
| DB system identifier | `7673854635852591781` (unchanged) |
| Source volume | `vol_vlye16958n6x6ed4`, attached to primary `8ed9d43cd3d3d8` (unchanged) |
| APPLIED_COUNT | **86** (ids 1–86), endpoint `0085_rich_queen_noir`, read inside a `READ ONLY` transaction |
| Applied-hash check | all 86 `(created_at, hash)` pairs equal the repository journal `when` + sha256 of the LF blobs at `6449376`, in order (**0 mismatches**) |
| Pending set | **empty** (`NO_PENDING`) |
| App | still v80 on `sha256:b4d26800…f407`; web ×2 + worker started, standby worker stopped |
| Secrets | digest list identical to the pre-v81 baseline; nothing staged |

## 5. Pre-release snapshot and receipt chain

| Field | Value |
|---|---|
| Snapshot | `vs_jQkkN14obJQwuKbP70m1` (retention 30 d, stored 110,856,679 bytes, provider status `created` → canonical `complete`) |
| Snapshot timeline | requested `2026-10-19T00:54:24.731Z` · created `2026-10-19T00:54:35.000Z` · observed complete `2026-10-19T00:58:28.137Z` |
| Discovery | `unambiguous-list-diff`: 49 → 50 ids, exactly one new id; pre-set digest `ef38bf9d416b210ffc5cef82a06f52c654736095a895448d9c24636d36b9a4d4`, post-set digest `d092ae29e940eaccf3f15d32b6d46407c42d852d9869ccbbbd5c5adc12c74136` (repo `computeSnapshotIdSetDigest`) |
| One-use deployment nonce | `fb1f2619d5b764aa29158184cc30b6d5` (fresh, random 128-bit; never reused) |
| Signing workflow run | `39183452560` (`sign-production-receipt.yml`, production Environment approved by the owner): SUCCESS `01:03:58Z`, self-verified |
| Publish workflow run | `39183644331` (`publish-production-receipt.yml`, production Environment approved by the owner): SUCCESS `01:05:53Z` |
| Receipt id | `rcpt2_e6aca7ec1cfd3b58799cf5332c9da3113717765e2fd3629e56c716f9226b25b4` |
| Receipt canonical sha256 | `aa3f259b553bbf77586036039f5ad4c71122126d4da255a4a42c6db7ea50f61b` |
| Receipt file sha256 | `cc5b8e1594bfaf192c215db6ddda825562dc308f672b6b99b68fd2c96389ac0e` |
| Published object | `https://king-ai-ops-hub-receipts-prod.s3.us-east-1.amazonaws.com/v2/production/king-ai-ops-hub-prod/fb1f2619d5b764aa29158184cc30b6d5.json` (S3 WORM) |
| Receipt created / expires | `2026-10-19T01:02:00.967Z` / `2026-10-19T01:54:35.000Z` |
| Pending migrations in receipt | `[]` |
| Portable / runtime migration-set hash | `92c30b02…3780` / `34710302d980ec574e3d597ba531041d1cea889ce100823b8ebf8070b1b76393` |
| Committed count / endpoint | 86 / `0085_rich_queen_noir` |
| Signing key id | `prod-dbr-2026-08` (Ed25519; trust-bundle public fingerprint `f198a480de5e3948a29af881e35e42c0502ea85fe0b3449e11af094a789d803b`, equal to the production closeout record) |

**Signer-artifact check (before publication):** source, image ref/digest, snapshot id and timeline, nonce,
`pendingMigrations: []`, system identifier, volume and expiry all equal the intended values. The artifact holds only
`production-receipt.v2.json`, `trust-bundle.public.json` (one **public** key) and `verification-metadata.json`, with
no private-key material.

**Independent verification (`2026-10-19T01:08:01Z`, 46 min before expiry):** an anonymous HTTPS GET of the locator
returned 200 with no redirect. The bytes equal the signer artifact (sha256 `cc5b8e15…`). The repository verifier
`verifyReceiptV2Bytes` returned **`ok: true`** with canonical hash `aa3f259b…`. It ran with the production pins
(`scripts/backup/production-pins.ts`), the signer's public trust bundle (fingerprint checked above), min retention
7 d, max snapshot age 3,600,000 ms and an empty expected pending set. *Deviation from v79:* the deployed app's
`GBACKUP_*` environment was not read for this pre-check (that read was not permitted in this session). The
authoritative verification with the live deployed configuration is the release gate itself (§6).

## 6. Release (receipt-gated `db:migrate`)

The new `DEPLOYMENT_NONCE` was staged (`fly secrets set --stage`, digest `b0b9f3d9bb700002`). Then
`fly deploy -c fly.production.toml --image <0970ccbe… digest>` ran `01:08:31Z → 01:09:45Z` with no rebuild. Release
command on the throwaway machine `894dd6b6665378`:

```
01:08:52Z Acquiring migration advisory lock…
01:08:52Z Pre-migration gate (environment=production)…
01:08:53Z Pre-migration gate passed: verified — receipt verified for 0 pending migration(s)
01:08:53Z Applying Drizzle migrations…
01:08:53Z Applying RLS, roles, and append-only triggers…
01:08:53Z Migration complete.
```

## 7. Post-release verification

- Release **v82 `complete`**. All four machines are on `sha256:0970ccbe…f837e`: web `28747923c04308` ✅, web
  `840493a27de7d8` ✅ (checks passing), worker `28654d91be6678` ✅ started, worker `8d96930b022278` **standby**
  (stopped by design).
- Baked `/app/source-identity.json` on both web machines and the started worker = `6449376e…` / `92c30b02…` ✅
- DB after release: system identifier `7673854635852591781`; `drizzle.__drizzle_migrations` **86 / max id 86** (unchanged) ✅
- `/api/health` → 200 ×3 (`process`, `database`, `migrations`, `worker`, `storage: driver=s3` all ok); `/api/live` → 200 ✅
- Auth boundaries: `POST /api/ops-chat` 401, `POST /api/ops-chat/confirm` 401, `GET /ops` 307 → `/login` ✅
- Config: the secret-digest diff against the baseline shows **only** `DEPLOYMENT_NONCE` changed
  (`0d0a2bbdab28e67e` → `b0b9f3d9bb700002`); nothing left staged ✅

## 8. Feature acceptance (#158, production, owner signed in)

| Check | Result |
|---|---|
| Open a legitimate pending approval; ask Ops Chat what it actually says | **PENDING** |
| The real stored draft is visible in the reply (`get_approval_detail` → `content`) | **PENDING** |
| The same content appears on the `decide_approval` confirm card | **PENDING** |
| Credentials/secrets redacted, if any exist in the payload | **PENDING** |
| The approval is not executed unless the owner actually decides to | **PENDING** |

## 9. Rollback

| Field | Value |
|---|---|
| **Rollback: app image** | `sha256:b4d268009be3266f3a5a5f364b66bd2b527b614cd18318972a801629d337f407` (v80, source `8e9a6a7…`). Rolling back needs its own fresh receipt ceremony, because the gate binds every deploy to its source. |
| **Rollback: DB** | Not needed for this release (no DDL; 86 → 86). Pre-release point-in-time: snapshot `vs_jQkkN14obJQwuKbP70m1`. |

## 10. Build worktree

Build worktree: `C:\Users\baldd\dev\king-prod-build-6449376` (detached HEAD at `6449376`). **Retain until this evidence
record is merged**, then it may be removed. The digest, receipt IDs, workflow run IDs, snapshot and verification
results are all captured above.
