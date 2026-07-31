import { type KeyObject, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { z } from 'zod';
import { canonicalizeV1, hashCanonicalString } from '@/lib/canonical';

/**
 * G-Backup-A2 — signed LEGACY MIGRATION EXECUTION ATTESTATION (Treatment B).
 *
 * A narrowly-scoped, immutable, owner-signed record that recognizes ONE historical migration whose applied
 * execution bytes differ from the committed source by a proven-inert difference (e.g. a single trailing EOL
 * byte outside any SQL-sensitive content). It is NOT a hash alias, NOT a policy relaxation, and NOT a wildcard
 * — an attestation authorizes exactly one (index, tag, timestamp, sourceCommit, sourceBlobHash, appliedHash).
 *
 * Signing authority is SEPARATE from deployment-backup receipts and from every app secret. Ed25519 asymmetric:
 * the owner signs offline with a dedicated key; the verifier holds only public keys + a revocation set and can
 * never mint one. This increment uses EPHEMERAL TEST KEYS ONLY — no real/owner/production key is created,
 * stored, committed, or written to memory.
 */

export const LEGACY_ATTESTATION_VERSION = '1' as const;
export const LEGACY_SIGN_DOMAIN = 'gbackup-legacy-migration-attestation/v1\n' as const;
export const LEGACY_EVIDENCE_DOMAIN = 'gbackup-legacy-evidence/v1\n' as const;
export const LEGACY_SIGNATURE_ALGORITHMS = ['ed25519'] as const;
export const LEGACY_DIFFERENCE_TYPES = ['eol_only'] as const;
export const LEGACY_SQL_CONTEXT_RESULTS = ['outside_sensitive_content', 'uncertain', 'inside_sensitive_content'] as const;
export const LEGACY_DB_EFFECT_RESULTS = ['local_staging_agree', 'divergent', 'unverified'] as const;
export const LEGACY_TREATMENTS = ['signed_legacy_execution_attestation'] as const;

const Ident = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const LowerToken = z.string().min(1).max(32).regex(/^[a-z_]+$/);
const HexCommit = z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/);
const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const SignatureB64Url = z.string().min(80).max(120).regex(/^[A-Za-z0-9_-]+$/);
const MigrationTag = z.string().min(1).max(128).regex(/^[0-9]{4}_[a-z0-9_]+$/);
const IsoTimestamp = z.string().max(40).regex(/^[0-9T:.\-+Z]+$/).refine((s) => !Number.isNaN(Date.parse(s)), 'invalid timestamp');
const Uint = z.number().int().nonnegative();

// -- Evidence manifest (structural evidence only; never SQL/DB contents) ------

