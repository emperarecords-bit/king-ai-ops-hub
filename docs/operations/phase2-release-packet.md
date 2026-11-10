# Phase 2 governed control-surface — production release packet (PREP / dry-run)

> **SHIPPED as prod v64 2026-10-11; current prod v78 — historical record.**
> Preserved as written; nothing below is live guidance. For what actually shipped see
> `docs/operations/phase2-v64-release-evidence.md` and the current production state.

**Status at the time of writing: ceremony preparation only. No production change had been or would be made by this packet.**
Prepared 2026-10-11 against `main` and live prod reads. The actual release runs later, under the
receipt-gated G-Backup ceremony, only on explicit owner authorization.

Legend for every fact below:
- **[repo]** proven from the checked-out source at the release SHA.
- **[live]** read read-only from production this session (`fly …`, no secret values).
- **[capture]** MUST be captured/confirmed at ceremony time — do **not** trust memory or a default.

---

## 1. Exact release source
- **[repo]** Release source = `main` @ **`257ef34eb9a78e697f675fd5c3dfe5ece00fc7d7`**
  (squash of #144; the local working head `92a18f65…` is that same squashed content).
- This is the first release to carry the Phase 2 governed connectors: GitHub merge/rerun (#139),
  Supabase read (#140) + edge-function deploy (#141) + approved-SQL validate (#142), Vercel read (#143)
  + mutation (#144).

## 2. Exact pending migrations (`0079`–`0083`)
- **[repo]** Committed migration set on `257ef34`: **84** files, endpoint **`0083_graceful_zemo`**
  (matches `scripts/backup/production-pins.ts`: `expectedMigrationEndpoint=0083_graceful_zemo`,
  `expectedCommittedMigrationCount=84`).
- The five NEW migrations this release applies (each reviewed in its PR):

  | Mig | Name | Effect | Reversibility |
  |----|------|--------|---------------|
  | 0079 | careless_hiroim | CREATE TABLE `supabase_project_links` (+FKs, 2 idx) | additive table |
  | 0080 | cool_titania | ALTER TYPE `action_type` ADD VALUE `supabase_deploy` | additive enum value |
  | 0081 | acoustic_carnage | ALTER TYPE `action_type` ADD VALUE `supabase_sql` | additive enum value |
  | 0082 | messy_synch | CREATE TABLE `vercel_project_links` (+FKs, 2 idx) | additive table |
  | 0083 | graceful_zemo | ALTER TYPE `action_type` ADD VALUE `vercel_mutation` | additive enum value |

- **All five are purely additive** (two new tables, three new enum values). None alters or drops
  existing columns/types/data. `rls.sql` adds `to_regclass`-guarded tenant policies for the two new
  tables. There is **no data migration and no destructive DDL** in this set.

## 3. Current production source/digest + rollback source
- **[live]** Current prod app = `king-ai-ops-hub-prod`, **release v62** (Oct 9 2026), all 4 machines
  (2 web, 2 worker) on image **`sha256:a016d16106da8bb38c5a0b1de23abe56786e658a907a139dc0e3aed25641ac40`**.
- **[live]** Releases **v56→v62 share that one image digest** → v57–v62 were secret/config-only
  releases (no code change). **Prod code is the v56 Owner-Notifications-v1 build; it contains none of
  the Phase 2 connectors.** (⚠ memory `king-hub-prod-current-state` / `owner-notifications-v1` say
  "v56"/"v54" — stale on the version number; the image digest above is authoritative.)
- Current prod **source commit SHA** behind `a016d161…` = **`602df7ea67070bc2d1bd131bb73160487c2072f7`**
  (Owner-Notifications-v1 release; corroborated by the digest match against the v56 G-Backup receipt).
  **[capture]** re-confirm against that receipt before signing.
- **Rollback source (app)** = redeploy image `sha256:a016d161…` (source `602df7ea`, the current/pre-release code).

## 4. Fresh pre-migration snapshot
- **[capture]** Taken at ceremony time (NOT now). Create a fresh Fly Volumes snapshot of the prod DB
  volume `GBACKUP_SOURCE_VOLUME_ID` (**[repo]** `vol_vlye16958n6x6ed4` in production-pins), capture its
  id + createdAt, and keep it within `GBACKUP_MAX_SNAPSHOT_AGE_MS` of signing (the ceremony fails closed
  on a stale snapshot — this bit us before: a prior window aborted with zero prod change on a
  freshness lapse, which is the gate working).
- **Rollback source (DB)** = restore this snapshot.

## 5. Migration manifest / count reconciliation
- **[repo]** committed = **84**, endpoint `0083_graceful_zemo`.
- **[capture]** prod **applied count** — expected **79** (through `0078_silent_ultron`, per the Owner
  Notifications release) ⇒ pending = 84 − 79 = **5** = exactly `0079`–`0083`. **Confirm the real applied
  count from prod `drizzle.__drizzle_migrations` at ceremony time; do not assume.**
- **⚠ CRITICAL pin caveat:** `production-pins.ts` `defaultAppliedCount = 68` is **stale** (it predates
  the Owner Notifications release that applied 0078). The ceremony MUST pass an explicit
  **`APPLIED_COUNT` = the real prod count (expected 79)**. If the default 68 were used, the receipt
  would mis-derive the pending set as `0068`–`0083` (16) instead of `0079`–`0083` (5). Pass it explicitly.

## 6. Required production secrets / config state
- **[live]** Present now in prod (names/digests only, values never read):
  `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `EXECUTORS_ENABLED`, all `GBACKUP_*` ceremony secrets
  (`GBACKUP_SOURCE_VOLUME_ID`, `GBACKUP_EXPECTED_DB_IDENTITY`, `GBACKUP_MAX_SNAPSHOT_AGE_MS`,
  `GBACKUP_RECEIPT_*`, `GBACKUP_TARGET_APPLICATION`, `GBACKUP_DATABASE_APP`), `DATABASE_MIGRATION_URL`,
  `DEPLOYMENT_NONCE`, AWS S3 receipt-store keys.
- **[live] ABSENT in prod:** `SUPABASE_MANAGEMENT_TOKEN`, `VERCEL_TOKEN`.
  → Even after this release, the Supabase and Vercel connectors **fail closed** in prod (typed refusal,
  no I/O) until the owner sets those tokens. This is desirable for a low-risk first ship.
- **[capture]** `EXECUTORS_ENABLED` **value** — not shown by `fly secrets list`. Confirm the intended
  value explicitly with the owner (see §7); do not infer it.

## 7. Executor-activation decision (the key call)
**Recommendation: ship the code with the new write executors DEPLOYED-BUT-DISABLED.**
- Set `EXECUTORS_ENABLED` for this release so it does **not** list `supabase_deploy` or
  `vercel_mutation` (preserve whatever `git_pr` setting is already intended). The dispatch choke point
  then refuses any attempt to execute them ("the executor is disabled"), by construction.
- Belt-and-suspenders already holds regardless: `SUPABASE_MANAGEMENT_TOKEN` + `VERCEL_TOKEN` are absent,
  so those clients fail closed even if enabled; and `supabase_sql` is `destructive_irreversible`, which
  the gate blocks unconditionally (no live path exists at all).
- Net: this release puts the entire control surface into prod while **no new live write can fire**.
  Turning a connector on later is a deliberate, separate step: set its token + add its id to
  `EXECUTORS_ENABLED`. Flip only when you actually want live Ops Chat writes for that platform.

## 8. Sign / publish receipt inputs (receipt-v2, G-Backup)
Producer: `scripts/backup/sign-staging-receipt.ts` with **`PRODUCTION_PINS`** (`production-pins.ts`).
- **[repo]** pinned, immutable: environment `production`; targetApplication `king-ai-ops-hub-prod`;
  databaseApp `king-ai-hub-db-prod`; sourceVolumeId `vol_vlye16958n6x6ed4`; databaseIdentity
  `king_ai_ops_hub_production`; provider Fly-Volumes; endpoint `0083_graceful_zemo`; committed count 84.
- **[capture]** per-run inputs (rejected if placeholder/malformed): `sourceCommit` = `257ef34…`;
  target image ref + digest (the newly built release image); `DEPLOYMENT_NONCE`; db system identifier;
  snapshot id + requested/created/observed timestamps (§4); `APPLIED_COUNT` = real prod count (§5);
  receipt created/expires; keyId. Sign with the prod receipt key; self-verify with the runtime verifier;
  publish to the S3 WORM receipt store; **re-read byte-equal** before proceeding (per prior ceremonies).
- Gates that must be green first: `p1-release-gates` on `257ef34` (already SUCCESS on #144's head),
  the prod-env GitHub sign/publish gates, snapshot freshness.

## 9. Post-release acceptance checks
Run after deploy + migrate, before declaring done:
- **Health/auth:** `GET /` health 200; an unauthenticated protected route is fail-closed (401/redirect).
- **Migration count:** prod `drizzle.__drizzle_migrations` now = **84**; `0079`–`0083` recorded; app
  boots with no pending-migration error.
- **GitHub connector:** Ops Chat `github_capabilities` on a linked workspace returns configured=true
  (GitHub App secrets present); read a PR/CI state. (No write unless deliberately enabled.)
- **Supabase connector:** `supabase_capabilities` returns `supabaseConfigured=false` (token absent) —
  i.e. fail-closed as intended; `validate_supabase_sql` still runs offline and reports
  `liveExecutionAvailable=false`.
- **Vercel connector:** `vercel_capabilities` returns `vercelConfigured=false` (token absent) — fail-closed.
- **Notifications (existing v56 feature):** unchanged — in-app + email path still works (send one test).
- **Executors:** confirm `EXECUTORS_ENABLED` does not list the new write executors (§7); a dry-run/attempt
  of a disabled executor is blocked and audited.
- **Receipt:** published receipt verifies and is byte-equal on re-read; audit_logs show the release.

## 10. Exact rollback procedure
1. **App:** `fly deploy` the pre-release image
   `registry.fly.io/king-ai-ops-hub-prod@sha256:a016d16106da8bb38c5a0b1de23abe56786e658a907a139dc0e3aed25641ac40`
   (current v62 code) — or `fly releases rollback` to the pre-release version.
2. **DB:** restore the §4 pre-migration snapshot to the prod DB volume. (The five migrations are
   additive — two unused new tables + three unused enum values — so an app rollback alone leaves no
   broken references; the DB snapshot restore is the clean, complete reversal and removes the new
   objects.)
3. **Config:** no secret changes are part of this release under the recommended plan, so nothing to
   revert there. If any connector token/`EXECUTORS_ENABLED` change was made, unset/restore it.
4. Verify health 200 + the connectors fail-closed as before.

---

## Go/No-go summary
- Code is merged, gated green on `257ef34`, and additive-only at the DB.
- The release is low-risk under the recommended plan: connectors ship **inert** (tokens absent +
  executors disabled); no live write can fire; rollback is a single image redeploy + snapshot restore.
- **Before signing, capture the [capture] items** — above all the real `APPLIED_COUNT` (not the stale
  default 68), a fresh snapshot within the freshness window, and the current prod source SHA — and
  confirm the `EXECUTORS_ENABLED` value.
- **This packet changes nothing in production.** The ceremony runs only on explicit owner authorization.
