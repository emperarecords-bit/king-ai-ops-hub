# Staging G-Backup receipt signing (manual workflow)

How to produce a signed **receipt-v2** for the staging release gate using the manual GitHub Actions workflow
[`Sign staging backup receipt`](../.github/workflows/sign-staging-receipt.yml). This PR adds the *signing pipeline
and its verification*; it does **not** create a real key, add any GitHub/Fly secret, take a snapshot, produce the
real staging receipt, or deploy. Those remain separately owner-gated.

The signer/verifier contract is the already-reviewed G-Backup-B1 library
([`receipt-v2-sign.ts`](../scripts/backup/receipt-v2-sign.ts),
[`receipt-v2-verify.ts`](../scripts/backup/receipt-v2-verify.ts),
[`receipt-key-bundle.ts`](../scripts/backup/receipt-key-bundle.ts)). The workflow invents no new format.

---

## 1. Key format (exact)

| | Format |
|---|---|
| **Private signing key** | Ed25519 **PKCS#8 PEM** (`-----BEGIN PRIVATE KEY-----`). Loaded with `crypto.createPrivateKey`; signing is `crypto.sign(null, bytes, key)` (Ed25519). |
| **Public / trust-bundle key** | Ed25519 **SPKI PEM** (`-----BEGIN PUBLIC KEY-----`), DER SubjectPublicKeyInfo length **44**. Loaded with `crypto.createPublicKey`. |
| **Key ID** | `^[A-Za-z0-9._-]{1,128}$` (e.g. `staging-dbr-2026-08`). |
| **Fingerprint** | `sha256(DER SPKI)` hex — the canonical identity used for duplicate detection. |
| **Signature** | unpadded **base64url** Ed25519 over `RECEIPT_V2_SIGN_DOMAIN + canonicalizeV1(signedPayload)`. |

Generate a **non-production test** keypair locally (do **not** commit; do **not** use as the real signer):

```bash
openssl genpkey -algorithm ed25519 -out staging-dbr.test.key.pem       # PKCS#8 private (KEEP SECRET)
openssl pkey -in staging-dbr.test.key.pem -pubout -out staging-dbr.test.pub.pem   # SPKI public
```

The tests do **not** need this — they generate ephemeral keys in-process. The real owner signing key is created and
held by the owner via their approved secure mechanism and is **never** generated in this repo or CI.

---

## 2. GitHub secret design

| | |
|---|---|
| **Proposed secret name** | `GBACKUP_RECEIPT_SIGNING_KEY_B64` |
| **Scope** | a **GitHub Environment** secret on an environment named **`staging`** (not a plain repo secret), so the environment's required-reviewer protection gates every run. |
| **Encoding** | **base64 of the PKCS#8 PEM** (single line — sidesteps multiline-secret handling). The workflow decodes it into `GBACKUP_SIGNING_KEY_PEM_B64`. A raw multiline PEM is also supported by the CLI via `GBACKUP_SIGNING_KEY_PEM`, but base64 is preferred. |
| **How to create the base64** | `base64 -w0 staging-dbr.key.pem` (owner's real key, done off-repo). |
| **How to insert** | repo → **Settings → Environments → `staging` → Add secret** → name `GBACKUP_RECEIPT_SIGNING_KEY_B64`, paste the base64 string. Configure **required reviewers** on the `staging` environment so a human approves each signing run. |
| **Materialization** | the workflow maps `secrets.GBACKUP_RECEIPT_SIGNING_KEY_B64` → env `GBACKUP_SIGNING_KEY_PEM_B64`; the CLI decodes it, builds a `KeyObject`, signs, and drops the reference. The key is **never** written to disk. |

**The private key must never be** committed, printed, uploaded as an artifact, put in a job summary, passed as a
workflow *input*, or copied into Fly staging. A static workflow test and a runtime scan
(`assertNoPrivateMaterial`, plus a `grep 'PRIVATE KEY' receipt-out` step) enforce this.

> This PR does **not** add the secret. Adding it is a separate owner action.

---

## 3. Verification trust output (`GBACKUP_RECEIPT_TRUST_BUNDLE`)

The workflow derives the matching **public** trust-bundle entry from the private key and uploads it as
`trust-bundle.public.json`. It is the exact value later configured as the gate's `GBACKUP_RECEIPT_TRUST_BUNDLE`
(a JSON array):

```json
[
  {
    "keyId": "staging-dbr-2026-08",
    "algorithm": "ed25519",
    "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n…SPKI…\n-----END PUBLIC KEY-----\n",
    "purpose": "deployment_backup_receipt",
    "status": "active"
  }
]
```

- **Correspondence check:** the workflow self-verifies the freshly signed receipt against this derived public entry
  using the runtime verifier — if the public entry did not match the signer, signing would fail the run.
- **Rotation:** issue a new `keyId`, add its public entry with `status: "active"`, mark the old entry
  `status: "revoked"` (keep it listed so old receipts are explicitly rejected, not merely unknown), and start signing
  with the new key. Fingerprint-based duplicate detection prevents re-adding the same key under a second id.

Public material may appear in workflow artifacts/summaries. Private material may not.

---

## 4. What the workflow does (and does not)

1. checks out the exact `source_commit`; **fails if it is not an ancestor of protected `main`**;
2. `npm ci`; runs `scripts/ci/sign-staging-receipt.ts` (the CLI wrapper over the pure producer in
   `scripts/backup/sign-staging-receipt.ts`), which:
   - rejects placeholder (`UNKNOWN`) source/image, validates the **digest-bound** image ref, canonical nonce,
     nonzero uint64 DB system id, `vs_…` snapshot id, retention ≥ 7;
   - **derives** `portableMigrationSetHash`, `runtimeMigrationSetHash`, and the canonical **pending set** from the
     checked-out `drizzle/` tree (asserts endpoint `0056_milky_goliath`, count `57`); pins the immutable staging
     facts (`environment=staging`, `targetApplication=king-ai-ops-hub-staging`,
     `databaseApp=king-ai-hub-db-staging`, `sourceVolumeId=vol_4m3kmknl059qpd6v`);
   - assembles + schema-validates the receipt, signs it, and **self-verifies** with the runtime verifier;
   - writes only the signed receipt, the public trust bundle, and safe metadata;
3. scans the outputs for `PRIVATE KEY` (fails closed) and uploads them as a 7-day artifact.

It does **not** call Fly, create a snapshot, run a migration, deploy, or publish to the final HTTPS receipt endpoint
(`receipt_mode` is `artifact-only`). Publishing to the gate's `GBACKUP_RECEIPT_BASE_URL` is a later, separate step.

---

## 5. Security controls

- `workflow_dispatch` only; **no** `push` / `pull_request` / `pull_request_target` / `schedule` /
  `repository_dispatch`.
- `permissions: contents: read` (no write, no `id-token`).
- Job gated to the canonical repo (`github.repository == 'emperarecords-bit/king-ai-ops-hub'`) so forked code never
  runs with the signing secret; the `staging` **Environment** adds required-reviewer approval.
- Third-party actions pinned to immutable commit SHAs (`actions/checkout`, `actions/setup-node`,
  `actions/upload-artifact`).
- No arbitrary shell fragments are built from inputs; inputs are passed as `env:` values, never interpolated into a
  shell command.
- Artifacts contain no credentials or database URLs; the receipt carries only the non-secret release facts.
