import { createHash, verify as cryptoVerify } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { z } from 'zod';
import { canonicalizeV1, normalizeRepoPath } from '@/lib/canonical';
import {
  type LegacyEnvironment,
  type LegacyEvidenceManifest,
  type LegacyMigrationAttestation,
  evidenceManifestSchema,
  legacyAttestationSchema,
  toSignedAttestationPayload,
} from './legacy-attestation-schema';
import { type LegacyTrustStore, loadTrustBundle, validateAttestationBundle } from './legacy-attestation-verify';
import { attestationSigningBytes, computeEvidenceManifestHash, deriveAttestationId } from './legacy-attestation-canonical';
import { parseStrictJsonBuffer } from './strict-json';

/**
 * G-Backup-A Phase-10 ACTIVE bundle loader (hardened). Assembles the trusted, source-controlled legacy-attestation
 * material the read-only detector consumes. SEPARATE from the runtime verifier; NEVER imports the signer; NOT
 * wired into `scripts/migrate.ts`.
 *
 * Hardening:
 *   - Every path from the active index is treated as untrusted config: validated as a normalized repo-relative
 *     POSIX path of safe characters, confined to its exact expected root, then realpath-checked with a symlink
 *     scan on every path component (rejecting link-based escapes / junctions / reparse points) and a regular-file
 *     requirement.
 *   - All active governance JSON is parsed with a strict duplicate-key-rejecting parser (see strict-json.ts) that
 *     also rejects a BOM, invalid UTF-8, comments, trailing data, multiple top-level values, and non-finite numbers.
 *   - The index binds keyId / attestationId / migrationIndex / migrationTag / evidence hash / key fingerprint /
 *     environments / production flag; the loader cross-checks every bound value and fails closed on mismatch.
 *   - Ambiguity policy (fail-closed): any UNREFERENCED governance JSON in an active root is rejected; README and
 *     other non-JSON files are ignored.
 *   - Production is authorized ONLY when BOTH the index entry's `productionAuthorized` is true AND the signed
 *     attestation scope includes `production` (never a hidden global). The current 0004 entry sets it false and
 *     the signed scope excludes production, so production is rejected.
 */

export const LEGACY_ACTIVE_BASE = join('scripts', 'backup');
export const ROOT_TRUST = 'legacy-trust';
export const ROOT_ATTESTATIONS = 'legacy-attestations';
export const ROOT_EVIDENCE = 'legacy-evidence';
export const ACTIVE_INDEX_REL = `${ROOT_ATTESTATIONS}/active-index.json`;
/** Draft location that this loader must never treat as authoritative. */
export const LEGACY_DRAFTS_SEGMENT = 'legacy-drafts';

export class ActiveBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActiveBundleError';
  }
}

/** True if `rel` points anywhere under the non-authoritative drafts location. */
export function isNonAuthoritativeDraftPath(rel: string): boolean {
  return rel.split(/[\\/]/).includes(LEGACY_DRAFTS_SEGMENT);
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Validate an untrusted repo-relative POSIX path from the index and confine it to `expectedRoot`. Rejects absolute
 * / drive / UNC / scheme / backslash / percent-encoded / `.`/`..` / empty-segment / repeated-separator / control-
 * char / draft / case-variant-root inputs. Returns the normalized path (pure; no filesystem access).
 */
export function validateActiveRelPath(rel: unknown, expectedRoot: string): string {
  if (typeof rel !== 'string' || rel.length === 0) throw new ActiveBundleError('path must be a non-empty string');
  if ([...rel].some((ch) => ch.charCodeAt(0) <= 0x1f || ch.charCodeAt(0) === 0x7f)) throw new ActiveBundleError("control/NUL character in path");
  if (rel.includes('\\')) throw new ActiveBundleError('backslash not allowed in a repo-relative POSIX path');
  if (rel.includes('%')) throw new ActiveBundleError('percent-encoding not allowed');
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(rel)) throw new ActiveBundleError('URL scheme or drive-letter path not allowed');
  if (rel.startsWith('/')) throw new ActiveBundleError('absolute / UNC path not allowed');
  const segments = rel.split('/');
  for (const s of segments) {
    if (s.length === 0) throw new ActiveBundleError('empty path segment (leading/trailing/repeated separator)');
    if (s === '.' || s === '..') throw new ActiveBundleError('"." or ".." path segment not allowed');
    if (!SAFE_SEGMENT.test(s)) throw new ActiveBundleError(`unsafe character in path segment ${JSON.stringify(s)}`);
  }
  // Defense in depth: the committed normalizer must agree and must not have changed the path.
  const norm = normalizeRepoPath(rel);
  if (norm !== rel) throw new ActiveBundleError('path is not already normalized');
  if (isNonAuthoritativeDraftPath(norm)) throw new ActiveBundleError('path under legacy-drafts is not allowed');
  if (norm.split('/')[0] !== expectedRoot) throw new ActiveBundleError(`path root must be exactly "${expectedRoot}" (case-sensitive)`);
  if (!norm.startsWith(`${expectedRoot}/`) || norm.length <= expectedRoot.length + 1) {
    throw new ActiveBundleError(`path must be a file under "${expectedRoot}/"`);
  }
  return norm;
}

