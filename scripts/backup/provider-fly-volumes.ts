import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalizeV1 } from '@/lib/canonical';

/**
 * G-Backup-B1 — `fly-volumes` provider adapter (pure; no Fly access).
 *
 * Normalizes a raw Fly volume-snapshot record into an explicitly-selected, stable evidence object and computes a
 * domain-separated `providerEvidenceCanonicalDigest` over it. Only exact provider status `created` normalizes to
 * canonical `complete`; every other status is rejected. Both the raw and canonical status are preserved so the
 * signed receipt never discards provider evidence. Unstable CLI formatting / property ordering is never trust-
 * critical: the digest is over the normalized fields via `canonicalizeV1`, not the raw response text.
 */

export const PROVIDER_EVIDENCE_DOMAIN = 'gbackup-provider-evidence/v1\n' as const;
export const FLY_VOLUMES_PROVIDER = 'fly-volumes' as const;
export const FLY_VOLUMES_ADAPTER_VERSION = 'fly-volumes.v1' as const;
export const PROVIDER_RAW_STATUS_CREATED = 'created' as const;
export const CANONICAL_SNAPSHOT_COMPLETE = 'complete' as const;

export class ProviderEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderEvidenceError';
  }
}

const Ident = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/);
const VolumeId = z.string().min(3).max(64).regex(/^vol_[A-Za-z0-9]+$/);
const SnapshotId = z.string().min(3).max(64).regex(/^vs_[A-Za-z0-9]+$/);
const LowerToken = z.string().min(1).max(32).regex(/^[a-z_]+$/);
const IsoUtc = z
  .string()
  .max(40)
  .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$/, 'must be normalized UTC (…Z)')
  .refine((s) => !Number.isNaN(Date.parse(s)), 'invalid timestamp');
const Uint = z.number().int().nonnegative();

/** A raw provider snapshot record (as an adapter would receive it from `fly volume snapshots list --json`). */
export const rawFlyVolumeSnapshotSchema = z
  .object({
    id: SnapshotId,
    status: LowerToken,
    volumeId: VolumeId,
    databaseApp: Ident,
    createdAt: IsoUtc,
    retentionDays: Uint,
    storedSizeBytes: Uint.optional(),
  })
  .strict();
export type RawFlyVolumeSnapshot = z.infer<typeof rawFlyVolumeSnapshotSchema>;

/** The normalized, explicitly-selected evidence fields the digest is computed over. */
export interface NormalizedProviderEvidence {
  readonly snapshotProvider: string;
  readonly providerAdapterVersion: string;
  readonly snapshotId: string;
  readonly sourceVolumeId: string;
  readonly databaseApp: string;
  readonly providerSnapshotStatus: string;
  readonly canonicalSnapshotStatus: string;
  readonly snapshotCreatedAt: string;
  readonly providerObservedAt: string;
  readonly retentionDays: number;
  readonly storedSizeBytes: number | null;
}

export interface ProviderEvidenceResult {
  readonly evidence: NormalizedProviderEvidence;
  readonly providerEvidenceCanonicalDigest: string;
}

/** Domain-separated digest over the canonical normalized evidence (never over raw CLI text). */
export function computeProviderEvidenceDigest(evidence: NormalizedProviderEvidence): string {
  return createHash('sha256')
    .update(PROVIDER_EVIDENCE_DOMAIN, 'utf8')
    .update(canonicalizeV1(evidence), 'utf8')
    .digest('hex');
}

/**
 * Normalize a raw fly-volumes snapshot record observed at `providerObservedAt`. Rejects any status other than the
 * exact `created`, an observation before the snapshot was created, or a future observation. `providerObservedAt`
 * is supplied (the controller's observation instant) rather than read from a clock so this stays pure/testable.
 */
export function normalizeFlyVolumeSnapshot(raw: unknown, providerObservedAt: string): ProviderEvidenceResult {
  const parsed = rawFlyVolumeSnapshotSchema.safeParse(raw);
  if (!parsed.success) throw new ProviderEvidenceError(`raw snapshot schema invalid: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  const s = parsed.data;
  if (s.status !== PROVIDER_RAW_STATUS_CREATED) {
    throw new ProviderEvidenceError(`provider status ${JSON.stringify(s.status)} is not the accepted terminal status '${PROVIDER_RAW_STATUS_CREATED}'`);
  }
  const obs = IsoUtc.safeParse(providerObservedAt);
  if (!obs.success) throw new ProviderEvidenceError('providerObservedAt is not a normalized UTC timestamp');
  if (Date.parse(providerObservedAt) < Date.parse(s.createdAt)) {
    throw new ProviderEvidenceError('providerObservedAt precedes snapshot createdAt (observation before creation)');
  }
  const evidence: NormalizedProviderEvidence = {
    snapshotProvider: FLY_VOLUMES_PROVIDER,
    providerAdapterVersion: FLY_VOLUMES_ADAPTER_VERSION,
    snapshotId: s.id,
    sourceVolumeId: s.volumeId,
    databaseApp: s.databaseApp,
    providerSnapshotStatus: s.status,
    canonicalSnapshotStatus: CANONICAL_SNAPSHOT_COMPLETE,
    snapshotCreatedAt: s.createdAt,
    providerObservedAt,
    retentionDays: s.retentionDays,
    storedSizeBytes: s.storedSizeBytes ?? null,
  };
  return { evidence, providerEvidenceCanonicalDigest: computeProviderEvidenceDigest(evidence) };
}
