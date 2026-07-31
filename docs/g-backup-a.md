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

## Corrections round 2 — three identities, recognized EOL variants, catalog bootstrap

**Three distinct migration identities** (correction 1):
- `sourceMigrationSetHash` (`source-manifest.ts`) — derived from ordered **Git blob** contents at an exact,
  resolved source commit (idx, tag, when, committed-blob sha256). OS-/autocrlf-stable. **This is what the signed
  receipt's `migrationSetHash` means.** Never the working tree.
- `drizzleExecutionHash` (`migration-hash.ts`) — sha256 of the raw file bytes present in the execution env.
- `appliedExecutionHash` — the immutable hash in `drizzle.__drizzle_migrations` (never modified).

**Recognized line-ending variants (newline transform ONLY):** for each committed blob the detector derives the
exact committed hash plus **one** deterministic EOL transform (LF→CRLF for an LF blob, CRLF→LF for a CRLF blob;
MIXED blobs have no variant). An applied hash is a recognized variant **only** if it exactly equals one of those.
No space/tab/trailing-whitespace/blank-line/Unicode/comment/separator normalization. A recognized variant does
**not** become `HISTORICAL_HASH_MISMATCH` when timestamp+ordinal+ordering match and the source blob is bound to
the expected commit; the overall state may remain `NO_PENDING` with structured evidence (`exactExecutionMatches`,
`lineEndingVariantMatches`, per-migration variant details). A **runtime-byte warning** is still reported when the
current working-tree bytes differ from the applied historical bytes (diagnostic; not a blocker for an applied,
schema-free migration). A **pending** migration whose runtime bytes are not an exact committed-source or
recognized EOL variant is **blocked**.

**Catalog-complete `BOOTSTRAP_EMPTY`** (correction 3): the reader probes `pg_class`/`pg_proc` joined to
`pg_namespace`, excluding system schemas and extension-owned objects (`pg_depend deptype='e'`). Any user
table/partition/sequence/view/matview/function outside that allowlist ⇒ `MIGRATION_TABLE_MISSING_NONEMPTY`.
`BOOTSTRAP_EMPTY` requires: table absent **and** explicit declaration **and** database-identity match **and** no
unexplained user objects. An empty `public` schema is allowed; an `app` schema (a Hub object) is not.

**Backup required for `PENDING_FORWARD` in EVERY environment** (correction 4): no development bypass. A logical
dev-backup receipt is deferred to G-Backup-C; until then a development `PENDING_FORWARD` is blocked.

**Receipt content constraints** (correction 5): each field carries a bounded charset/length, so a credential URI,
bearer token, PEM block, multiline value, or control character cannot be smuggled into an allowed string field.
Structural + pattern-based — not a proof that no secret can ever be embedded.

**Ordering / duplicates** (correction 6): `drizzle.__drizzle_migrations` is `(id integer, hash text, created_at
bigint)`; ordering `created_at asc, id asc`. Fail-closed on duplicate applied timestamp/hash, out-of-order
applied rows, applied-count > source, and duplicated/unordered journal timestamps.

### Build-provenance limitation (correction 1)

The current Fly image is built from the **local working-tree build context**; a git commit alone does not prove
the build context was byte-identical to the git blobs. **G-Backup-B must receive or embed a trusted source
manifest generated from the approved commit** (serialized JSON — the release image may not contain `.git`), and
the release validator must compare the actual migration files in the image against that manifest and **fail
closed** on any dirty/altered/unsupported build-context file. A separate source-build-hardening increment (not
now) may add `drizzle/*.sql text eol=lf`, clean-tree enforcement, clean-checkout/`git archive` builds, and
artifact-to-commit attestation.

### Confirmed classification — and the `0004` finding

Running the corrected detector against the **real** applied histories (read-only):
- `0053_pricing_foundations`: committed LF; its deterministic CRLF variant equals staging's applied hash →
  **recognized clean variant** ✓.
