# G-Backup — production receipt-publication path (design + owner runbook)

This document is the production analog of the staging receipt-publication cutover. It is **design + owner actions
only** — nothing here is provisioned by code. The repo side (this PR) adds the gated publisher workflow
`.github/workflows/publish-production-receipt.yml` and its CLI entry `scripts/ci/publish-production-receipt.ts`
(a thin per-environment wrapper over the same reviewed publisher as staging, pinned to `PRODUCTION_PINS`).

Production identities (verified live, read-only):

| Fact | Value |
|---|---|
| Prod app | `king-ai-ops-hub-prod` |
| Prod DB app | `king-ai-hub-db-prod` |
| Prod source volume | `vol_vlye16958n6x6ed4` (10 GB, snapshot retention 30 d, scheduled on) |
| Prod DB system identifier | `7673854635852591781` |
| Prod baseline | release v49, migration 69 (`0068_knowledge_pinned`) |
| Target | main `4d51d4214a25c2047fef7add6a0271ce390be2be` → 78 (`0077_chunky_owl`); pending `0069…0077` (9) |
| Receipt locator prefix (from `PRODUCTION_PINS`) | `v2/production/king-ai-ops-hub-prod/<deploymentNonce>.json` |

---

## C. AWS production WORM receipt store — required configuration (DO NOT PROVISION YET)

Bucket **`king-ai-ops-hub-receipts-prod`**, AWS S3, region **`us-east-1`**. Mirror of the staging bucket, with a
production prefix.

- **Object Lock: enabled at bucket creation** (cannot be added later), default retention **COMPLIANCE, 30 days**.
- **Versioning: Enabled** (required by Object Lock).
- **Block Public Access:** ACL blocks **ON**; **policy blocks OFF** (the bucket policy grants the narrow anonymous read).
- **Bucket policy** (two statements):
  1. **Anonymous `s3:GetObject`** on `arn:aws:s3:::king-ai-ops-hub-receipts-prod/v2/production/king-ai-ops-hub-prod/*`
     **only** (public read of published receipts, nothing else).
  2. **Deny `s3:PutObject`** when the request lacks the `s3:if-none-match` condition — forces **create-only** writes
     at the bucket (no overwrite of an existing receipt), matching the publisher's `If-None-Match:*`.
- **No public write** of any kind.
- **Lifecycle** `expire-receipts-after-lock` (prefix `v2/`): expire current ≥ **90 days** + delete noncurrent ≥ 90 days
  (≥ the 30-day COMPLIANCE lock, so nothing is deleted while locked).
- **Dedicated least-privilege publisher IAM principal** `gbackup-receipt-publisher-prod`, inline policy
  `receipt-create-only`:
  - Allow **`s3:PutObject`** + **`s3:GetObject`** on
    `arn:aws:s3:::king-ai-ops-hub-receipts-prod/v2/production/king-ai-ops-hub-prod/*` **only**.
  - **No** `s3:DeleteObject`, **no** `s3:ListBucket`, **no** access to the staging bucket, **no** access to the app
    document / library / VER-002 buckets, no other S3 action.
  - Create one access key; the **owner holds it** (never pasted to the assistant).

---

## D. Production GitHub Environment config — exact names required later

Configure on the **`production`** Environment (keep its existing `required_reviewers` + `branch_policy` protections).
The prod signing key secret `GBACKUP_RECEIPT_SIGNING_KEY_B64` already exists (used by `sign-production-receipt.yml`)
and is **not** used by the publisher.

**Secrets (5 — dedicated production receipt-publish S3 credential):**
- `GBACKUP_RECEIPT_S3_ACCESS_KEY_ID`
- `GBACKUP_RECEIPT_S3_SECRET_ACCESS_KEY`
- `GBACKUP_RECEIPT_S3_ENDPOINT` = `https://s3.us-east-1.amazonaws.com`
- `GBACKUP_RECEIPT_S3_REGION` = `us-east-1`
- `GBACKUP_RECEIPT_S3_BUCKET` = `king-ai-ops-hub-receipts-prod`

**Vars (3 — non-secret public verification config):**
- `GBACKUP_RECEIPT_BASE_URL` = `https://king-ai-ops-hub-receipts-prod.s3.us-east-1.amazonaws.com`
- `GBACKUP_RECEIPT_HOSTS` = `king-ai-ops-hub-receipts-prod.s3.us-east-1.amazonaws.com`
- `GBACKUP_RECEIPT_TRUST_BUNDLE` = the production signing key's PUBLIC trust bundle (see E — verify it matches the
  prod signer key before use).

---

## E. Production Fly cutover plan (DO NOT STAGE YET)

The two **non-secret** receipt-fetch values the production release gate reads must point at the new prod WORM store.
Stage them (apply on the next deploy, no separate release) at window time:

```bash
fly secrets set --stage -a king-ai-ops-hub-prod \
  GBACKUP_RECEIPT_BASE_URL='https://king-ai-ops-hub-receipts-prod.s3.us-east-1.amazonaws.com' \
  GBACKUP_RECEIPT_HOSTS='king-ai-ops-hub-receipts-prod.s3.us-east-1.amazonaws.com'
```

- `DEPLOYMENT_NONCE` is staged per-window with the window's canonical nonce (same pattern proven on staging).
- **Leave `GBACKUP_RECEIPT_TRUST_BUNDLE` unchanged** unless verification proves the currently configured prod public
  key differs from the production signer key. **Verify before the window:** confirm the prod Fly
  `GBACKUP_RECEIPT_TRUST_BUNDLE` (and the prod Environment var) contains the public key for the key id used by
  `sign-production-receipt.yml` (e.g. `prod-dbr-2026-08`). If it does not match, update it in the reviewed step.

---

## Owner actions still required before a production window (summary)

1. Provision AWS bucket `king-ai-ops-hub-receipts-prod` per **C** (Object Lock COMPLIANCE 30 d, versioning, policy,
   lifecycle) + the `gbackup-receipt-publisher-prod` IAM key.
2. Set the 5 `GBACKUP_RECEIPT_S3_*` **secrets** + 3 receipt **vars** on the GitHub **production** Environment per **D**.
3. Verify the production `GBACKUP_RECEIPT_TRUST_BUNDLE` matches the prod signer key (var + Fly secret).
4. At window time, `--stage` the two prod Fly values per **E** (not before).
5. Decommission any stale prod Tigris receipt bucket after cutover (if one exists).

Only after 1–3 are done + verified can the production coordinated window run
(snapshot → `sign-production-receipt.yml` → `publish-production-receipt.yml` → deploy the exact signed digest). The
Model A image-identity gate already applies to production by code (`isEnforced` includes `production`; namespace
`registry.fly.io/king-ai-ops-hub-prod`).
