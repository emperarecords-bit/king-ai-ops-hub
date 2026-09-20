/**
 * Runtime port adapters (VER-002) binding ingest to the Hub's real infrastructure.
 * Kept out of the module index so the pure logic and tests never import the DB or
 * object store.
 */
import { createHmac } from 'node:crypto';
import { getObjectStore, ObjectNotFoundError, type ObjectStore } from '@/domain/documents/object-store';
import type { TenantContext } from '@/types/domain';
import type { RunnerSecretSource, StoredArtifactStore } from './ports';
import { assertCanonicalTenantKey, tenantPrefix } from './tenant-key';

/** Stores that can prove a key resolves inside a tenant directory (symlink-safe). */
interface TenantContainmentStore {
  keyStaysWithinTenant(key: string, tenantDirKey: string): Promise<boolean>;
}
function hasContainment(s: ObjectStore): s is ObjectStore & TenantContainmentStore {
  return typeof (s as Partial<TenantContainmentStore>).keyStaysWithinTenant === 'function';
}

/**
 * Artifact availability over the Hub object store, HARD-BOUND to one tenant.
 * Two layers of containment: (1) the key must be canonical (no traversal / no
 * `..` / no backslash) and inside `org/<orgId>/project/<projectId>/` — rejected
 * BEFORE any access; (2) when the backend can resolve real paths, the key must
 * also resolve INSIDE the tenant directory, defeating symlink escape. Anything
 * that fails either check is never dereferenced (returns null).
 * (No retention/expiry signal exists today, so `expired` is false.)
 */
export function objectStoreArtifactStore(
  ctx: Pick<TenantContext, 'orgId' | 'projectId'>,
  storeArg?: ObjectStore,
): StoredArtifactStore {
  let storeP: Promise<ObjectStore> | null = null;
  const store = (): Promise<ObjectStore> => (storeP ??= storeArg ? Promise.resolve(storeArg) : getObjectStore());
  const prefixDir = tenantPrefix(ctx.orgId, ctx.projectId);
  const contained = async (s: ObjectStore, key: string): Promise<boolean> =>
    !hasContainment(s) || (await s.keyStaysWithinTenant(key, prefixDir));

  return {
    async head(storageKey) {
      if (!assertCanonicalTenantKey(storageKey, ctx).ok) return null;
      const s = await store();
      if (!(await contained(s, storageKey))) return null;
      const h = await s.head(storageKey);
      return h ? { sizeBytes: h.size, expired: false } : null;
    },
    async get(storageKey) {
      if (!assertCanonicalTenantKey(storageKey, ctx).ok) return null;
      const s = await store();
      if (!(await contained(s, storageKey))) return null;
      try {
        return await s.get(storageKey);
      } catch (err) {
        if (err instanceof ObjectNotFoundError) return null;
        throw err;
      }
    },
  };
}

/**
 * Genuinely per-project runner secret, DERIVED server-side from a single master
 * secret and the caller's (orgId, projectId): HMAC(master, "verification-runner:v1:org:project").
 * The scope comes from the trusted tenant context, never the submitted payload, so
 * a key issued for one project cannot authenticate a submission for another. The
 * runner is provisioned its own derived key out of band; the master never leaves
 * the server. Set `VERIFICATION_RUNNER_MASTER_SECRET` (>= 32 chars) to enable
 * ingestion; unset disables it (every submission is unauthenticated).
 *
 * Productionization: swap this derivation for a per-project secret in the
 * encrypted `integration_secrets` store once the executor-side decryptor is
 * exposed — the orchestrator is unchanged because it depends only on this port.
 */
export function envRunnerSecretSource(): RunnerSecretSource {
  return {
    async getRunnerSecret(orgId, projectId): Promise<string | null> {
      const master = process.env.VERIFICATION_RUNNER_MASTER_SECRET;
      if (!master || master.length < 32) return null;
      return createHmac('sha256', master).update(`verification-runner:v1:${orgId}:${projectId}`).digest('hex');
    },
  };
}