- `0004_knowledge_k1`: committed LF (`71beb3fb…`); its deterministic CRLF variant is `0564b6e6…`, but **both
  staging and local applied `c2c7463a…`** — which matches **neither** the committed blob **nor** its single
  deterministic EOL transform. It LF-normalizes to the committed content (so it is line-ending-only in the loose
  sense) but is an **irregular/mixed** form. Under the strict policy this is **`HISTORICAL_HASH_MISMATCH`**, not a
  recognized variant.

Consequence: the corrected detector classifies **both staging and the local dev DB as `HISTORICAL_HASH_MISMATCH`
on `0004`** (0 divergences; 0053 recognized), which **differs from the previously stated expectation of
`NO_PENDING`**. This is surfaced (not hard-coded) for owner decision — see the correction report. Historical
`__drizzle_migrations` rows were not modified.

## G-Backup-A2 — signed legacy execution attestation (Treatment B)

A narrowly-scoped, immutable, owner-signed recognition of ONE historical migration whose applied bytes differ
from the committed source by a proven-inert difference. Not an alias, not a policy relaxation, not a wildcard.

- **Separate authority:** Ed25519 keys **distinct** from deployment-backup receipts and every app secret
  (`APP_ENCRYPTION_KEY`, GitHub, Fly, DB, provider). A dedicated public-key trust store + revocation set.
- **Schema (`legacy-attestation.ts`):** strict, bounded `LegacyMigrationAttestationV1` binding index/tag/
  timestamp/sourceCommit/sourceBlobHash/appliedExecutionHash + byte-difference proof + `evidenceManifestHash` +
  treatment + approver + signature. A separate strict **evidence manifest** carries structural evidence only
  (no SQL/DB contents); the attestation binds its hash and the verifier recomputes it.
- **Detector match class `LEGACY_ATTESTED_MATCH`:** granted only when exact + EOL-variant both failed AND a
  fully-verified attestation matches the exact index/tag/timestamp/sourceCommit/sourceBlobHash/appliedHash, the
  evidence-manifest hash verifies, the key is trusted + not revoked, and the treatment is supported. Never by
  tag/hash alone; no wildcard/range/prefix. Results surface separate counts: exact / EOL-variant /
  legacy-attested / unknown-mismatch / divergence. `NO_PENDING` requires every applied migration to be exact, an
  EOL variant, or a valid legacy-attested match, with nothing pending.
- **Fail-closed:** an unsigned draft, evidence manifest, owner statement, comment, fixture, or hard-coded pair
  makes nothing pass; malformed/missing/revoked/mis-scoped attestations contribute nothing. `0004` stays
  `HISTORICAL_HASH_MISMATCH` until a **real signed** attestation is committed under separate authorization.
- **Storage:** production verification consumes only an explicit, validated trusted bundle + key store — never
  an arbitrary repo file. Unsigned drafts live in `scripts/backup/legacy-drafts/` (inactive, never loaded).

### G-Backup-A2 corrections

- **No exact-current-commit circular dependency.** `reviewedSourceCommit` (+ informational `reviewedMigrationSetHash`)
  is **provenance only**. Runtime authorization binds to the **current** source-manifest entry: repositoryId,
  applicationId, migrationNamespace, migrationPath, migrationIndex, migrationTag, journalTimestamp, and
  `sourceBlobHash`. A later deployment commit (with legitimate forward migrations) still verifies; a **changed
  historical blob** (`sourceBlobHash` differs) invalidates it. Whole-migration-set-hash equality is **not**
  required. Optional ancestry (reviewedSourceCommit ⊑ deployment commit) is **producer-side** evidence from a
  trusted build manifest (`requireAncestry`/`ancestryConfirmed`) — never a runtime `.git` claim.
