/**
 * Runtime port adapters (VER-002) binding ingest to the Hub's real infrastructure.
 * Kept out of the module index so the pure logic and tests never import the DB or
 * object store.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { getObjectStore, ObjectNotFoundError, type ObjectStore } from '@/domain/documents/object-store';
import { LocalObjectStore } from '@/domain/documents/local-object-store';
import { S3ObjectStore } from '@/domain/documents/s3-object-store';
import { serverEnv } from '@/lib/env.server';
import type { TenantContext } from '@/types/domain';
import type { ExclusiveArtifactWriter, RunnerSecretSource, StagedArtifact, StoredArtifactStore } from './ports';
import { UnsupportedExclusiveWriteError } from './ports';
import { PER_ARTIFACT_CAP_BYTES } from './upload-grant';
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

/** Thrown when a destination or temp path escapes the storage root / tenant partition via a symlink. */
export class TenantEscapeError extends Error {
  constructor(what: string) {
    super(`artifact path escapes its tenant partition: ${what}`);
    this.name = 'TenantEscapeError';
  }
}

/**
 * Write an ENTIRE chunk, looping over partial `FileHandle.write()` results (a single write may store
 * fewer bytes than requested). Fails safely on zero progress so truncated bytes can never be published.
 */
export async function writeFully(
  handle: { write: (buf: Buffer, off: number, len: number) => Promise<{ bytesWritten: number }> },
  chunk: Buffer,
): Promise<void> {
  let off = 0;
  while (off < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, off, chunk.length - off);
    if (!Number.isFinite(bytesWritten) || bytesWritten <= 0) throw new Error('zero-progress file write');
    off += bytesWritten;
  }
}

/**
 * Symlink/junction-safe containment. The deepest EXISTING ancestor of `absTarget` must `realpath` to
 * exactly where it lexically belongs under the real `base`. Any symlinked ancestor — at any level,
 * including the tenant directory itself or a junction planted inside the partition — diverts the real
 * path and is rejected. Also rejects a lexically-outside target. Applied to the destination AND the
 * temp directory, before writing and again before publishing.
 */
