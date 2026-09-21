/**
 * Runtime port adapters (VER-002) binding ingest to the Hub's real infrastructure.
 * Kept out of the module index so the pure logic and tests never import the DB or
 * object store.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { link, mkdir, open, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { getObjectStore, ObjectNotFoundError, type ObjectStore } from '@/domain/documents/object-store';
import { LocalObjectStore } from '@/domain/documents/local-object-store';
import type { TenantContext } from '@/types/domain';
import type { ExclusiveArtifactWriter, RunnerSecretSource, StagedArtifact, StoredArtifactStore } from './ports';
import { UnsupportedExclusiveWriteError } from './ports';
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
 * Create-only artifact writer over the LOCAL object store (VER-002 PR-4). Publishes ONLY complete,
 * validated bytes: the caller streams into a private temp file under a reserved `.uploads-tmp/` dir
 * (same filesystem as the store, so it is inaccessible via any canonical tenant key and can be linked),
 * then `publish()` atomically links it to the final key — link fails with EEXIST → 'exists', never an
 * overwrite. We never `O_EXCL` the FINAL key and stream into it. An adapter that is not the local store
 * fails closed (see `exclusiveArtifactWriter`), never falling back to an overwriting put.
 */
class LocalExclusiveArtifactWriter implements ExclusiveArtifactWriter {
  constructor(private readonly base: string) {}

  private pathWithin(key: string): string {
    if (/[\\\x00]/.test(key) || key.split('/').some((s) => s === '.' || s === '..')) {
      throw new Error('non-canonical object key');
    }
    const full = resolve(this.base, key);
    if (full !== this.base && !full.startsWith(this.base + sep)) throw new Error('object key escapes storage root');
    return full;
  }

  async stage(finalKey: string): Promise<StagedArtifact> {
    const finalPath = this.pathWithin(finalKey);
    const tmpDir = join(this.base, '.uploads-tmp');
    await mkdir(tmpDir, { recursive: true });
    const tmpPath = join(tmpDir, randomUUID());
    const fh = await open(tmpPath, 'wx'); // exclusive create of the PRIVATE temp (never the final key)
    let closed = false;
    const closeOnce = async (): Promise<void> => {
      if (!closed) {
        closed = true;
        try {
          await fh.close();
        } catch {
          /* already closed */
        }
      }
    };
    return {
      async append(chunk: Buffer): Promise<void> {
        await fh.write(chunk);
      },
      async publish(): Promise<'created' | 'exists'> {
        await fh.sync();
        await closeOnce();
        await mkdir(dirname(finalPath), { recursive: true });
        try {
          await link(tmpPath, finalPath); // atomic create-only; fails if the final key already exists
          return 'created';
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
          throw err;
        }
      },
      async discard(): Promise<void> {
        await closeOnce();
        await rm(tmpPath, { force: true });
      },
    };
  }
}

/**
 * The configured create-only artifact writer. LOCAL store → a real temp-file+link writer. Any other
 * driver → FAIL CLOSED: `stage()` throws `UnsupportedExclusiveWriteError` (never an overwriting put),
 * so uploads on an unproven production adapter cannot silently lose the no-overwrite guarantee. The
 * production adapter's atomic create-only behavior must pass provider acceptance tests before enablement.
 */
export async function exclusiveArtifactWriter(storeArg?: ObjectStore): Promise<ExclusiveArtifactWriter> {
  const store = storeArg ?? (await getObjectStore());
  if (store.driver === 'local' && store instanceof LocalObjectStore) {
    return new LocalExclusiveArtifactWriter(store.baseDir);
  }
  const driver = store.driver;
  return {
    async stage(): Promise<StagedArtifact> {
      throw new UnsupportedExclusiveWriteError(driver);
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