export const evidenceManifestSchema = z
  .object({
    manifestVersion: z.literal('1'),
    forensicMethodVersion: Ident,
    migrationIndex: Uint,
    migrationTag: MigrationTag,
    journalTimestamp: Uint,
    sourceCommit: HexCommit,
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

export function computeEvidenceManifestHash(manifest: LegacyEvidenceManifest): string {
  return hashCanonicalString(LEGACY_EVIDENCE_DOMAIN + canonicalizeV1(manifest), 1);
}

// -- Attestation (signed) -----------------------------------------------------

export const signedAttestationSchema = z
  .object({
    attestationVersion: z.literal(LEGACY_ATTESTATION_VERSION),
    attestationId: Ident,
    migrationIndex: Uint,
    migrationTag: MigrationTag,
    journalTimestamp: Uint,
    sourceCommit: HexCommit,
    sourceBlobHash: Sha256Hex,
    appliedExecutionHash: Sha256Hex,
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
    approvedTreatment: z.enum(LEGACY_TREATMENTS),
    approvedAt: IsoTimestamp,
    approverRole: LowerToken,
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

export function attestationSigningBytes(signed: SignedLegacyAttestation): Buffer {
  return Buffer.from(LEGACY_SIGN_DOMAIN + canonicalizeV1(signed), 'utf8');
}

/** PRODUCER/TEST ONLY (ephemeral keys). Sign a signed-payload → a full attestation. */
export function signLegacyAttestation(signed: SignedLegacyAttestation, privateKey: KeyObject): LegacyMigrationAttestation {
  if (signed.signatureAlgorithm !== 'ed25519') throw new Error('only ed25519 is supported');
  const sig = cryptoSign(null, attestationSigningBytes(signed), privateKey);
  return { ...signed, signature: sig.toString('base64url') };
}

// -- Trusted key registry + verification --------------------------------------

export interface LegacyTrustStore {
  /** keyId → Ed25519 public key. Empty in production until an owner key is onboarded via separate authorization. */
  readonly keyring: Readonly<Record<string, KeyObject>>;
  /** Explicitly revoked key ids. */
  readonly revoked: ReadonlySet<string>;
}

export type AttestationVerifyResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface AttestationExpectation {
  readonly migrationIndex: number;
  readonly migrationTag: string;
  readonly journalTimestamp: number;
  readonly sourceCommit: string;
  readonly sourceBlobHash: string;
  /** The hash actually stored in `drizzle.__drizzle_migrations` for this migration. */
  readonly appliedHash: string;
  readonly supportedVersions: ReadonlySet<string>;
  readonly supportedAlgorithms: ReadonlySet<string>;
  /** When supplied, the verifier recomputes its hash and requires it to equal `evidenceManifestHash`. */
  readonly evidenceManifest?: LegacyEvidenceManifest;
}

/**
 * Full verification: schema → version/algorithm → key trust + not revoked → signature → exact scope bindings
 * (index/tag/timestamp/commit/sourceBlob/appliedHash) → evidence-manifest hash (recomputed) → treatment →
 * byte-difference-claim consistency → safety gates (context outside sensitive content; db effects agree).
 * Returns the FIRST failing reason. Never matches by tag or hash alone; no wildcard/range/prefix.
 */
export function verifyLegacyAttestation(input: unknown, exp: AttestationExpectation, store: LegacyTrustStore): AttestationVerifyResult {
  const parsed = legacyAttestationSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: `schema: ${parsed.error.issues[0]?.message ?? 'invalid'}` };
  const a: LegacyMigrationAttestation = parsed.data;

  if (!exp.supportedVersions.has(a.attestationVersion)) return { ok: false, reason: `unsupported attestationVersion ${a.attestationVersion}` };
  if (!exp.supportedAlgorithms.has(a.signatureAlgorithm)) return { ok: false, reason: `unsupported signatureAlgorithm ${a.signatureAlgorithm}` };

  if (store.revoked.has(a.keyId)) return { ok: false, reason: `revoked keyId ${a.keyId}` };
  const key = store.keyring[a.keyId];
  if (!key) return { ok: false, reason: `unknown keyId ${a.keyId}` };

  const signed = toSignedAttestationPayload(a);
  let sigOk = false;
  try {
    sigOk = cryptoVerify(null, attestationSigningBytes(signed), key, Buffer.from(a.signature, 'base64url'));
  } catch {
    sigOk = false;
  }
  if (!sigOk) return { ok: false, reason: 'invalid signature' };

  // Exact scope — never by tag or hash alone.
  if (a.migrationIndex !== exp.migrationIndex) return { ok: false, reason: 'migrationIndex mismatch' };
  if (a.migrationTag !== exp.migrationTag) return { ok: false, reason: 'migrationTag mismatch' };
  if (a.journalTimestamp !== exp.journalTimestamp) return { ok: false, reason: 'journalTimestamp mismatch' };
  if (a.sourceCommit !== exp.sourceCommit) return { ok: false, reason: 'sourceCommit mismatch' };
  if (a.sourceBlobHash !== exp.sourceBlobHash) return { ok: false, reason: 'sourceBlobHash mismatch' };
  if (a.appliedExecutionHash !== exp.appliedHash) return { ok: false, reason: 'appliedHash mismatch' };

  if (exp.evidenceManifest) {
    const recomputed = computeEvidenceManifestHash(exp.evidenceManifest);
    if (recomputed !== a.evidenceManifestHash) return { ok: false, reason: 'evidenceManifestHash mismatch (manifest modified)' };
  }

  if (!LEGACY_TREATMENTS.includes(a.approvedTreatment)) return { ok: false, reason: 'unsupported treatment' };
  if (a.approverRole.trim().length === 0) return { ok: false, reason: 'missing owner approval metadata' };

  // Byte-difference-claim consistency (EOL-only proof).
  if (a.differenceType !== 'eol_only') return { ok: false, reason: 'unsupported differenceType' };
  if (a.deletedByteCount !== 0 || a.substitutedByteCount !== 0) return { ok: false, reason: 'invalid byte-difference claim (deleted/substituted must be 0 for eol_only)' };
  if (a.insertedByteCount !== a.insertedCrBeforeLfCount) return { ok: false, reason: 'invalid byte-difference claim (inserted bytes must all be CR-before-LF)' };
  if (a.appliedByteLength !== a.sourceByteLength + a.insertedByteCount) return { ok: false, reason: 'invalid byte-difference claim (lengths inconsistent)' };
  if (a.changedLineIndexes.length !== a.insertedCrBeforeLfCount) return { ok: false, reason: 'invalid byte-difference claim (changed-line count mismatch)' };

  // Safety gates.
  if (a.sqlContextAssessment !== 'outside_sensitive_content') return { ok: false, reason: 'sqlContextAssessment is not outside_sensitive_content' };
  if (a.databaseEffectAssessment !== 'local_staging_agree') return { ok: false, reason: 'databaseEffectAssessment is not local_staging_agree' };

  return { ok: true };
}
