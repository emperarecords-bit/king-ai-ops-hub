/**
 * Runtime port adapters (VER-002) that bind the ingest orchestrator to the Hub's
 * real infrastructure. Kept out of the module index so the pure logic and tests
 * never import the DB or object store.
 */
import { getObjectStore, ObjectNotFoundError, type ObjectStore } from '@/domain/documents/object-store';
import type { RunnerSecretSource, StoredArtifactStore } from './ports';

/**
 * Artifact availability over the Hub object store. `head`/`get` map object-store
 * calls; a missing object surfaces as `null` so availability is checked honestly.
 * (The object store has no retention/expiry signal today, so `expired` is false;
 * a future retention field maps here.)
 */
export function objectStoreArtifactStore(): StoredArtifactStore {
  let storeP: Promise<ObjectStore> | null = null;
  const store = (): Promise<ObjectStore> => (storeP ??= getObjectStore());
  return {
    async head(storageKey) {
      const h = await (await store()).head(storageKey);
      return h ? { sizeBytes: h.size, expired: false } : null;
    },
    async get(storageKey) {
      try {
        return await (await store()).get(storageKey);
      } catch (err) {
        if (err instanceof ObjectNotFoundError) return null;
        throw err;
      }
    },
  };
}

/**
 * Smallest authenticated local-runner connection: a per-project HMAC secret the
 * operator sets as `VERIFICATION_RUNNER_SECRET`. Productionization: move this to
 * the encrypted per-project `integration_secrets` store (name
 * `verification_runner_hmac`) once the executor-side decryptor is exposed — the
 * orchestrator is unchanged because it depends only on this port.
 */
export function envRunnerSecretSource(): RunnerSecretSource {
  return {
    async getRunnerSecret(): Promise<string | null> {
      const s = process.env.VERIFICATION_RUNNER_SECRET;
      return s && s.length >= 16 ? s : null;
    },
  };
}
