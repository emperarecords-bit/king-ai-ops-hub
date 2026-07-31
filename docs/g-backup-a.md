# G-Backup-A — Migration detection, receipt contract, verification (foundations)

G-Backup-A is the **pure, read-only foundation** of the migration-backup portability increment. It adds no
snapshot creation, does not modify `scripts/migrate.ts`, adds no database table, and changes no deployment.
It provides the detection + receipt-verification primitives that G-Backup-B will use to fail-closed a
schema-changing deployment.

## Modules (`scripts/backup/`)

- `migration-hash.ts` — version-pinned mirror of drizzle-orm **0.45.2** migration hashing, plus a deterministic
  migration-**set** hash for receipt binding.
- `migration-detector.ts` — pure `classifyMigrationState()` + read-only `detectMigrationState()`.
- `receipt-schema.ts` — strict zod contract for the deployment-backup receipt.
- `receipt-canonical.ts` — canonical signed payload (reuses P1a `canonicalizeV1`), domain-separated.
- `receipt-verify.ts` — Ed25519 `signReceipt` (producer/test) + `verifyReceipt` (release side).
- `backup-decision.ts` — the pure fail-closed gate decision.

## Drizzle hash compatibility (correction 5)

Drizzle's `readMigrationFiles` is not reliably importable under the `tsx` script runtime, so the algorithm is
**mirrored** behind a version-pinned adapter and proven against the real DB:

- **Algorithm (drizzle 0.45.2, verified in `node_modules/drizzle-orm/migrator.js`):**
  `hash = sha256( fs.readFileSync(<folder>/<tag>.sql).toString() )` — over the **whole raw file text**, UTF-8,
  no normalization; the statement split on `--> statement-breakpoint` does **not** affect the hash.
- **Applied record:** `drizzle.__drizzle_migrations(hash text, created_at bigint)`, where `created_at` equals
  the journal entry's `when` (folderMillis). Ordering key: `created_at asc` (tie-break `id asc`).
- **Version guard:** if the installed `drizzle-orm` version ≠ `0.45.2`, the detector returns `DETECTOR_FAILURE`
  (the mirror is only proven for the pinned version). Re-pin + re-verify on any upgrade.
- **Compatibility test:** the integration test runs drizzle's OWN `readMigrationFiles` over the same folder and
  asserts the mirror's per-migration hash is byte-for-byte identical — an environment-independent proof that
  the mirror faithfully replicates the installed drizzle hashing.

### Line-ending sensitivity (known + intended)

Drizzle hashes the **raw file bytes**, so the hash is line-ending sensitive. The canonical form is **LF**: git
stores the migrations as LF and the **Linux deploy container checks them out as LF**, so the container's drizzle
and this mirror both hash LF and match the applied `__drizzle_migrations` rows — the detector is authoritative
**in the deploy environment**. On a Windows dev checkout with `core.autocrlf=true`, some `drizzle/*.sql` files
carry CRLF and will not byte-match an LF-migrated database; the byte-faithful detector then correctly reports a
hash mismatch rather than a false `NO_PENDING`. A future hardening (out of scope for G-Backup-A) could pin
`drizzle/*.sql` to LF via `.gitattributes` so the detector is byte-stable on every platform; this increment does
not change repository line-ending configuration.

## Migration-state classification

| State | Meaning | May proceed w/o data backup? |
|---|---|---|
| `NO_PENDING` | DB history == repo history exactly | **Yes** (schema-free) |
| `PENDING_FORWARD` | DB is a valid prefix; forward migrations remain | No — needs a verified receipt (staging/prod) |
| `BOOTSTRAP_EMPTY` | Migrations table absent, **no** app schema/data, **explicitly declared** bootstrap | **Yes** (no Hub data to preserve) |
| `HISTORICAL_HASH_MISMATCH` | An applied historical migration's hash ≠ repo | No — fail closed, manual inspection |
| `UNKNOWN_DATABASE_DIVERGENCE` | Extra applied / reorder / duplicate / not a prefix | No — fail closed |
| `MIGRATION_TABLE_MISSING_NONEMPTY` | Tracking table absent but schema/data present, **or** empty+undeclared | No — fail closed |
| `DETECTOR_FAILURE` | Connect/parse/journal/file/query/version failure | No — fail closed |

`BOOTSTRAP_EMPTY` is emitted **only** with an explicit operator declaration and a genuinely empty database; an
unknown non-empty database is **never** auto-classified as bootstrap. RLS reapplication is not a Drizzle
migration and never affects classification (it is not an input to the classifier).

## Detection vs recovery-after-failure

The detector answers "what is safe to do **before** migrating." It does **not** assume an unrecorded/failed
migration is safe to replay: a migration may leave partial DDL when it contains non-transactional statements,
mixes transaction behavior, is interrupted, or performs external effects. Therefore, after a schema-migration
failure the policy is: **do not auto-retry → re-run the detector → stop for manual inspection.** The decision
function blocks whenever `priorFailedMigrationAttempt` is set, regardless of state.

A **future G-Backup-B migration-attempt record** (not added here) should capture: attempt id, starting state,
receipt id, migration set, start timestamp, completion status, failure point, and post-failure state.

## Receipt contract + asymmetric signatures (correction 1)

Receipts are **Ed25519-signed** (asymmetric): the **producer** (outside the release container, G-Backup-B)
holds the private key and signs; the **release process** holds only the public key and can verify but **cannot
mint** a receipt. A compromised release container cannot forge a receipt for a snapshot that never existed.

- Signed payload = every field **except** `signature`; signed bytes = `"gbackup-receipt/v1\n" + canonicalizeV1(payload)`.
- Strict schema ⇒ a receipt can carry **only** the defined fields — no DB URL, password, token, private key, or
  customer/project data is representable.
- Verification order: schema → version → algorithm → known keyId → **signature** → deployment bindings
  (env/db/volume/app/commit/migrationSetHash) → snapshot complete + nonce present → not-expired / not-future /
  snapshot-predates-migration.

### Anti-replay limitation (documented, per correction 3)

G-Backup-A binds a receipt to one environment, database, volume, application, source commit, and migration set,
with a short expiry and a `deploymentNonce`. **True one-time-use cannot be enforced without durable deployment
state**, which G-Backup-A intentionally does not add. The nonce alone does **not** prevent replay within the
validity window. G-Backup-B's external wrapper must generate a fresh nonce per attempt and bind it to a single
deployment; durable replay prevention will require CI deployment-state retention or a protected
deployment-record mechanism (deferred).

## No deployment-record table (correction 7)

G-Backup-A adds **no** `deployment_records` table (that would introduce a migration before the backup system is
operational — the bootstrap paradox). The receipt is an external signed artifact; verification results are for
deployment logs only; no organization audit event is emitted; no database table is added.

## Scope

Implemented: journal reader, DB migration-state reader, deterministic set hashing, classifier, receipt schema +
canonical serializer + Ed25519 verifier + semantic validator, and the pure decision function — with unit,
integration, static-boundary tests, and this document. **Not** implemented: snapshot creation, any Fly mutation,
`pg_dump`, edits to `scripts/migrate.ts`, Docker/Fly config, new env vars, real keys, schema/RLS changes,
deployment, or CI workflows. Those belong to G-Backup-B / G-Backup-C.
