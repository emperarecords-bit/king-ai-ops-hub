# Persistent Ops Chat — Production Release Evidence (v79)

**Status:** ✅ Deployed to production 2026-10-15. Accepted with one explicitly **deferred** acceptance item (§7).
**Scope:** Ships persistent Ops Chat conversations, PR 2 of 3 (#154, merged on top of the PR 1 foundation #153):
the idempotent owner-first turn protocol, strict in-order (FIFO) turn execution per conversation, proposalId-authoritative
confirm/cancel, interrupted-turn handling, and the page/client wiring for refresh, reopen and cross-device resume with
explicit pending-turn recovery. It applies migrations `0084` (ops_chat conversations/messages/proposals tables) and
`0085` (owner→assistant reply linkage). No executor, token or governance setting changed.

This document is the permanent release record. It is intentionally self-contained so the
release can be audited, reproduced, or rolled back without reconstructing the session.

---

## 1. Release identity

| Field | Value |
|---|---|
| Fly release | **v79** (`complete`) |
| Fly app | `king-ai-ops-hub-prod` |
| Source commit | `099927eb6ca50c2bcdbecee4adf8759907370f4d` (== `origin/main` at release time; squash merge of #154) |
| Image digest | `sha256:1301b334952553d4b8d3d02a11d5053756d74bc46d2588e624680c6853dfeff0` |
| Image ref | `registry.fly.io/king-ai-ops-hub-prod@sha256:1301b334952553d4b8d3d02a11d5053756d74bc46d2588e624680c6853dfeff0` |
| Deploy config | `fly.production.toml` (NOT the repo `fly.toml`, which is staging config) |
| Previous release | v78, image `sha256:398260b6267cec1350408759d5a19e16c740a584456c889e28d16ac41651a106` (source `6f9b7aa9e1935db9512194a272b3517022449dac`) |

## 2. Image provenance (pre-sign verification)

Built from a clean, dedicated worktree at the exact source commit
(`fly deploy --build-only --push -c fly.production.toml`) with both build args:

- `--build-arg SOURCE_COMMIT=099927eb6ca50c2bcdbecee4adf8759907370f4d`
- `--build-arg PORTABLE_MIGRATION_SET_HASH=92c30b02742f998a6e5db29fab61aa6bc9d402c6cf64af67e9a02cd81d2f3780`

The portable migration-set hash was derived with the repository's own `buildSourceManifestFromGit` over all 86
committed migrations. Before signing, the image was pulled **by digest** and its `/app/source-identity.json` read; it
contained exactly `sourceCommit = 099927eb…` and `portableMigrationSetHash = 92c30b02…` (the mandatory baked-identity
inspection from the v63/v64 lesson). The same identity was re-read on running production machines after deploy (§6).

## 3. Pre-release baseline (read live, read-only)

| Field | Value |
|---|---|
| DB app / database | `king-ai-hub-db-prod` / `king_ai_ops_hub_production` |
| Source volume | `vol_vlye16958n6x6ed4` (attached to primary `8ed9d43cd3d3d8`) |
| DB system identifier | `7673854635852591781` |
| APPLIED_COUNT | **84** (ids 1–84), endpoint `0083_graceful_zemo` — read from `drizzle.__drizzle_migrations` inside a `READ ONLY` transaction; re-read immediately before the snapshot |
| Applied-hash check | all 84 applied hashes equal the repository's `0000…0083` files in order (0 mismatches) |
| Pending set | exactly `0084_previous_frightful_four` + `0085_rich_queen_noir` |
| Repository pins | endpoint `0085_rich_queen_noir`, committed count 86 |

## 4. Pre-DDL snapshot & receipt chain

| Field | Value |
|---|---|
| Pre-DDL snapshot | `vs_l011owJabA0vfNqQ9pRl` (retention 30 d, stored 107,922,940 bytes) |
| Snapshot timeline | requested `2026-10-15T00:54:23.000Z` · created `2026-10-15T00:54:32Z` · observed complete `2026-10-15T00:58:20.706Z` |
| Discovery | `unambiguous-list-diff` — exactly one new id; pre-set digest `fc60868e116f0e8aeea6bfe28d81ca0ecccb6e55f1a6b200f62b89cdc7991262`, post-set digest `8c963326b582c9eaf4cbad6773db5f5fe07cd9a3df3b581a688123fcedd70814` |
| One-use deployment nonce | `85aa129b16068266faf83f44e2dbd89c` (fresh; never reused) |
| Signing workflow run | `38663116618` (`.github/workflows/sign-production-receipt.yml`) — SUCCESS, self-verified, no private-key material in outputs |
| Publish workflow run | `38663381371` (`.github/workflows/publish-production-receipt.yml`) — SUCCESS |
| Receipt id | `rcpt2_a58e97b14163b0200d4cbfa648784f52c25446fb5ac408c4fe408602bf888af3` |
| Receipt canonical sha256 | `bcfc1c97606b21f9f415aa6010bd9506b74d586d0eabed1e126b608caef375c9` |
| Receipt file sha256 | `8803afb14428b5adfe3af93d297b0bec72db6bbb6baa08a3d18f6c7b4e39330b` |
| Published object | `https://king-ai-ops-hub-receipts-prod.s3.us-east-1.amazonaws.com/v2/production/king-ai-ops-hub-prod/85aa129b16068266faf83f44e2dbd89c.json` (S3 WORM) |
| Receipt created / expires | `2026-10-15T00:59:13.730Z` / `2026-10-15T01:54:32.000Z` |
| Pending migrations in receipt | `[0084, 0085]` — sha256 `b22f8d8577853001c1eb28080d457ab36f90ad8383d7d037cdb203118a1c5869`, `0a922bf97a3091015c0a718ad1213bc67eb47e7068498ad3ea5941aeffb2d054` |
| Runtime migration-set hash | `34710302d980ec574e3d597ba531041d1cea889ce100823b8ebf8070b1b76393` |
| Signing key id | `prod-dbr-2026-08` |

**Independent verification (2026-10-15T01:05:31Z, 49 min before expiry):** anonymous HTTPS GET of the locator → 200,
no redirect; bytes equal to the signer artifact; repository verifier `verifyReceiptV2Bytes` → `ok: true`, using the
production gate's own base URL, host allowlist and trust bundle (read from the deployed app), the live gate limits
(max snapshot age 3,600,000 ms, min retention 7 d), and the pending set recomputed from `099927e` with APPLIED_COUNT 84.

## 5. Migration apply (receipt-gated `db:migrate`)

The new `DEPLOYMENT_NONCE` was staged at 01:38:40Z (`fly secrets set --stage`); `fly deploy -c fly.production.toml
--image <digest-bound ref>` ran 01:38:45Z → 01:40:30Z. Release command on the throwaway release machine
`8747907b562d68`:

```
Acquiring migration advisory lock…
Pre-migration gate (environment=production)…
Pre-migration gate passed: verified — receipt verified for 2 pending migration(s)
Applying Drizzle migrations…
Applying RLS, roles, and append-only triggers…
Migration complete.
```

- Prod `drizzle.__drizzle_migrations` count: **84 → 86**; ids 85 and 86 carry exactly the `0084` and `0085` hashes, in order.
- `ops_chat_conversations`, `ops_chat_messages`, `ops_chat_proposals` present with row-level security **enabled and forced**; 3 policies.
- `ops_chat_messages.reply_to_message_id` (0085) present.

## 6. Post-deploy verification

- Machines on v79, all on `sha256:1301b334…feff0`: web `28747923c04308` ✅, web `840493a27de7d8` ✅ (checks passing),
  worker `28654d91be6678` ✅ started; worker `8d96930b022278` is the **standby** (stopped by design — takes over only on
  host hardware failure).
- Baked `/app/source-identity.json` on running machines = `099927eb…` / `92c30b02…` ✅
- `/api/health` → 200 ×3 (`database`, `migrations`, `worker`, `storage: driver=s3` all ok); `/api/live` → 200 ✅
- Auth boundaries: `POST /api/ops-chat` 401, `POST /api/ops-chat/confirm` 401, `GET /ops` 307 → `/login` ✅
- Config: full secret-digest diff before vs after shows **only** `DEPLOYMENT_NONCE` changed; nothing left staged ✅

## 7. Ops Chat acceptance (production, owner signed in)

| Check | Result |
|---|---|
| `/ops` loads (new copy: "persistent · governed actions" / "Nothing changes until you explicitly confirm an action.") | PASS |
| Send a message → persisted complete reply (conversation `7251fa12-bb3a-4493-903a-b07536da3114`, id minted client-side on first send) | PASS |
| Refresh → turn reloaded from the store | PASS |
| Close tab, reopen bare `/ops` → most recent conversation restored | PASS |
| New conversation → second persisted conversation (`8bde0bdd-2ec4-41d7-9480-4b93be0421e6`) | PASS |
| Conversation picker A → B → A, each loading only its own turns | PASS |
| Persisted proposal card after reload | **DEFERRED** — production safety policy prevented creation of a synthetic governed proposal. No defect observed. Validate opportunistically on the next legitimate owner-generated proposal. |

DB cross-check: 2 conversations, each one owner turn + one linked `complete` reply; 0 proposals. The two
"Acceptance test A/B" conversations are retained as release evidence.

## 8. Rollback

| Field | Value |
|---|---|
| **Rollback — app image** | `sha256:398260b6267cec1350408759d5a19e16c740a584456c889e28d16ac41651a106` (v78, source `6f9b7aa9…`) |
| **Rollback — DB** | restore snapshot `vs_l011owJabA0vfNqQ9pRl` (pre-DDL, baseline 84 / `0083_graceful_zemo`) |

Note: `0084`/`0085` are additive (new tables + a nullable column). Rolling back the app image alone without the DB
restore leaves the new tables unused.

## 9. Build worktree

Build worktree: `C:\Users\baldd\dev\king-prod-build-099927e` (detached HEAD at `099927eb`). **Retain until this evidence
record is merged**, then it may be removed (digest, receipt IDs, workflow run IDs, rollback snapshot and acceptance
results are all captured above).
