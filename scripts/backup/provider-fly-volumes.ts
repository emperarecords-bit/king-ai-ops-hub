import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalizeV1 } from '@/lib/canonical';
import { isCanonicalUtcTimestamp } from './receipt-v2-encoding';

/**
 * G-Backup-B1 — `fly-volumes` provider adapter (pure; no Fly access; synthetic data only).
 *
 * `normalizedProviderEvidenceDigest` proves the INTEGRITY + IDENTITY of the selected normalized provider fields
 * under the Ed25519 receipt signature. It does NOT independently prove that Fly returned those values — the
 * external controller establishes that by querying Fly; the runtime verifies the digest recomputes from the signed
 * fields and the signature is valid. An optional `rawProviderResponseSha256` is audit-only and never enters the
 * trust decision.
 *
 * Snapshot discovery is explicit (`create-response-id` or `unambiguous-list-diff`) because Fly snapshots do not
 * carry the deployment nonce. Discovery fails closed when no / multiple candidates exist, the listed id differs
 * from the creation response, the candidate is another volume, predates the request, or is not exactly `created`.
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
const CanonicalUtc = z.string().refine(isCanonicalUtcTimestamp, 'must be a canonical UTC timestamp');
const Uint = z.number().int().nonnegative();

/** A raw provider snapshot record (as an adapter would receive it from `fly volume snapshots list --json`). */
export const rawFlyVolumeSnapshotSchema = z
  .object({ id: SnapshotId, status: LowerToken, volumeId: VolumeId, databaseApp: Ident, createdAt: CanonicalUtc, retentionDays: Uint, storedSizeBytes: Uint.optional() })
  .strict();
export type RawFlyVolumeSnapshot = z.infer<typeof rawFlyVolumeSnapshotSchema>;

export const SNAPSHOT_DISCOVERY_METHODS = ['create-response-id', 'unambiguous-list-diff'] as const;
export type SnapshotDiscoveryMethod = (typeof SNAPSHOT_DISCOVERY_METHODS)[number];

/** The normalized, explicitly-selected evidence fields the digest is computed over. */
export interface NormalizedProviderEvidence {
  readonly snapshotProvider: string;
  readonly providerAdapterVersion: string;
  readonly snapshotDiscoveryMethod: string;
  readonly snapshotId: string;
  readonly sourceVolumeId: string;
  readonly databaseApp: string;
  readonly providerSnapshotStatus: string;
  readonly canonicalSnapshotStatus: string;
  readonly snapshotRequestedAt: string;
  readonly snapshotCreatedAt: string;
  readonly providerObservedAt: string;
  readonly retentionDays: number;
  readonly storedSizeBytes: number | null;
}

export interface ProviderEvidenceResult {
  readonly evidence: NormalizedProviderEvidence;
  readonly normalizedProviderEvidenceDigest: string;
}

/** Domain-separated digest over the canonical normalized evidence (never over raw CLI text). */
export function computeNormalizedProviderEvidenceDigest(evidence: NormalizedProviderEvidence): string {
  return createHash('sha256').update(PROVIDER_EVIDENCE_DOMAIN, 'utf8').update(canonicalizeV1(evidence), 'utf8').digest('hex');
}