/** Resolve a validated path on disk: no symlink in ANY component, a regular file at the end, contained by root. */
function assertRealRegularFileUnder(baseAbs: string, expectedRoot: string, norm: string): string {
  const parts = norm.split('/');
  let cur = baseAbs;
  for (let k = 0; k < parts.length; k++) {
    cur = join(cur, parts[k]!);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      throw new ActiveBundleError(`active path does not exist: ${parts.slice(0, k + 1).join('/')}`);
    }
    if (st.isSymbolicLink()) throw new ActiveBundleError(`symlink in active path component not allowed: ${parts.slice(0, k + 1).join('/')}`);
    const isLast = k === parts.length - 1;
    if (isLast) {
      if (!st.isFile()) throw new ActiveBundleError(`active path is not a regular file: ${norm}`);
    } else if (!st.isDirectory()) {
      throw new ActiveBundleError(`non-directory in active path: ${parts.slice(0, k + 1).join('/')}`);
    }
  }
  // Real-path containment catches junctions / reparse points that lstat may not flag as symlinks.
  const realRoot = realpathSync(join(baseAbs, expectedRoot));
  const realFile = realpathSync(join(baseAbs, ...parts));
  if (realFile !== realRoot && !realFile.startsWith(realRoot + sep)) {
    throw new ActiveBundleError(`resolved active path escapes "${expectedRoot}/"`);
  }
  return join(baseAbs, ...parts);
}

const keyBundleFileSchema = z
  .object({ bundleVersion: z.literal('1'), note: z.string().optional(), keys: z.array(z.unknown()).min(1) })
  .strict();

