import { describe, expect, it } from 'vitest';
import {
  ProviderEvidenceError,
  computeProviderEvidenceDigest,
  normalizeFlyVolumeSnapshot,
} from '../../scripts/backup/provider-fly-volumes';

const rawOk = () => ({
  id: 'vs_abc123',
  status: 'created',
  volumeId: 'vol_4m3kmknl059qpd6v',
  databaseApp: 'king-ai-hub-db-staging',
  createdAt: '2026-08-01T11:50:00.000Z',
  retentionDays: 7,
  storedSizeBytes: 130000000,
});
const OBS = '2026-08-01T11:50:05.000Z';

describe('G-Backup-B1 fly-volumes provider adapter', () => {
  it('normalizes exact provider status created → canonical complete and computes a stable digest', () => {
    const a = normalizeFlyVolumeSnapshot(rawOk(), OBS);
    const b = normalizeFlyVolumeSnapshot(rawOk(), OBS);
    expect(a.evidence.providerSnapshotStatus).toBe('created');
    expect(a.evidence.canonicalSnapshotStatus).toBe('complete');
    expect(a.evidence.snapshotProvider).toBe('fly-volumes');
    expect(a.evidence.providerAdapterVersion).toBe('fly-volumes.v1');
    expect(a.providerEvidenceCanonicalDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(a.providerEvidenceCanonicalDigest).toBe(b.providerEvidenceCanonicalDigest);
    expect(computeProviderEvidenceDigest(a.evidence)).toBe(a.providerEvidenceCanonicalDigest);
  });
  it('a field change changes the evidence digest', () => {
    const base = normalizeFlyVolumeSnapshot(rawOk(), OBS).providerEvidenceCanonicalDigest;
    expect(normalizeFlyVolumeSnapshot({ ...rawOk(), retentionDays: 8 }, OBS).providerEvidenceCanonicalDigest).not.toBe(base);
    expect(normalizeFlyVolumeSnapshot({ ...rawOk(), id: 'vs_other' }, OBS).providerEvidenceCanonicalDigest).not.toBe(base);
  });
  it('rejects every provider status other than created', () => {
    for (const status of ['pending', 'creating', 'failed', 'destroyed', 'deleted', 'unknown']) {
      expect(() => normalizeFlyVolumeSnapshot({ ...rawOk(), status }, OBS)).toThrow(ProviderEvidenceError);
    }
  });
  it('rejects a malformed / wrong-shaped record', () => {
    expect(() => normalizeFlyVolumeSnapshot({ ...rawOk(), id: 'bad-id' }, OBS)).toThrow(ProviderEvidenceError); // not vs_*
    expect(() => normalizeFlyVolumeSnapshot({ ...rawOk(), volumeId: 'nope' }, OBS)).toThrow(ProviderEvidenceError); // not vol_*
    expect(() => normalizeFlyVolumeSnapshot({ ...rawOk(), extra: 1 }, OBS)).toThrow(ProviderEvidenceError); // strict
  });
  it('rejects an observation before creation and a non-UTC observation', () => {
    expect(() => normalizeFlyVolumeSnapshot(rawOk(), '2026-08-01T11:49:00.000Z')).toThrow(ProviderEvidenceError); // before createdAt
    expect(() => normalizeFlyVolumeSnapshot(rawOk(), '2026-08-01 11:50:05')).toThrow(ProviderEvidenceError); // not …Z
  });
});
