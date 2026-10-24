# Inbox Duplicate-Question Grouping — Production Release Evidence (v83)

**Status:** ✅ Deployed to production 2026-10-19 (release **v83**). Infrastructure acceptance passed (§6).
Feature acceptance (§7) is **partial**. The safety properties passed: every question is still individually addressable,
no record was changed, and workspaces stay separate. However, **on real production data the grouping merges nothing**:
32 open questions → 32 distinct, 0 groups. So no "(K distinct)" header and no expandable group appear. The code behaves as
designed and tested. The gap is in the design: the bookkeeper's repeats are **paraphrases**, and the strict
exact-normalized-text rule deliberately does not merge paraphrases.
**Scope:** Ships #160: `src/domain/questions/grouping.ts`, the Inbox page plus `group-answer-form.tsx`, and the Ops Chat
`list_open_questions` / pulse "(K distinct)" output. It is a read-time display change. **No migration, no executor change,
no governance change, no RLS change, no config change** other than the one-use `DEPLOYMENT_NONCE`.

---

## 1. Release identity

| Field | Value |
|---|---|
| Fly release | **v83** (`complete`, created `2026-10-19T03:13:05Z`) |
| Fly app | `king-ai-ops-hub-prod` |
| Source commit | `2b081f126eded56896b3dfd31678cfef904b3491` (== `origin/main` at release time; squash merge of #160; CI 5/5 green) |
| Image digest | `sha256:0aea5b559c04b698c0d0aa463038c74fe218892eca81432acf65981994bf9ab3` |
| Image ref | `registry.fly.io/king-ai-ops-hub-prod@sha256:0aea5b559c04b698c0d0aa463038c74fe218892eca81432acf65981994bf9ab3` (label `src-2b081f1`) |
| Deploy config | `fly.production.toml` |
| Previous release | v82, image `sha256:0970ccbe3a585a9ceea439b2d2eb4a107ebd827d8e480aab4227d5fcaf2f837e` (source `6449376e7f366385e4c524464782aff2de2ddf6d`) |

## 2. Image provenance (pre-sign verification)

The image was built from the clean, dedicated worktree `C:\Users\baldd\dev\king-prod-build-2b081f1` (detached at
`2b081f1`, 0 local changes) with `fly deploy --build-only --push -c fly.production.toml` and these build args:
`SOURCE_COMMIT=2b081f126eded56896b3dfd31678cfef904b3491` and
`PORTABLE_MIGRATION_SET_HASH=92c30b02742f998a6e5db29fab61aa6bc9d402c6cf64af67e9a02cd81d2f3780`. The hash was computed with the
repository's `buildSourceManifestFromGit` over 86 migrations ending at `0085_rich_queen_noir`; it is unchanged from v79–v82.
`git diff 6449376 2b081f1` touches no `drizzle/` file.

The image was pulled **by digest**. Its `/app/source-identity.json` contained exactly `sourceCommit = 2b081f1…` and
`portableMigrationSetHash = 92c30b02…`.

## 3. Pre-release baseline (read live, read-only)

- v82 on all 4 machines (`sha256:0970ccbe…`). Baked identity on the 3 running machines = `6449376…` / `92c30b02…`.
- `/api/health` 200 (database, migrations, worker, storage s3); `/api/live` 200. `POST /api/ops-chat` 401,
  `POST /api/ops-chat/confirm` 401, `GET /ops` and `GET /inbox` 307 → `/login`.
- 44 Fly secrets, all Deployed, none staged.
- DB sysid `7673854635852591781`: **86 applied (ids 1–86), 0 hash mismatches vs `0000…0085` at `2b081f1`, 0 pending**
  (READ ONLY transaction).
- `owner_questions`: open 32 · answered 794 · dismissed 52. The digest over `(id, status, updated_at)` for all rows is
  `4c60651b27df79c11d706f9860d5eed0`.

## 4. Snapshot and receipt chain (G-Backup v2, NO_PENDING)

The release-machine gate requires a verified receipt for a non-empty database even with 0 pending migrations
(`premigration-gate.ts` step 4), so the full ceremony ran.

| Field | Value |
|---|---|
| Pre-release snapshot | `vs_Z0LLx6KV7k0Rf3NZ6DGz` (vol `vol_vlye16958n6x6ed4`, retention 30 d, 67,060,995 B) |
| Timeline | requested `2026-10-19T03:04:09.000Z` · created `03:04:15Z` · observed `03:07:59.780Z` |
| Discovery | `unambiguous-list-diff`. 50 → 51, exactly one new id, none removed. Pre digest `d092ae29e940eaccf3f15d32b6d46407c42d852d9869ccbbbd5c5adc12c74136`, post digest `81f43232dd70f723a21ed7e961db384489aca41d78ebdddcd2e7f7a0526bc96b` |
| One-use nonce | `aeb733542d889883a764e4df45b67fe0` |
| Sign run | `39193247991` — success; no private-key material in the artifact |
| Publish run | `39193437673` — success |
| Receipt id | `rcpt2_d6102375b296cbbf6c8035019d36acf9599019a2144b2c5a1aad541ba86ae3b3` |
| Receipt canonical sha256 | `46e5a81393c8e2a429cba80f4d771e1180bed06a4e72f9ba1e3650f14a3e583e` |
| Receipt file sha256 | `94abb4811e50c1897972128620f3dc8180fa617180870b67ee89780975004aa9` |
| Bound | `pendingMigrations: []`, runtime set hash `34710302d980ec574e3d597ba531041d1cea889ce100823b8ebf8070b1b76393`, key `prod-dbr-2026-08`, expires `2026-10-19T04:04:15.000Z` |
| Published object | `https://king-ai-ops-hub-receipts-prod.s3.us-east-1.amazonaws.com/v2/production/king-ai-ops-hub-prod/aeb733542d889883a764e4df45b67fe0.json` |

**Independent verification (03:12:52Z):** an anonymous GET returned 200 with 0 redirects, and the bytes equal the signer
artifact. The repository verifier `verifyReceiptV2Bytes` returned `ok: true` using production expectations (max snapshot
age 3,600,000 ms, min retention 7 d, pending set empty). The trust-bundle key fingerprint `prod-dbr-2026-08:dd746a85…`
matches the gate's deployed bundle.

## 5. Deploy

`DEPLOYMENT_NONCE` was staged at 03:13:01Z. Then `fly deploy -c fly.production.toml --image <digest-bound ref>` ran from
03:13:01Z to 03:14:25Z. Release-command machine `891e732b533d48`:

```
Acquiring migration advisory lock…
Pre-migration gate (environment=production)…
Pre-migration gate passed: verified — receipt verified for 0 pending migration(s)
Applying Drizzle migrations…
Applying RLS, roles, and append-only triggers…
Migration complete.
```

## 6. Post-deploy verification — all PASS

- v83 `complete`. Every machine is on `sha256:0aea5b55…9ab3`: web `28747923c04308` and `840493a27de7d8` (checks passing),
  worker `28654d91be6678` started, and standby worker `8d96930b022278` stopped (by design).
- `/app/source-identity.json` on all 3 running machines = `2b081f1…` / `92c30b02…`.
- `/api/health` 200 ×3, `/api/live` 200.
- Auth boundaries unchanged: `POST /api/ops-chat` 401, `POST /api/ops-chat/confirm` 401, `GET /ops` and `GET /inbox`
  307 → `/login`.
- The before/after secret-digest diff shows **only `DEPLOYMENT_NONCE`** changed; 44 → 44; nothing staged.
- DB: still 86/86, and the applied-hash list is byte-identical to the baseline.

## 7. Inbox acceptance (production, owner signed in, nothing answered)

| # | Check | Result |
|---|---|---|
| 1 | Open `/inbox` (signed in) | PASS |
| 2 | Repetitive Empera A/C bookkeeper questions are grouped | **NOT MET**: 0 groups rendered |
| 3 | Header shows the total plus "(K distinct)" | **NOT MET**: header is "0 decisions · 32 questions for you." The page adds "(K distinct)" only when groups < questions |
| 4 | Expand a duplicate group | **N/A**: no `<details>` group exists |
| 5 | Every question is individually visible and addressable | PASS: 32 questions, 32 Answer and 32 Dismiss controls |
| 6 | Grouping does not mark, answer, delete or merge records | PASS: counts open 32 / answered 794 / dismissed 52 and digest `4c60651b…` are identical before and after |
| 7 | Unrelated questions stay separate | PASS: Empera A/C (25), Empera International (4) and AccurateBids.com (3) stay separate |
| 8 | Do not answer anything | PASS: nothing was clicked |

**Root cause of 2–4 (verified, not assumed):** the deployed `normalizeQuestionText` and grouping key were run over the
32 real open questions (read-only DB export), which produced **32 distinct keys and 0 groups**. The 25 Empera A/C
questions are mostly the same request reworded by the bookkeeper on each cycle ("When can you run the paper-records
session…", "Ready to run…", "Can you run…", "Has the … session happened yet…"). The grouping rule in #160 is deliberately
strict: same workspace and identical normalized text, because "answer all at once" makes a false merge worse than a
missed one. So it is correct by its own spec but does not reach the daily-use goal on this data.

Options for the owner, not started: (a) stop the source by making the bookkeeper dedupe on ask (skip raising a question
whose intent matches an open one); (b) add an explicit, owner-confirmed "these are the same" grouping with no
automatic merge; (c) a looser similarity rule, with the risk of false merges that the strict rule exists to avoid.

## 8. Rollback

| Field | Value |
|---|---|
| **Rollback — app image** | `sha256:0970ccbe3a585a9ceea439b2d2eb4a107ebd827d8e480aab4227d5fcaf2f837e` (v82, source `6449376…`) |
| **Rollback — DB** | not needed (no schema change); the pre-release snapshot `vs_Z0LLx6KV7k0Rf3NZ6DGz` is the restore point |

## 9. Build worktree

`C:\Users\baldd\dev\king-prod-build-2b081f1` (detached at `2b081f1`). It may be removed once this record is merged.