async function pathStaysWithinBase(absTarget: string, base: string): Promise<boolean> {
  const baseReal = await realpath(base).catch(() => null);
  if (!baseReal) return false;
  if (absTarget !== base && !absTarget.startsWith(base + sep)) return false; // lexical containment
  let cur = absTarget;
  for (;;) {
    let real: string | null = null;
    try {
      real = await realpath(cur);
    } catch {
      real = null; // this ancestor does not exist yet — keep walking up
    }
    if (real !== null) {
      const rel = relative(base, cur); // '' when cur === base
      const expected = rel === '' ? baseReal : join(baseReal, rel);
      return real === expected;
    }
    const parent = dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

/**
 * Create-only artifact writer over the LOCAL object store (VER-002 PR-4). Publishes ONLY complete,
 * validated bytes: the caller streams into a private temp file under a reserved `.uploads-tmp/` dir
 * (same filesystem as the store, so it is inaccessible via any canonical tenant key and can be linked),
 * then `publish()` atomically links it to the final key — link fails with EEXIST → 'exists', never an
 * overwrite. We never `O_EXCL` the FINAL key and stream into it. Tenant containment (incl. symlink/junction
 * ancestors) is enforced before writing and again before publishing. An adapter that is not the local
 * store fails closed (see `exclusiveArtifactWriter`), never falling back to an overwriting put.
 */
class LocalExclusiveArtifactWriter implements ExclusiveArtifactWriter {
  constructor(private readonly base: string) {}

  private pathWithin(key: string): string {
    // Reject non-canonical keys (backslash/NUL, `.`/`..`, empty `//` segments, leading/trailing slash).
    if (/[\\\x00-\x1f]/.test(key) || key.startsWith('/') || key.endsWith('/') || key.split('/').some((s) => s === '' || s === '.' || s === '..')) {
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
    // Containment BEFORE any write: the temp dir and the destination's existing ancestors must not
    // escape the storage root via a symlink/junction.
    if (!(await pathStaysWithinBase(tmpDir, this.base))) throw new TenantEscapeError(tmpDir);
    if (!(await pathStaysWithinBase(finalPath, this.base))) throw new TenantEscapeError(finalKey);
    const tmpPath = join(tmpDir, randomUUID());
    const fh = await open(tmpPath, 'wx'); // exclusive create of the PRIVATE temp (never the final key)
    // Identity of the exact file that RECEIVES the validated bytes, captured via the open fd. Publication
    // must link THIS file — not whatever currently sits at tmpPath (which could be substituted after
    // staging).
    const stagedStat = await fh.stat();
    let closed = false;
    const base = this.base;
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
        await writeFully(fh, chunk); // handle partial writes; fail on zero progress
      },
      async publish(): Promise<'created' | 'exists'> {
        await fh.sync();
        await closeOnce();
        // RE-CHECK destination containment before mkdir/link — an ancestor could have become a symlink
        // mid-upload.
        if (!(await pathStaysWithinBase(finalPath, base))) throw new TenantEscapeError(finalKey);
        // SOURCE containment + IDENTITY: the temp path must still resolve inside the store, and must still
        // be the exact regular file we wrote (same device+inode via the fd's stat). This defeats a
        // temp-directory or temp-file substitution performed after staging — we never link a swapped file.
        if (!(await pathStaysWithinBase(tmpPath, base))) throw new TenantEscapeError(tmpPath);
        const onDisk = await lstat(tmpPath); // lstat: a symlink here is NOT a regular file → rejected
        if (!onDisk.isFile() || onDisk.ino !== stagedStat.ino || onDisk.dev !== stagedStat.dev) {
          throw new Error('staged temporary file was substituted before publication');
        }
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
 * Create-only artifact writer over the S3 (production) adapter (VER-002 PR-5). Streams the validated
 * bytes into a BOUNDED in-memory buffer (capped by the per-artifact cap; larger is aborted while
 * streaming), then publishes with ONE conditional create-only PUT (`S3ObjectStore.putIfAbsent`, which does
 * the reconcile/never-unconditional-retry logic). The buffer is released on every outcome via `discard`.
 * This adapter's request shape + no-overwrite logic are offline-verified; the PROVIDER's enforcement is
 * NOT VERIFIED until the authorized live acceptance run, so the factory keeps it behind a default-off gate.
 */
export function s3ExclusiveArtifactWriter(store: S3ObjectStore): ExclusiveArtifactWriter {
  return {
    async stage(finalKey: string): Promise<StagedArtifact> {
      const chunks: Buffer[] = [];
      let size = 0;
      let discarded = false;
      return {
        async append(chunk: Buffer): Promise<void> {
          if (discarded) throw new Error('append after discard');
          size += chunk.length;
          if (size > PER_ARTIFACT_CAP_BYTES) throw new Error('staged artifact exceeds the per-artifact cap');
          chunks.push(Buffer.from(chunk));
        },
        async publish(contentType: string): Promise<'created' | 'exists'> {
          return store.putIfAbsent(finalKey, Buffer.concat(chunks), contentType);
        },
        async discard(): Promise<void> {
          discarded = true;
          chunks.length = 0;
        },
      };
    },
  };
}

/**
 * The configured create-only artifact writer. LOCAL store → a real temp-file+link writer. S3 store → the
 * conditional create-only publisher, but ONLY when `VERIFICATION_RUNNER_UPLOAD_S3_ENABLED` is on (default
 * off — the provider's enforcement is unproven until the live acceptance run, so an unproven S3 adapter is
 * fail-closed even if uploads were enabled). Any other case → FAIL CLOSED: `stage()` throws
 * `UnsupportedExclusiveWriteError` (never an overwriting put).
 */
export async function exclusiveArtifactWriter(storeArg?: ObjectStore): Promise<ExclusiveArtifactWriter> {
  const store = storeArg ?? (await getObjectStore());
  if (store.driver === 'local' && store instanceof LocalObjectStore) {
    return new LocalExclusiveArtifactWriter(store.baseDir);
  }
  if (store.driver === 's3' && store instanceof S3ObjectStore && serverEnv().VERIFICATION_RUNNER_UPLOAD_S3_ENABLED) {
    return s3ExclusiveArtifactWriter(store);
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
