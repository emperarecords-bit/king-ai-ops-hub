# Phase 2 Governed-Connectors Control Surface — Production Release Evidence (v64)

**Status:** ✅ Deployed to production 2026-10-11.
**Scope:** Ships the Phase 2 governed Supabase + Vercel connectors and the migration
control surface (issue #135, PRs #139–#144) plus the signing-safety hardening (#145).
Both new write executors are shipped **disabled and fail-closed**; no live external
writes are enabled by this release.

This document is the permanent release record. It is intentionally self-contained so the
release can be audited, reproduced, or rolled back without reconstructing the session.

---

## 1. Release identity

| Field | Value |
|---|---|
| Fly release | **v64** (`complete`) |
| Fly app | `king-ai-ops-hub-prod` |
| Source commit | `a84968de4958031c4a0deb07ee9fa9140a520aa5` (== `origin/main` at release time; merge head of #145) |
| Image digest | `sha256:ca8b1767ff8fee46813881f749ddb1e4f6f3a6bd7b9f804d526f965d347bd22e` |
| Image ref | `registry.fly.io/king-ai-ops-hub-prod@sha256:ca8b1767…d347bd22e` |
| Deploy config | `fly.production.toml` (NOT the repo `fly.toml`, which is staging config) |
| Deployed on machines | `8d96930b022278`, `840493a27de7d8`, `28747923c04308`, `28654d91be6678` — all on ca8b1767 |

## 2. Image provenance (pre-sign verification)

The image was built with both build args so the baked source identity is non-placeholder:

- `--build-arg SOURCE_COMMIT=a84968de4958031c4a0deb07ee9fa9140a520aa5`
- `--build-arg PORTABLE_MIGRATION_SET_HASH=bbde1a26…`

Before signing, the actual image's `/app/source-identity.json` was pulled and inspected and
contained exactly `sourceCommit = a84968de…` and the independently derived portable
migration-set hash. **Inspecting the baked artifact before signing is now a mandatory step**
(see §7 for why).

## 3. Receipt chain

| Field | Value |
|---|---|
| Signing workflow run | `38155265309` (`.github/workflows/sign-production-receipt.yml`) — SUCCESS |
| Publish workflow run | `38155357042` (`.github/workflows/publish-production-receipt.yml`) — SUCCESS |
| Published receipt (canonical) | `rcpt2_1db2555f081288f988f9b6d9e72bac5203cc350e497d6b1b4ce744d1de766afb` |
| Receipt canonical sha256 | `afb9c30003e9710032a3f8d20f38229a0f69aa258a38ca457e3ea19aba795f1c` |
| One-use deployment nonce | `a88cd47c437e382ba297bb0835e6ae5f` |
| Published object | `…/v2/production/king-ai-ops-hub-prod/a88cd47c437e382ba297bb0835e6ae5f.json` (S3 WORM) |
| Anonymous read-back | **byte-equal PASS** (performed inside the publish step; step concluded success) |
| Pending migrations in receipt | `[0079, 0080, 0081, 0082, 0083]`, firstIndex 79, endpoint `0083_graceful_zemo` |
| APPLIED_COUNT (pre-migration baseline) | 79 |
| Portable migration-set hash | `bbde1a26…` |
| DB system identifier | `7673854635852591781` |
| Signing key id | `prod-dbr-2026-08` |

## 4. Migration apply (receipt-gated `db:migrate`)

Release command (`npm run db:migrate` → `scripts/migrate.ts`) on the throwaway release
machine `683dd3eea0d4e8`:

```
Pre-migration gate (environment=production)…
Pre-migration gate passed: verified — receipt verified for 5 pending migration(s)
Applying Drizzle migrations…
Migration complete.
```

- Prod `drizzle.__drizzle_migrations` count: **79 → 84** (verified post-deploy via the migration role).
- Migrations applied: **0079–0083** (exactly five).
- New DDL tables confirmed present in prod: `supabase_project_links` (0079), `vercel_project_links` (0082).
- 0080 / 0081 / 0083 add the `action_type` enum values for `supabase_deploy`, `supabase_sql`, and `vercel_mutation` respectively; no new tables.

## 5. Pre-DDL snapshot & rollback

| Field | Value |
|---|---|
| Pre-DDL DB snapshot | `vs_V7YYwlK2xo7JsZgmOZ6J` (created 2026-10-11T16:19:22Z, retention 30d) |
| Snapshot age at migrate-start | ≈ 9 min (inside the ~30-min freshness window; deploy 16:28→16:30Z) |
| **Rollback — app image** | `sha256:a016d16106da8bb38c5a0b1de23abe56786e658a907a139dc0e3aed25641ac40` (v62/v56 code, source `602df7ea`) |
| **Rollback — DB** | restore snapshot `vs_V7YYwlK2xo7JsZgmOZ6J` |

## 6. Acceptance results (post-deploy)

- Deployed digest `ca8b1767` on all 4 machines ✅
- `/api/health` → 200 × 3 ✅
- Auth boundaries: `POST /api/ops-chat` 401, `/api/ops-chat/confirm` 401, `/api/ops-chat/council` 401, `GET /settings/notifications` 307→login ✅
- Prod DB migration count 84 + new tables present ✅
- `GITHUB_APP_ID` present → v55 GitHub read bridge preserved ✅
- `NOTIFICATIONS_ENABLED=email`, `EMAIL_FROM=hub@accuratebids.com` → Owner Notifications intact ✅

### Governance posture — verified live (owner-locked)

- `SUPABASE_MANAGEMENT_TOKEN` = **ABSENT**
- `VERCEL_TOKEN` = **ABSENT**
- `EXECUTORS_ENABLED = git_pr,accuratebids_quote,org_delegation` → `supabase_deploy` and
  `vercel_mutation` **NOT enabled**; `git_pr` unchanged
- `supabase_sql` non-executable by construction (destructive_irreversible; dispatch blocks)

→ The new Supabase/Vercel write executors are **deployed-but-disabled and fail-closed**.
Activating either is a separate controlled step the owner performs: set the token, add the
executor name to `EXECUTORS_ENABLED`, and link a project row. This release does none of that.

## 7. Prior attempt v63 — gate worked as intended (preserved on purpose)

The first deploy attempt, **Fly release v63 (`failed`)**, used image `a35bb33d`. It **failed
closed at the pre-migration gate** with *"baked sourceCommit is missing/placeholder/malformed"*.

Root cause: the `fly deploy --build-only --push` that produced a35bb33d omitted
`--build-arg SOURCE_COMMIT` and `--build-arg PORTABLE_MIGRATION_SET_HASH`, so the image baked
`sourceCommit=UNKNOWN`.

**No DDL and no rollout ran. Production was unchanged by v63.** This is the intended behaviour:
a malformed baked source identity is rejected before any destructive action. The corrected
image (ca8b1767) was rebuilt with both build args and its `/app/source-identity.json` was
inspected before signing. The old nonce, snapshot, receipt, and the a35bb33d image were all
discarded — none reused.

## 8. Build worktree

Build worktree: `C:\Users\baldd\dev\king-prod-build` (detached HEAD at a84968de). **Retain until
this evidence record is merged**, then it may be removed (digest, receipt IDs, workflow run IDs,
rollback snapshot, and acceptance results are all captured above).