const activeIndexSchema = z
  .object({
    bundleVersion: z.literal('1'),
    note: z.string().optional(),
    keyBundleFile: z.string().min(1),
    entries: z
      .array(
        z
          .object({
            tag: z.string().min(1),
            keyId: z.string().min(1),
            attestationId: z.string().regex(/^lma1_[0-9a-f]{64}$/),
            migrationIndex: z.number().int().nonnegative(),
            migrationTag: z.string().min(1),
            attestationFile: z.string().min(1),
            evidenceFile: z.string().min(1),
            expectedEvidenceManifestHash: z.string().regex(/^[0-9a-f]{64}$/),
            expectedPublicKeyFingerprintSha256: z.string().regex(/^[0-9a-f]{64}$/),
            allowedEnvironments: z.array(z.enum(['development', 'staging', 'production'])).min(1).max(3),
            productionAuthorized: z.boolean(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

/** Deterministic semantic digest of the active index over its BINDING metadata (note excluded). */
export function computeActiveIndexSemanticDigest(index: { bundleVersion: string; keyBundleFile: string; entries: unknown[]; note?: string }): string {
  return createHash('sha256')
    .update('gbackup-active-index/v1\n', 'utf8')
    .update(canonicalizeV1({ bundleVersion: index.bundleVersion, keyBundleFile: index.keyBundleFile, entries: index.entries }), 'utf8')
    .digest('hex');
}

export interface ActiveFileDiagnostic {
  readonly path: string;
  readonly rawByteLength: number;
  readonly rawSha256: string;
  readonly schema: string;
  readonly semanticDigest?: string;
}
export interface ActiveLegacyBundle {
  readonly store: LegacyTrustStore;
  readonly attestations: LegacyMigrationAttestation[];
  readonly rawAttestations: unknown[];
  readonly evidenceManifests: Record<string, LegacyEvidenceManifest>;
  readonly activeTags: string[];
  readonly keyFingerprints: Record<string, string>;
  readonly signingFacts: Record<string, { byteLength: number; sha256: string; attestationId: string; signatureVerified: boolean }>;
  readonly diagnostics: {
    readonly files: ActiveFileDiagnostic[];
    readonly keys: Record<string, { derSpkiByteLength: number; fingerprintSha256: string }>;
  };
}

function readGovernanceFile(baseAbs: string, expectedRoot: string, rel: unknown): { abs: string; buf: Buffer; value: unknown; norm: string } {
  const norm = validateActiveRelPath(rel, expectedRoot);
  const abs = assertRealRegularFileUnder(baseAbs, expectedRoot, norm);
  const buf = readFileSync(abs);
  const value = parseStrictJsonBuffer(buf);
  return { abs, buf, value, norm };
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Exact non-governance filenames permitted (documentation only) in an active root. */
const ALLOWED_DOC_FILES = new Set<string>(['README.md']);

/**
 * Fail-closed directory policy: an active root may contain ONLY explicitly-referenced governance files plus an
 * exact documentation allowlist. Every other entry — a `.json.bak`/`.json.old`, a hidden or swap file, an
 * alternate extension, a shadow PEM, an unindexed text/YAML file, or ANY subdirectory — is rejected.
 */
function assertActiveDirClean(baseAbs: string, root: string, referencedBasenames: Set<string>): void {
  const dir = join(baseAbs, root);
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const name = dirent.name;
    if (referencedBasenames.has(name)) {
      if (!dirent.isFile()) throw new ActiveBundleError(`indexed active entry ${root}/${name} is not a regular file`);
      continue;
    }
    if (dirent.isFile() && ALLOWED_DOC_FILES.has(name)) continue;
    throw new ActiveBundleError(`disallowed entry in ${root}/: ${name} (only indexed governance files and ${[...ALLOWED_DOC_FILES].join(', ')} are permitted)`);
  }
}

/**
 * Load + fully validate the active legacy-attestation bundle. Throws {@link ActiveBundleError} (fail-closed) on any
 * path, JSON, schema, trust, signature, scope, binding, or ambiguity problem. Read-only: no DB, no network, no writes.
 */
export function loadActiveLegacyBundle(repoRoot: string = process.cwd()): ActiveLegacyBundle {
  const baseAbs = join(repoRoot, LEGACY_ACTIVE_BASE);
  const files: ActiveFileDiagnostic[] = [];

  // 1. Active index (validated path + strict parse + schema). The version is `bundleVersion` (z.literal('1') —
  // a missing/unsupported version is rejected by the schema). Its canonical semantic digest is over the binding
  // metadata (note excluded), so it changes iff a bound value changes.
  const idxRead = readGovernanceFile(baseAbs, ROOT_ATTESTATIONS, ACTIVE_INDEX_REL);
  const index = activeIndexSchema.parse(idxRead.value);
  const indexSemanticDigest = computeActiveIndexSemanticDigest(index);
  files.push({ path: `scripts/backup/${idxRead.norm}`, rawByteLength: idxRead.buf.length, rawSha256: sha256(idxRead.buf), schema: `active-index/${index.bundleVersion}`, semanticDigest: indexSemanticDigest });

  // 2. Trust bundle (confined to legacy-trust).
  const kbRead = readGovernanceFile(baseAbs, ROOT_TRUST, index.keyBundleFile);
  const keyBundle = keyBundleFileSchema.parse(kbRead.value);
  const loaded = loadTrustBundle(keyBundle.keys);
  if (!loaded.ok) throw new ActiveBundleError(`trust bundle rejected: ${loaded.reason}`);
  const store = loaded.store;
  files.push({ path: `scripts/backup/${kbRead.norm}`, rawByteLength: kbRead.buf.length, rawSha256: sha256(kbRead.buf), schema: `legacy-trust-bundle/${keyBundle.bundleVersion}` });

  const keyDiag: Record<string, { derSpkiByteLength: number; fingerprintSha256: string }> = {};
  const keyFingerprints: Record<string, string> = {};
  for (const [keyId, tk] of store.keyring) {
    const der = tk.publicKey.export({ type: 'spki', format: 'der' });
    const fp = createHash('sha256').update(der).digest('hex');
    keyFingerprints[keyId] = fp;
    keyDiag[keyId] = { derSpkiByteLength: der.length, fingerprintSha256: fp };
  }

  const rawAttestations: unknown[] = [];
  const attestations: LegacyMigrationAttestation[] = [];
  const evidenceManifests: Record<string, LegacyEvidenceManifest> = {};
  const activeTags: string[] = [];
  const signingFacts: ActiveLegacyBundle['signingFacts'] = {};
  const seenTags = new Set<string>();
  const seenAttestationIds = new Set<string>();
  const referencedAttestationFiles = new Set<string>([basename(ACTIVE_INDEX_REL)]);
  const referencedEvidenceFiles = new Set<string>();
  const referencedTrustFiles = new Set<string>([basename(index.keyBundleFile)]);
  const referencedKeyIds = new Set<string>(index.entries.map((e) => e.keyId));

  for (const entry of index.entries) {
    if (seenTags.has(entry.tag)) throw new ActiveBundleError(`duplicate active tag ${entry.tag}`);
    seenTags.add(entry.tag);
    if (seenAttestationIds.has(entry.attestationId)) throw new ActiveBundleError(`duplicate attestationId ${entry.attestationId} across entries`);
    seenAttestationIds.add(entry.attestationId);

    // Path confinement to the correct roots.
    const attRead = readGovernanceFile(baseAbs, ROOT_ATTESTATIONS, entry.attestationFile);
    const evRead = readGovernanceFile(baseAbs, ROOT_EVIDENCE, entry.evidenceFile);
    const attBase = basename(attRead.norm);
    const evBase = basename(evRead.norm);
    if (referencedAttestationFiles.has(attBase)) throw new ActiveBundleError(`attestation file referenced by more than one entry: ${attBase}`);
    if (referencedEvidenceFiles.has(evBase)) throw new ActiveBundleError(`evidence file referenced by more than one entry: ${evBase}`);
    referencedAttestationFiles.add(attBase);
    referencedEvidenceFiles.add(evBase);

    const att = legacyAttestationSchema.parse(attRead.value);
    const ev = evidenceManifestSchema.parse(evRead.value);

    // --- Bind everything the index declares to the parsed files (fail closed on any mismatch). ---
    if (att.migrationTag !== entry.tag) throw new ActiveBundleError(`attestation migrationTag ${att.migrationTag} != index tag ${entry.tag}`);
    if (entry.migrationTag !== entry.tag) throw new ActiveBundleError(`index migrationTag ${entry.migrationTag} != tag ${entry.tag}`);
    if (att.migrationIndex !== entry.migrationIndex) throw new ActiveBundleError(`attestation migrationIndex ${att.migrationIndex} != index ${entry.migrationIndex}`);
    if (att.keyId !== entry.keyId) throw new ActiveBundleError(`attestation keyId ${att.keyId} != index keyId ${entry.keyId}`);
    if (att.attestationId !== entry.attestationId) throw new ActiveBundleError(`attestation id != index attestationId`);
    if (deriveAttestationId(toSignedAttestationPayload(att)) !== att.attestationId) throw new ActiveBundleError(`attestation id != derived content digest`);
    if (att.evidenceManifestHash !== entry.expectedEvidenceManifestHash) throw new ActiveBundleError(`attestation evidenceManifestHash != index expected`);
    if (computeEvidenceManifestHash(ev) !== entry.expectedEvidenceManifestHash) throw new ActiveBundleError(`evidence file hash != index expected`);
    if (JSON.stringify([...att.allowedEnvironments]) !== JSON.stringify([...entry.allowedEnvironments])) {
      throw new ActiveBundleError(`attestation allowedEnvironments != index allowedEnvironments`);
    }

    // Production policy: authorized ONLY if the index entry says so AND the signed scope includes production.
    const prodInScope = att.allowedEnvironments.includes('production' as LegacyEnvironment);
    if (entry.productionAuthorized !== prodInScope) {
      throw new ActiveBundleError(`production authorization mismatch for ${entry.tag}: index=${entry.productionAuthorized}, signedScopeIncludesProduction=${prodInScope}`);
    }
    if (prodInScope) throw new ActiveBundleError(`production authorization is not permitted by this increment (${entry.tag})`);

    // Key must be active + fingerprint must match the index-declared fingerprint.
    const trusted = store.keyring.get(att.keyId);
    if (!trusted) throw new ActiveBundleError(`keyId ${att.keyId} is not an active trusted key`);
    if (keyFingerprints[att.keyId] !== entry.expectedPublicKeyFingerprintSha256) {
      throw new ActiveBundleError(`trusted key fingerprint != index expectedPublicKeyFingerprintSha256`);
    }

    // Signature verification over the exact canonical bytes.
    const signed = toSignedAttestationPayload(att);
    const signingBytes = attestationSigningBytes(signed);
    let sigOk = false;
    try {
      sigOk = cryptoVerify(null, signingBytes, trusted.publicKey, Buffer.from(att.signature, 'base64url'));
    } catch {
      sigOk = false;
    }
    if (!sigOk) throw new ActiveBundleError(`attestation ${entry.tag} signature does not verify`);

    rawAttestations.push(attRead.value);
    attestations.push(att);
    evidenceManifests[entry.tag] = ev;
    activeTags.push(entry.tag);
    signingFacts[entry.tag] = { byteLength: signingBytes.length, sha256: sha256(signingBytes), attestationId: att.attestationId, signatureVerified: sigOk };
    files.push({ path: `scripts/backup/${attRead.norm}`, rawByteLength: attRead.buf.length, rawSha256: sha256(attRead.buf), schema: `legacy-attestation/${att.attestationVersion}`, semanticDigest: att.attestationId });
    files.push({ path: `scripts/backup/${evRead.norm}`, rawByteLength: evRead.buf.length, rawSha256: sha256(evRead.buf), schema: `legacy-evidence/${ev.manifestVersion}`, semanticDigest: computeEvidenceManifestHash(ev) });
  }

  // Bundle-level duplicate id/digest + environment-overlap validation.
  const bundleValid = validateAttestationBundle(rawAttestations);
  if (!bundleValid.ok) throw new ActiveBundleError(`attestation bundle rejected: ${bundleValid.reason}`);

  // Every trusted key (active OR revoked) must be referenced by an active index entry. An unreferenced active,
  // revoked, replacement, receipt-purpose (rejected earlier by loadTrustBundle), or same-material-different-id key
  // fails closed — "the extra key is unused" is not a safety argument.
  for (const keyId of store.keyring.keys()) {
    if (!referencedKeyIds.has(keyId)) throw new ActiveBundleError(`trust bundle contains an UNREFERENCED active key: ${keyId}`);
  }
  for (const keyId of store.revoked) {
    if (!referencedKeyIds.has(keyId)) throw new ActiveBundleError(`trust bundle contains an UNREFERENCED revoked key: ${keyId}`);
  }

  // Ambiguity policy: only indexed governance files + an exact doc allowlist may exist in each active root.
  assertActiveDirClean(baseAbs, ROOT_TRUST, referencedTrustFiles);
  assertActiveDirClean(baseAbs, ROOT_ATTESTATIONS, referencedAttestationFiles);
  assertActiveDirClean(baseAbs, ROOT_EVIDENCE, referencedEvidenceFiles);

  return { store, attestations, rawAttestations, evidenceManifests, activeTags, keyFingerprints, signingFacts, diagnostics: { files, keys: keyDiag } };
}

/** POSIX basename of a validated relative path (no OS-specific separators expected). */
function basename(rel: string): string {
  const parts = rel.split('/');
  return parts[parts.length - 1]!;
}