function parseRaw(raw: unknown): RawFlyVolumeSnapshot {
  const parsed = rawFlyVolumeSnapshotSchema.safeParse(raw);
  if (!parsed.success) throw new ProviderEvidenceError(`raw snapshot schema invalid: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  return parsed.data;
}

export interface DiscoveryInput {
  readonly method: SnapshotDiscoveryMethod;
  readonly expectedVolumeId: string;
  readonly snapshotRequestedAt: string;
  /** For `create-response-id`: the exact id from the provider's creation response. */
  readonly createResponseId?: string;
  /** For `unambiguous-list-diff`: the snapshot-ID set observed BEFORE the request. */
  readonly preRequestSnapshotIds?: readonly string[];
  /** The post-request listing observed from the provider (synthetic in tests). */
  readonly listing: readonly unknown[];
}

/**
 * Identify exactly one snapshot for the expected volume, failing closed on any ambiguity. Returns the raw record.
 */
export function discoverFlyVolumeSnapshot(input: DiscoveryInput): RawFlyVolumeSnapshot {
  if (!isCanonicalUtcTimestamp(input.snapshotRequestedAt)) throw new ProviderEvidenceError('snapshotRequestedAt is not canonical');
  const listing = input.listing.map(parseRaw);
  const forVolume = listing.filter((s) => s.volumeId === input.expectedVolumeId);
  if (input.method === 'create-response-id') {
    if (!input.createResponseId) throw new ProviderEvidenceError('create-response-id method requires createResponseId');
    const byId = forVolume.find((s) => s.id === input.createResponseId);
    if (!byId) throw new ProviderEvidenceError('creation-response id not found in listing for the expected volume');
    if (byId.status !== PROVIDER_RAW_STATUS_CREATED) throw new ProviderEvidenceError('candidate status is not created');
    if (Date.parse(byId.createdAt) < Date.parse(input.snapshotRequestedAt)) throw new ProviderEvidenceError('candidate predates snapshotRequestedAt');
    return byId;
  }
  // unambiguous-list-diff
  const pre = new Set(input.preRequestSnapshotIds ?? []);
  const candidates = forVolume.filter((s) => !pre.has(s.id) && s.status === PROVIDER_RAW_STATUS_CREATED && Date.parse(s.createdAt) >= Date.parse(input.snapshotRequestedAt));
  if (candidates.length === 0) throw new ProviderEvidenceError('no new snapshot candidate identified');
  if (candidates.length > 1) throw new ProviderEvidenceError('more than one new snapshot candidate — ambiguous');
  return candidates[0]!;
}

/**
 * Normalize a discovered raw snapshot into evidence + digest. Enforces the strict provider timeline
 * `snapshotRequestedAt <= snapshotCreatedAt <= providerObservedAt` and the exact `created → complete` mapping.
 */
export function normalizeFlyVolumeSnapshot(
  raw: unknown,
  opts: { snapshotRequestedAt: string; providerObservedAt: string; snapshotDiscoveryMethod: SnapshotDiscoveryMethod },
): ProviderEvidenceResult {
  const s = parseRaw(raw);
  if (s.status !== PROVIDER_RAW_STATUS_CREATED) throw new ProviderEvidenceError(`provider status ${JSON.stringify(s.status)} is not '${PROVIDER_RAW_STATUS_CREATED}'`);
  for (const [name, v] of [['snapshotRequestedAt', opts.snapshotRequestedAt], ['providerObservedAt', opts.providerObservedAt]] as const) {
    if (!isCanonicalUtcTimestamp(v)) throw new ProviderEvidenceError(`${name} is not a canonical UTC timestamp`);
  }
  const req = Date.parse(opts.snapshotRequestedAt);
  const created = Date.parse(s.createdAt);
  const obs = Date.parse(opts.providerObservedAt);
  if (!(req <= created)) throw new ProviderEvidenceError('snapshotRequestedAt is after snapshotCreatedAt');
  if (!(created <= obs)) throw new ProviderEvidenceError('snapshotCreatedAt is after providerObservedAt');
  const evidence: NormalizedProviderEvidence = {
    snapshotProvider: FLY_VOLUMES_PROVIDER,
    providerAdapterVersion: FLY_VOLUMES_ADAPTER_VERSION,
    snapshotDiscoveryMethod: opts.snapshotDiscoveryMethod,
    snapshotId: s.id,
    sourceVolumeId: s.volumeId,
    databaseApp: s.databaseApp,
    providerSnapshotStatus: s.status,
    canonicalSnapshotStatus: CANONICAL_SNAPSHOT_COMPLETE,
    snapshotRequestedAt: opts.snapshotRequestedAt,
    snapshotCreatedAt: s.createdAt,
    providerObservedAt: opts.providerObservedAt,
    retentionDays: s.retentionDays,
    storedSizeBytes: s.storedSizeBytes ?? null,
  };
  return { evidence, normalizedProviderEvidenceDigest: computeNormalizedProviderEvidenceDigest(evidence) };
}
