/**
 * Verify artifact availability (VER-002).
 *
 * A promised artifact only counts if it is actually STORED, RETRIEVABLE, and its
 * bytes hash to the recorded value. Unavailable, expired, or altered artifacts
 * are surfaced clearly and block a verified delivery claim.
 */
import { createHash } from 'node:crypto';
import type { ArtifactAvailability, SubmittedArtifact } from './ingest-types';
import type { StoredArtifactStore } from './ports';

export async function verifyArtifactAvailability(
  artifacts: readonly SubmittedArtifact[],
  store: StoredArtifactStore,
): Promise<ArtifactAvailability[]> {
  const out: ArtifactAvailability[] = [];
  for (const a of artifacts) {
    const head = await store.head(a.storageKey);
    if (!head) {
      out.push({
        path: a.path,
        storageKey: a.storageKey,
        state: 'unavailable',
        recordedSha256: a.sha256,
        observedSha256: null,
        detail: 'Artifact not found in storage.',
      });
      continue;
    }
    if (head.expired) {
      out.push({
        path: a.path,
        storageKey: a.storageKey,
        state: 'expired',
        recordedSha256: a.sha256,
        observedSha256: null,
        detail: 'Artifact retention expired; bytes no longer retrievable.',
      });
      continue;
    }
    const bytes = await store.get(a.storageKey);
    if (!bytes) {
      out.push({
        path: a.path,
        storageKey: a.storageKey,
        state: 'unavailable',
        recordedSha256: a.sha256,
        observedSha256: null,
        detail: 'Artifact head present but bytes could not be retrieved.',
      });
      continue;
    }
    const observed = createHash('sha256').update(bytes).digest('hex');
    out.push({
      path: a.path,
      storageKey: a.storageKey,
      state: observed === a.sha256 ? 'available' : 'hash_mismatch',
      recordedSha256: a.sha256,
      observedSha256: observed,
      detail:
        observed === a.sha256
          ? 'Stored, retrievable, hash matches.'
          : 'Stored bytes do not match the recorded hash — artifact was altered.',
    });
  }
  return out;
}

export function allArtifactsAvailable(availability: readonly ArtifactAvailability[]): boolean {
  return availability.every((a) => a.state === 'available');
}
