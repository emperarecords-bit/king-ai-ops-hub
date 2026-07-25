import 'server-only';

/**
 * Object storage boundary (O-23). Source *files* live outside PostgreSQL, in
 * managed S3-compatible object storage. PostgreSQL keeps only metadata + the
 * extracted text/chunks (D-020). Uploads and downloads are ALWAYS server-
 * mediated (browser → app → store): storage credentials never reach the browser,
 * there are no public buckets and no publicly guessable object URLs.
 *
 * Two implementations behind one interface:
 *   * LocalObjectStore  — filesystem-backed, for dev and hermetic tests.
 *   * S3ObjectStore     — any S3-compatible endpoint (Tigris/R2/MinIO/AWS),
 *                         dependency-free SigV4. Selected by STORAGE_DRIVER=s3.
 */

export interface StoredObjectHead {
  size: number;
  contentType: string | null;
}

export interface ObjectStore {
  readonly driver: 'local' | 's3';
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  head(key: string): Promise<StoredObjectHead | null>;
  delete(key: string): Promise<void>;
}

/** Thrown when a key is absent — the caller maps this to `source_unavailable`
 *  rather than treating "gone" as "deleted the record". */
export class ObjectNotFoundError extends Error {
  constructor(key: string) {
    super(`object not found: ${key}`);
    this.name = 'ObjectNotFoundError';
  }
}

/**
 * Tenant-partitioned object key. Every key is prefixed by org + project, so a
 * key is meaningless outside its workspace and the prefix is a hard partition.
 * `sourceId` is the stable per-document id (survives re-uploads); the trailing
 * `versionHash` makes each version a distinct immutable object (no overwrite,
 * clean rollback/provenance). Callers build keys ONLY from the authenticated
 * ctx — never from client input.
 */
export function tenantObjectKey(args: {
  orgId: string;
  projectId: string;
  sourceId: string;
  versionHash: string;
}): string {
  return `org/${args.orgId}/project/${args.projectId}/doc/${args.sourceId}/${args.versionHash}`;
}

/** Does `key` belong to this tenant? A defense-in-depth check before any GET/
 *  DELETE so a stored key from another workspace can never be dereferenced. */
export function keyBelongsToTenant(
  key: string,
  args: { orgId: string; projectId: string },
): boolean {
  return key.startsWith(`org/${args.orgId}/project/${args.projectId}/`);
}

let cached: ObjectStore | null = null;

/** The configured store. STORAGE_DRIVER=s3 → S3ObjectStore (requires the
 *  S3_* env), otherwise the local filesystem store. */
export async function getObjectStore(): Promise<ObjectStore> {
  if (cached) return cached;
  if ((process.env.STORAGE_DRIVER ?? 'local') === 's3') {
    const { S3ObjectStore } = await import('./s3-object-store');
    cached = S3ObjectStore.fromEnv();
  } else {
    const { LocalObjectStore } = await import('./local-object-store');
    cached = new LocalObjectStore();
  }
  return cached;
}

/** Tests reset the cached store between object-store backends. */
export function __resetObjectStore(): void {
  cached = null;
}