- **Repository / application / environment scope.** Explicit `repositoryId`, `applicationId`, `migrationNamespace`,
  `migrationPath`, and a bounded `allowedEnvironments` list (`development`/`staging`/`production`). The verifier
  requires exact matches against trusted runtime config; **no wildcard**. **Production is never inherited from
  staging** — the `0004` draft's `allowedEnvironments` is `[development, staging]` only.
- **Signer/runtime separation.** Split into `legacy-attestation-schema.ts`, `-canonical.ts`, `-verify.ts`
  (runtime; PUBLIC keys only), and `-sign.ts` (the ONLY module taking a private key). The runtime verifier, the
  migration detector, and `scripts/migrate.ts` do **not** import the signer — enforced by a static boundary test.
- **Invalid-attestation diagnostics.** A supplied-but-invalid attestation yields a structured, non-secret
  `invalidLegacyAttestations` entry `{idx, tag, reasonCode, keyId}` (`schema_invalid`, `unknown_key`,
  `revoked_key`, `invalid_signature`, `scope_mismatch`, `source_mismatch`, `applied_hash_mismatch`,
  `evidence_mismatch`, `unsupported_version`/`_algorithm`/`_treatment`, `invalid_byte_claim`, `unsafe_assessment`,
  `ancestry_unverifiable`, or `bundle_invalid`). The migration stays blocked; absent ≠ invalid.
- **Bundle duplicate/conflict rules (fail-closed).** `validateAttestationBundle` rejects a duplicate
  `attestationId` (even if identical — no "first file wins"), and more than one attestation for the same
  (repositoryId, applicationId, migrationTag, appliedExecutionHash) scope regardless of key, and any
  schema-invalid entry. `attestationId` must be unique; `attestationContentDigest` is available for
  content-equality checks.
- **Approval identity.** `approverId` + `approvingOrganization` (bounded, non-secret) alongside `approverRole`;
  the key id remains the cryptographic identity. The draft leaves these (and `applicationId`, `keyId`,
  `approvedAt`) as placeholders — never auto-chosen in code.

### Owner offline signing ceremony (proposed — do NOT execute now)

1. Owner generates a **dedicated** Ed25519 key **outside** the app/repo (e.g. `ssh-keygen -t ed25519` or
   `openssl genpkey -algorithm ed25519`), kept offline / in an approved secrets manager. **Never pasted into chat.**
2. Owner extracts the **public** key only.
3. Public key reviewed and added to the trust store under a **separate authorized commit** (onboarding).
4. Claude produces the **final canonical unsigned payload** (from the completed `signedPayload` with real
   `keyId`/`approvedAt`) and displays its SHA-256 digest + the human-readable structural facts.
5. Owner verifies the displayed facts (index 4, tag, source `71beb3fb…`, applied `c2c7463a…`, +1 `0x0D` at line
   48, EOL-map `99dbc727…`, evidence hash `3c0453dc…`).
6. Owner signs the exact canonical bytes **offline** with the private key.
7. Owner returns **only** the signature + public metadata (never the private key).
8. The signature is **independently verified** (`verifyLegacyAttestation`) before activation.
9. The finalized **signed** attestation is committed via a **separate authorization** and referenced in the
   trusted bundle.
10. **Revocation:** the key id is added to the trust store's `revoked` set (a separate authorized commit);
    `verifyLegacyAttestation` rejects any attestation signed by a revoked key, immediately re-failing-closed the
    affected migration until re-attested with a new key.

## Scope

Implemented: journal reader, DB migration-state reader, deterministic set hashing, classifier, receipt schema +
canonical serializer + Ed25519 verifier + semantic validator, and the pure decision function — with unit,
integration, static-boundary tests, and this document. **Not** implemented: snapshot creation, any Fly mutation,
`pg_dump`, edits to `scripts/migrate.ts`, Docker/Fly config, new env vars, real keys, schema/RLS changes,
deployment, or CI workflows. Those belong to G-Backup-B / G-Backup-C.
