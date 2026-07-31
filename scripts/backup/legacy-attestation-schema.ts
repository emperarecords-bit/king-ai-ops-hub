import { z } from 'zod';

/**
 * G-Backup-A2 — legacy execution attestation SCHEMA + types + constants (no crypto here).
 *
 * Corrections: `reviewedSourceCommit` (provenance, NOT an exact-current-deployment constraint) is separated
 * from runtime binding (which is against the CURRENT source-manifest entry). Explicit repository / application /
 * namespace / path / environment scope prevents cross-repo/app reuse. Bounded, `.strict()` fields keep secrets
 * and SQL structurally out.
 */

export const LEGACY_ATTESTATION_VERSION = '1' as const;
export const LEGACY_SIGNATURE_ALGORITHMS = ['ed25519'] as const;
export const LEGACY_DIFFERENCE_TYPES = ['eol_only'] as const;
export const LEGACY_SQL_CONTEXT_RESULTS = ['outside_sensitive_content', 'uncertain', 'inside_sensitive_content'] as const;
export const LEGACY_DB_EFFECT_RESULTS = ['local_staging_agree', 'divergent', 'unverified'] as const;
export const LEGACY_TREATMENTS = ['signed_legacy_execution_attestation'] as const;
export const LEGACY_ENVIRONMENTS = ['development', 'staging', 'production'] as const;
export type LegacyEnvironment = (typeof LEGACY_ENVIRONMENTS)[number];

const Ident = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const PathStr = z.string().min(1).max(256).regex(/^[A-Za-z0-9._/-]+$/);
const LowerToken = z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/);
const HexCommit = z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/);
const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const SignatureB64Url = z.string().min(80).max(120).regex(/^[A-Za-z0-9_-]+$/);
const MigrationTag = z.string().min(1).max(128).regex(/^[0-9]{4}_[a-z0-9_]+$/);
const IsoTimestamp = z.string().max(40).regex(/^[0-9T:.\-+Z]+$/).refine((s) => !Number.isNaN(Date.parse(s)), 'invalid timestamp');
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
    attestationId: Ident,
    // Scope (correction 2)
    repositoryId: Ident,
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
    approvedAt: IsoTimestamp,
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
