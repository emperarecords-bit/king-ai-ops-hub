import { createHash, verify as cryptoVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
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

/**
 * G-Backup-A Phase-10 ACTIVE bundle loader. Assembles the trusted, source-controlled legacy-attestation material
 * that the read-only detector consumes. It is deliberately SEPARATE from the runtime verifier and NEVER imports
 * the signer (a static import-boundary test enforces that). It is NOT wired into `scripts/migrate.ts` by this
 * increment.
 *
 * Trust boundary:
 *   - Reads ONLY the explicit files named in `active-index.json` (an explicit filename list, not a directory
 *     scan). It refuses any path under `legacy-drafts/` — drafts are non-authoritative and are never trusted.
 *   - Validates every file through the committed Zod schemas.
 *   - Builds the key store via `loadTrustBundle` (fail-closed dup/conflict/purpose/algorithm checks) BEFORE any
 *     lookup, and validates the attestation set via `validateAttestationBundle` (dup id/digest + env-overlap).
 *   - Per attestation: rejects `production` scope, recomputes the derived `attestationId`, recomputes the linked
 *     evidence-manifest hash, and verifies the Ed25519 signature against the trusted public key.
 *   - Independently recomputes each trusted key's DER-SPKI SHA-256 fingerprint (operational metadata).
 */

export const LEGACY_ACTIVE_BASE = join('scripts', 'backup');
export const ACTIVE_INDEX_FILE = join('legacy-attestations', 'active-index.json');
/** Draft location that this loader must never treat as authoritative. */
export const LEGACY_DRAFTS_SEGMENT = 'legacy-drafts';

export class ActiveBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActiveBundleError';
  }
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
      .array(z.object({ tag: z.string().min(1), attestationFile: z.string().min(1), evidenceFile: z.string().min(1) }).strict())
      .min(1),
  })
  .strict();

export interface ActiveLegacyBundle {
  readonly store: LegacyTrustStore;
  readonly attestations: LegacyMigrationAttestation[];
  /** raw parsed attestation objects, for handing to the detector's `attestations: unknown[]`. */
  readonly rawAttestations: unknown[];
  readonly evidenceManifests: Record<string, LegacyEvidenceManifest>;
  readonly activeTags: string[];
  /** keyId -> lowercase DER-SPKI SHA-256 fingerprint (independently recomputed). */
  readonly keyFingerprints: Record<string, string>;
  /** per-tag canonical-signing-bytes facts, for verification reporting. */
  readonly signingFacts: Record<string, { byteLength: number; sha256: string; attestationId: string }>;
}

/** True if `rel` points anywhere under the non-authoritative drafts location. */
export function isNonAuthoritativeDraftPath(rel: string): boolean {
  return rel.split(/[\\/]/).includes(LEGACY_DRAFTS_SEGMENT);
}

function assertNotDraft(rel: string): void {
  if (isNonAuthoritativeDraftPath(rel)) {
    throw new ActiveBundleError(`refusing to load an authoritative file from the non-authoritative drafts location: ${rel}`);
  }
}

function readJson(base: string, rel: string): unknown {
  assertNotDraft(rel);
  return JSON.parse(readFileSync(join(base, rel), 'utf8'));
}

/**
 * Load + fully validate the active legacy-attestation bundle. Throws {@link ActiveBundleError} (fail-closed) on any
 * schema, trust, signature, scope, or linkage problem. Pure read-only: no DB, no network, no writes.
 */
export function loadActiveLegacyBundle(repoRoot: string = process.cwd()): ActiveLegacyBundle {
  const base = join(repoRoot, LEGACY_ACTIVE_BASE);
  const index = activeIndexSchema.parse(readJson(base, ACTIVE_INDEX_FILE));
  assertNotDraft(index.keyBundleFile);

  const keyBundle = keyBundleFileSchema.parse(readJson(base, index.keyBundleFile));
  const loaded = loadTrustBundle(keyBundle.keys);
  if (!loaded.ok) throw new ActiveBundleError(`trust bundle rejected: ${loaded.reason}`);
  const store = loaded.store;

  const rawAttestations: unknown[] = [];
  const attestations: LegacyMigrationAttestation[] = [];
  const evidenceManifests: Record<string, LegacyEvidenceManifest> = {};
  const activeTags: string[] = [];
  const signingFacts: ActiveLegacyBundle['signingFacts'] = {};
  const seenTags = new Set<string>();

  for (const entry of index.entries) {
    assertNotDraft(entry.attestationFile);
    assertNotDraft(entry.evidenceFile);
    if (seenTags.has(entry.tag)) throw new ActiveBundleError(`duplicate active tag ${entry.tag}`);
    seenTags.add(entry.tag);

    const rawAtt = readJson(base, entry.attestationFile);
    const att = legacyAttestationSchema.parse(rawAtt);
    if (att.migrationTag !== entry.tag) throw new ActiveBundleError(`attestation migrationTag ${att.migrationTag} != index tag ${entry.tag}`);
    if (att.allowedEnvironments.includes('production' as LegacyEnvironment)) {
      throw new ActiveBundleError(`attestation ${entry.tag} authorizes production, which is excluded by policy`);
    }

    // Derived id must equal the content digest.
    const signed = toSignedAttestationPayload(att);
    const derivedId = deriveAttestationId(signed);
    if (derivedId !== att.attestationId) throw new ActiveBundleError(`attestation ${entry.tag} attestationId does not match its content digest`);

    // Signature must verify against the trusted (active) key.
    const trusted = store.keyring.get(att.keyId);
    if (!trusted) throw new ActiveBundleError(`attestation ${entry.tag} keyId ${att.keyId} is not an active trusted key`);
    const signingBytes = attestationSigningBytes(signed);
    let sigOk = false;
    try {
      sigOk = cryptoVerify(null, signingBytes, trusted.publicKey, Buffer.from(att.signature, 'base64url'));
    } catch {
      sigOk = false;
    }
    if (!sigOk) throw new ActiveBundleError(`attestation ${entry.tag} signature does not verify against key ${att.keyId}`);

    // Evidence manifest must be the linked one and hash to the attested value.
    const rawEv = readJson(base, entry.evidenceFile);
    const ev = evidenceManifestSchema.parse(rawEv);
    if (computeEvidenceManifestHash(ev) !== att.evidenceManifestHash) {
      throw new ActiveBundleError(`attestation ${entry.tag} evidenceManifestHash does not match the linked evidence file`);
    }

    rawAttestations.push(rawAtt);
    attestations.push(att);
    evidenceManifests[entry.tag] = ev;
    activeTags.push(entry.tag);
    signingFacts[entry.tag] = {
      byteLength: signingBytes.length,
      sha256: createHash('sha256').update(signingBytes).digest('hex'),
      attestationId: att.attestationId,
    };
  }

  // Bundle-level duplicate / environment-overlap validation across the whole active set.
  const bundleValid = validateAttestationBundle(rawAttestations);
  if (!bundleValid.ok) throw new ActiveBundleError(`attestation bundle rejected: ${bundleValid.reason}`);

  const keyFingerprints: Record<string, string> = {};
  for (const [keyId, tk] of store.keyring) {
    const der = tk.publicKey.export({ type: 'spki', format: 'der' });
    keyFingerprints[keyId] = createHash('sha256').update(der).digest('hex');
  }

  return { store, attestations, rawAttestations, evidenceManifests, activeTags, keyFingerprints, signingFacts };
}
