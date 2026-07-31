import { z } from 'zod';

/**
 * G-Backup-A2 — legacy execution attestation SCHEMA + types + constants (no crypto here).
 *
 * Corrections: `reviewedSourceCommit` (provenance, NOT an exact-current-deployment constraint) is separated
 * from runtime binding (which is against the CURRENT source-manifest entry). Explicit repository / application /
 * namespace / path / environment scope prevents cross-repo/app reuse.
 *
 * Content-safety note (corrected): `.strict()` rejects UNRECOGNIZED fields, and each field's format/length/
 * character/pattern constraints reduce accidental secret inclusion and reject known dangerous forms (embedded-
 * credential URLs, PEM blocks, bearer tokens, multiline text, control characters). This does NOT mathematically
 * prove that no sensitive identifier or datum could ever appear in an allowed field.
 */

export const LEGACY_ATTESTATION_VERSION = '1' as const;
export const LEGACY_SIGNATURE_ALGORITHMS = ['ed25519'] as const;
export const LEGACY_DIFFERENCE_TYPES = ['eol_only'] as const;
export const LEGACY_SQL_CONTEXT_RESULTS = ['outside_sensitive_content', 'uncertain', 'inside_sensitive_content'] as const;
export const LEGACY_DB_EFFECT_RESULTS = ['local_staging_agree', 'divergent', 'unverified'] as const;
export const LEGACY_TREATMENTS = ['signed_legacy_execution_attestation'] as const;
export const LEGACY_ENVIRONMENTS = ['development', 'staging', 'production'] as const;
export type LegacyEnvironment = (typeof LEGACY_ENVIRONMENTS)[number];
export const LEGACY_KEY_PURPOSE = 'legacy_migration_attestation' as const;

const Ident = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
/** Repository identity such as `owner/repo` — exact, case-sensitive; allows a slash. Never a URL. */
const RepoId = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/);
const PathStr = z.string().min(1).max(256).regex(/^[A-Za-z0-9._/-]+$/);
const LowerToken = z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/);
/** Deterministic attestation id: `lma1_<sha256 of the canonical payload minus attestationId+signature>`. */
const AttestationId = z.string().regex(/^lma1_[0-9a-f]{64}$/);
const HexCommit = z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/);
const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const SignatureB64Url = z.string().min(80).max(120).regex(/^[A-Za-z0-9_-]+$/);
const MigrationTag = z.string().min(1).max(128).regex(/^[0-9]{4}_[a-z0-9_]+$/);
const IsoUtcTimestamp = z
  .string()
  .max(40)
  .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$/, 'must be a normalized UTC (…Z) timestamp')
  .refine((s) => !Number.isNaN(Date.parse(s)), 'invalid timestamp');
const Uint = z.number().int().nonnegative();

// -- Evidence manifest (structural evidence only) -----------------------------

export const evidenceManifestSchema = z
  .object({
    manifestVersion: z.literal('1'),
    forensicMethodVersion: Ident,
    migrationIndex: Uint,
    migrationTag: MigrationTag,
    journalTimestamp: Uint,
    reviewedSourceCommit: HexCommit,
    sourceBlobHash: Sha256Hex,
    appliedExecutionHash: Sha256Hex,
    sourceByteLength: Uint,
    appliedByteLength: Uint,
    lfCount: Uint,
    crlfCount: Uint,
    loneCrCount: Uint,
    insertedByteCount: Uint,
    deletedByteCount: Uint,
    substitutedByteCount: Uint,
    insertedCrBeforeLfCount: Uint,
    changedLineIndexes: z.array(Uint).max(100000),
    eolMapHash: Sha256Hex,
    sqlContext: z
      .object({
        hasStringLiteralSpanningNewline: z.boolean(),
        hasDollarQuote: z.boolean(),
        hasCopyFromStdin: z.boolean(),
        hasProceduralBody: z.boolean(),
        changedEolInsideSensitiveContent: z.boolean(),
      })
      .strict(),
    statementCategoryCounts: z.record(z.string().max(32), Uint),
    databaseObjectCategoryCounts: z.record(z.string().max(64), Uint),
    localStagingComparison: z.enum(['agree', 'divergent']),
  })
  .strict();

