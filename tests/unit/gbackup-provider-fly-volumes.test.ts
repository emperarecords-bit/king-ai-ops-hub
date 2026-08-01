import { describe, expect, it } from 'vitest';
import {
  ProviderEvidenceError,
  computeNormalizedProviderEvidenceDigest,
  discoverFlyVolumeSnapshot,
  normalizeFlyVolumeSnapshot,
} from '../../scripts/backup/provider-fly-volumes';

const rawOk = () => ({ id: 'vs_abc123', status: 'created', volumeId: 'vol_4m3kmknl059qpd6v', databaseApp: 'king-ai-hub-db-staging', createdAt: '2026-08-01T11:50:00.000Z', retentionDays: 7, storedSizeBytes: 130000000 });
const REQ = '2026-08-01T11:49:58.000Z';
const OBS = '2026-08-01T11:50:05.000Z';
const opts = (o: Partial<{ snapshotRequestedAt: string; providerObservedAt: string; snapshotDiscoveryMethod: 'create-response-id' | 'unambiguous-list-diff' }> = {}) => ({ snapshotRequestedAt: REQ, providerObservedAt: OBS, snapshotDiscoveryMethod: 'create-response-id' as const, ...o });

describe('G-Backup-B1 fly-volumes normalization', () => {
  it('normalizes created → complete, binds requestedAt + discovery, stable digest', () => {
    const a = normalizeFlyVolumeSnapshot(rawOk(), opts());
    expect(a.evidence.canonicalSnapshotStatus).toBe('complete');
    expect(a.evidence.snapshotRequestedAt).toBe(REQ);
    expect(a.evidence.snapshotDiscoveryMethod).toBe('create-response-id');
    expect(a.normalizedProviderEvidenceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(computeNormalizedProviderEvidenceDigest(a.evidence)).toBe(a.normalizedProviderEvidenceDigest);
  });
  it('a field change changes the digest', () => {
    const base = normalizeFlyVolumeSnapshot(rawOk(), opts()).normalizedProviderEvidenceDigest;
    expect(normalizeFlyVolumeSnapshot({ ...rawOk(), retentionDays: 8 }, opts()).normalizedProviderEvidenceDigest).not.toBe(base);
  });
  it('rejects non-created status, non-canonical timestamps, and requested-after-created', () => {
    expect(() => normalizeFlyVolumeSnapshot({ ...rawOk(), status: 'pending' }, opts())).toThrow(ProviderEvidenceError);
    expect(() => normalizeFlyVolumeSnapshot(rawOk(), opts({ providerObservedAt: '2026-08-01T11:50:05Z' }))).toThrow(ProviderEvidenceError);
    expect(() => normalizeFlyVolumeSnapshot(rawOk(), opts({ snapshotRequestedAt: '2026-08-01T11:50:01.000Z' }))).toThrow(ProviderEvidenceError); // after created
    expect(() => normalizeFlyVolumeSnapshot(rawOk(), opts({ providerObservedAt: '2026-08-01T11:49:59.000Z' }))).toThrow(ProviderEvidenceError); // observed before created
  });
});

describe('G-Backup-B1 snapshot discovery (synthetic listings)', () => {
  const listing = (extra: Record<string, unknown>[] = []) => [rawOk(), ...extra];
  it('create-response-id: confirmed in listing accepted', () => {
    const s = discoverFlyVolumeSnapshot({ method: 'create-response-id', expectedVolumeId: 'vol_4m3kmknl059qpd6v', snapshotRequestedAt: REQ, createResponseId: 'vs_abc123', listing: listing() });
    expect(s.id).toBe('vs_abc123');
  });
  it('create-response-id: creation-response/listing id mismatch rejected', () => {
    expect(() => discoverFlyVolumeSnapshot({ method: 'create-response-id', expectedVolumeId: 'vol_4m3kmknl059qpd6v', snapshotRequestedAt: REQ, createResponseId: 'vs_notpresent', listing: listing() })).toThrow(ProviderEvidenceError);
  });
  it('unambiguous-list-diff: exactly one new snapshot accepted', () => {
    const s = discoverFlyVolumeSnapshot({ method: 'unambiguous-list-diff', expectedVolumeId: 'vol_4m3kmknl059qpd6v', snapshotRequestedAt: REQ, preRequestSnapshotIds: ['vs_old'], listing: listing() });
    expect(s.id).toBe('vs_abc123');
  });
  it('list-diff: no candidate rejected', () => {
    expect(() => discoverFlyVolumeSnapshot({ method: 'unambiguous-list-diff', expectedVolumeId: 'vol_4m3kmknl059qpd6v', snapshotRequestedAt: REQ, preRequestSnapshotIds: ['vs_abc123'], listing: listing() })).toThrow(ProviderEvidenceError);
  });
  it('list-diff: multiple candidates rejected', () => {
    const two = listing([{ ...rawOk(), id: 'vs_second' }]);
    expect(() => discoverFlyVolumeSnapshot({ method: 'unambiguous-list-diff', expectedVolumeId: 'vol_4m3kmknl059qpd6v', snapshotRequestedAt: REQ, preRequestSnapshotIds: [], listing: two })).toThrow(ProviderEvidenceError);
  });
  it('candidate from another volume is not selected', () => {
    const other = [{ ...rawOk(), id: 'vs_otherv', volumeId: 'vol_other' }];
    expect(() => discoverFlyVolumeSnapshot({ method: 'unambiguous-list-diff', expectedVolumeId: 'vol_other', snapshotRequestedAt: REQ, preRequestSnapshotIds: [], listing: [rawOk(), ...other].filter((s) => s.volumeId !== 'vol_other') })).toThrow(ProviderEvidenceError); // none for vol_other after filter
  });
  it('candidate predating the request is rejected (create-response-id)', () => {
    const old = [{ ...rawOk(), createdAt: '2026-08-01T11:49:00.000Z' }];
    expect(() => discoverFlyVolumeSnapshot({ method: 'create-response-id', expectedVolumeId: 'vol_4m3kmknl059qpd6v', snapshotRequestedAt: REQ, createResponseId: 'vs_abc123', listing: old })).toThrow(ProviderEvidenceError);
  });
});