export type LegacyEvidenceManifest = z.infer<typeof evidenceManifestSchema>;

// -- Attestation --------------------------------------------------------------

export const signedAttestationSchema = z
  .object({
    attestationVersion: z.literal(LEGACY_ATTESTATION_VERSION),
    attestationId: AttestationId,
    // Scope (correction 2)
    repositoryId: RepoId,
    applicationId: Ident,
    migrationNamespace: Ident,
    migrationPath: PathStr,
    allowedEnvironments: z.array(z.enum(LEGACY_ENVIRONMENTS)).min(1).max(3),
    // Migration identity
    migrationIndex: Uint,
    migrationTag: MigrationTag,
    journalTimestamp: Uint,
    // Provenance (NOT an exact current-deployment constraint) + informational
    reviewedSourceCommit: HexCommit,
    reviewedMigrationSetHash: Sha256Hex,
    // Runtime-bound execution identity
    sourceBlobHash: Sha256Hex,
    appliedExecutionHash: Sha256Hex,
    // Byte-difference proof
    sourceByteLength: Uint,
    appliedByteLength: Uint,
    differenceType: z.enum(LEGACY_DIFFERENCE_TYPES),
    insertedByteCount: Uint,
    deletedByteCount: Uint,
    substitutedByteCount: Uint,
    insertedCrBeforeLfCount: Uint,
    changedLineIndexes: z.array(Uint).max(100000),
    eolMapHash: Sha256Hex,
    sqlContextAssessment: z.enum(LEGACY_SQL_CONTEXT_RESULTS),
    databaseEffectAssessment: z.enum(LEGACY_DB_EFFECT_RESULTS),
    evidenceManifestHash: Sha256Hex,
    // Approval identity (correction 6)
    approvedTreatment: z.enum(LEGACY_TREATMENTS),
    approvedAt: IsoUtcTimestamp,
    approverRole: LowerToken,
    approverId: LowerToken,
    approvingOrganization: Ident,
    signatureAlgorithm: z.enum(LEGACY_SIGNATURE_ALGORITHMS),
    keyId: Ident,
  })
  .strict();

export type SignedLegacyAttestation = z.infer<typeof signedAttestationSchema>;

export const legacyAttestationSchema = signedAttestationSchema.extend({ signature: SignatureB64Url }).strict();
export type LegacyMigrationAttestation = z.infer<typeof legacyAttestationSchema>;

export function toSignedAttestationPayload(a: LegacyMigrationAttestation): SignedLegacyAttestation {
  const { signature: _s, ...signed } = a;
  void _s;
  return signed;
}

// -- Trusted-key bundle entry (validated by the loader, not a raw record) ------

export const trustKeyEntrySchema = z
  .object({
    keyId: Ident,
    algorithm: z.enum(LEGACY_SIGNATURE_ALGORITHMS),
    /** PEM-encoded SPKI public key. */
    publicKeyPem: z.string().min(1).max(4096),
    purpose: z.literal(LEGACY_KEY_PURPOSE),
    status: z.enum(['active', 'revoked']),
    notBefore: IsoUtcTimestamp.optional(),
    notAfter: IsoUtcTimestamp.optional(),
  })
  .strict();

export type TrustKeyEntry = z.infer<typeof trustKeyEntrySchema>;

/**
 * DEFERRED (design only; not activated in G-Backup-A2): a signed / source-controlled attestation-WITHDRAWAL
 * record. Key revocation (via the trust bundle) is implemented; attestation-level withdrawal is documented here
 * so deletion of a source file is never the only revocation path. No withdrawal record is created now.
 */
export const withdrawalRecordSchema = z
  .object({
    withdrawalVersion: z.literal('1'),
    withdrawnAttestationId: AttestationId,
    reasonCode: LowerToken,
    effectiveAt: IsoUtcTimestamp,
    approvingAuthority: Ident,
    replacementAttestationId: AttestationId.optional(),
    signatureAlgorithm: z.enum(LEGACY_SIGNATURE_ALGORITHMS),
    keyId: Ident,
    signature: SignatureB64Url,
  })
  .strict();

export type LegacyWithdrawalRecord = z.infer<typeof withdrawalRecordSchema>;
