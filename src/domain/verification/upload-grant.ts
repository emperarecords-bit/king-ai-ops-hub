/**
 * VER-002 PR-4 — artifact upload grants (mechanism only; uploads disabled by default).
 *
 * Two orchestrators, pure over ports so they test against in-memory adapters:
 *  - `requestUploadGrant` issues an immutable grant binding (tenant, contract, attempt, logical path) to
 *    one server-derived object key + the DECLARED size/digest. Identical re-request is idempotent;
 *    a changed declaration is `grant_conflict`. Required-artifact paths only.
 *  - `redeemUploadGrant` streams bytes to a private temp, enforces the per-artifact cap + exact size +
 *    checksum, then publishes atomically create-only (no overwrite). Completion is an append-only event
 *    (idempotent); a later failed retry can never undo it. Expiry governs when a NEW upload may start;
 *    after expiry an existing object may still be reconciled, but no new object is created.
 *
 * The Hub still re-hashes the stored bytes at ingest and binds each artifact to a successful grant
 * (see ingest.ts) — these write-side checks are integrity-at-write and anti-abuse, not the verdict.
 */
import { createHash, randomUUID } from 'node:crypto';
import { UNPINNED_CATALOG_VERSION } from './catalog';
import type {
  ExclusiveArtifactWriter,
  NewUploadGrant,
  StoredArtifactStore,
  UploadGrant,
  UploadGrantStore,
  VerificationStore,
} from './ports';
import { UnsupportedExclusiveWriteError } from './ports';
import { assertCanonicalTenantKey } from './tenant-key';

/** Per-artifact byte cap (25 MiB), enforced WHILE streaming. */
export const PER_ARTIFACT_CAP_BYTES = 25 * 1024 * 1024;
/** Default grant TTL — governs when a NEW upload may START (5 minutes). */
export const DEFAULT_GRANT_TTL_MS = 5 * 60_000;
/** Default recorded max-upload-duration (T_max). RECORDED ONLY — nothing enforces it; never a reclaim trigger. */
export const DEFAULT_MAX_UPLOAD_MS = 5 * 60_000;

const ATTEMPT_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** A runner-declared attempt id must be an opaque token safe to place in a storage key. */
export function isValidAttemptId(id: unknown): id is string {
  return typeof id === 'string' && ATTEMPT_ID_RE.test(id) && id !== '.' && id !== '..' && !id.includes('..');
}

/** Server-derived, canonical object key for one artifact of one attempt of one contract. */
export function deriveUploadObjectKey(
  ctx: { readonly orgId: string; readonly projectId: string },
  requestId: string,
  attemptId: string,
  objectId: string,
): string {
  return `org/${ctx.orgId}/project/${ctx.projectId}/request/${requestId}/attempt/${attemptId}/${objectId}`;
}

// ─────────────────────────────── request a grant ───────────────────────────────

export interface UploadGrantRequestInput {
  readonly requestId: string;
  readonly attemptId: string;
  readonly logicalPath: string;
  readonly declaredSize: number;
  readonly declaredSha256: string;
  readonly contentType?: string;
}

export type GrantRequestRejectionCode =
  | 'invalid_input'
  | 'unknown_request'
  | 'catalog_unpinned'
  | 'path_not_required'
  | 'grant_conflict';

export interface GrantRequestOutcome {
  /** true = a new grant was created; false = an identical grant already existed (idempotent). */
  readonly created: boolean;
  readonly grant: UploadGrant | null;
  readonly rejection: { readonly code: GrantRequestRejectionCode; readonly message: string } | null;
}

export interface RequestGrantDeps {
  readonly store: Pick<VerificationStore, 'getRequest'>;
  readonly grants: UploadGrantStore;
  readonly now?: () => Date;
  readonly ttlMs?: number;
  readonly maxUploadMs?: number;
  readonly perArtifactCapBytes?: number;
  /** Injectable object-id generator for deterministic tests. */
  readonly newObjectId?: () => string;
}

const gReject = (code: GrantRequestRejectionCode, message: string): GrantRequestOutcome => ({
  created: false,
  grant: null,
  rejection: { code, message },
});
const grantConflict = (): GrantRequestOutcome =>
  gReject('grant_conflict', 'a grant already exists for this attempt+path with a different size/digest declaration');

/** Do two grant declarations name the SAME artifact bytes? (contract/attempt/path already matched by dedup.) */
function declarationEquals(g: UploadGrant, input: UploadGrantRequestInput): boolean {
  return g.declaredSize === input.declaredSize && g.declaredSha256 === input.declaredSha256;
}

export async function requestUploadGrant(
  deps: RequestGrantDeps,
  ctx: { readonly orgId: string; readonly projectId: string; readonly userId?: string },
  input: UploadGrantRequestInput,
): Promise<GrantRequestOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const cap = deps.perArtifactCapBytes ?? PER_ARTIFACT_CAP_BYTES;

  // 1. Validate the untrusted declaration up front.
  if (!isValidAttemptId(input.attemptId)) {
    return gReject('invalid_input', 'attemptId must be an opaque token [A-Za-z0-9._-]{1,128} with no traversal');
  }
  const logicalPath = (input.logicalPath ?? '').trim();
  if (logicalPath === '' || logicalPath.length > 512) {
    return gReject('invalid_input', 'logicalPath is required and must be <= 512 chars');
  }
  if (!Number.isInteger(input.declaredSize) || input.declaredSize < 0 || input.declaredSize > cap) {
    return gReject('invalid_input', `declaredSize must be an integer in [0, ${cap}] bytes`);
  }
  if (!SHA256_HEX_RE.test(input.declaredSha256)) {
    return gReject('invalid_input', 'declaredSha256 must be 64 lowercase hex chars');
  }

  // 2. The contract must exist in this tenant and be catalog-pinned (legacy fails closed, as ingest).
  const contract = await deps.store.getRequest(ctx.orgId, ctx.projectId, input.requestId);
  if (!contract) return gReject('unknown_request', 'no verification contract with that id in this project');
  if (contract.catalogVersion === UNPINNED_CATALOG_VERSION) {
    return gReject('catalog_unpinned', 'contract predates catalog pinning; it cannot receive uploads');
  }

  // 3. Required-artifact paths only.
  if (!contract.requiredArtifacts.includes(logicalPath)) {
    return gReject('path_not_required', 'logicalPath is not a required artifact of this contract');
  }

  // 4. Dedup: identical re-request returns the same grant; a changed declaration is a conflict.
  const existing = await deps.grants.findGrantByDedup(ctx.orgId, ctx.projectId, input.requestId, input.attemptId, logicalPath);
  if (existing) {
    return declarationEquals(existing, input) ? { created: false, grant: existing, rejection: null } : grantConflict();
  }

  // 5. Derive a canonical, opaque-leaf key and insert idempotently (race-safe on the dedup unique).
  const objectId = (deps.newObjectId ?? (() => randomUUID()))();
  const objectKey = deriveUploadObjectKey(ctx, input.requestId, input.attemptId, objectId);
  if (!assertCanonicalTenantKey(objectKey, ctx).ok) {
    return gReject('invalid_input', 'derived object key is not canonical for this tenant');
  }
  const newGrant: NewUploadGrant = {
    requestId: input.requestId,
    attemptId: input.attemptId,
    logicalPath,
    objectKey,
    declaredSize: input.declaredSize,
    declaredSha256: input.declaredSha256,
    contentType: input.contentType && input.contentType.trim() !== '' ? input.contentType : 'application/octet-stream',
    expiresAt: new Date(now.getTime() + (deps.ttlMs ?? DEFAULT_GRANT_TTL_MS)),
    maxUploadMs: deps.maxUploadMs ?? DEFAULT_MAX_UPLOAD_MS,
  };
  const { grant, inserted } = await deps.grants.insertGrant(ctx.orgId, ctx.projectId, ctx.userId ?? null, newGrant);
  if (inserted) return { created: true, grant, rejection: null };
  // Lost a concurrent create race — return the WINNER if identical, else conflict.
  return declarationEquals(grant, input) ? { created: false, grant, rejection: null } : grantConflict();
}

// ─────────────────────────────── redeem a grant ───────────────────────────────

export type RedeemRejectionCode =
  | 'grant_not_found'
  | 'grant_expired'
  | 'too_large'
  | 'size_mismatch'
  | 'checksum_mismatch'
  | 'grant_binding_mismatch'
  | 'write_unsupported';

export interface RedeemOutcome {
  readonly completed: boolean;
  /** true = the grant was ALREADY completed before this call (idempotent replay). */
  readonly idempotent: boolean;
  /** true = completion was reached by reconciling an already-existing object (crash/expiry recovery). */
  readonly reconciled: boolean;
  readonly objectKey: string | null;
  readonly rejection: { readonly code: RedeemRejectionCode; readonly message: string } | null;
}

export interface RedeemDeps {
  readonly grants: UploadGrantStore;
  readonly writer: ExclusiveArtifactWriter;
  readonly artifacts: StoredArtifactStore;
  readonly now?: () => Date;
  readonly perArtifactCapBytes?: number;
}

const rReject = (code: RedeemRejectionCode, message: string): RedeemOutcome => ({
  completed: false,
  idempotent: false,
  reconciled: false,
  objectKey: null,
  rejection: { code, message },
});

/** Does the object already at the grant's key match the grant's declared size+digest? */
async function reconcileExisting(deps: RedeemDeps, grant: UploadGrant): Promise<'match' | 'mismatch' | 'absent'> {
  const head = await deps.artifacts.head(grant.objectKey);
  if (!head) return 'absent';
  if (head.sizeBytes !== grant.declaredSize) return 'mismatch';
  const bytes = await deps.artifacts.get(grant.objectKey);
  if (!bytes) return 'absent';
  const observed = createHash('sha256').update(bytes).digest('hex');
  return observed === grant.declaredSha256 && bytes.length === grant.declaredSize ? 'match' : 'mismatch';
}

export async function redeemUploadGrant(
  deps: RedeemDeps,
  ctx: { readonly orgId: string; readonly projectId: string },
  grantId: string,
  body: AsyncIterable<Uint8Array>,
): Promise<RedeemOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const cap = deps.perArtifactCapBytes ?? PER_ARTIFACT_CAP_BYTES;

  const grant = await deps.grants.getGrantById(ctx.orgId, ctx.projectId, grantId);
  if (!grant) return rReject('grant_not_found', 'no upload grant with that id in this project');

  const complete = async (): Promise<void> => {
    await deps.grants.appendEvent(ctx.orgId, ctx.projectId, grant.id, 'uploaded', null);
  };
  const failEvent = async (detail: string): Promise<void> => {
    await deps.grants.appendEvent(ctx.orgId, ctx.projectId, grant.id, 'redemption_failed', detail);
  };

  // Already completed → idempotent success; a later failed retry can never undo a completion.
  if (await deps.grants.isUploaded(ctx.orgId, ctx.projectId, grant.id)) {
    return { completed: true, idempotent: true, reconciled: false, objectKey: grant.objectKey, rejection: null };
  }

  const expired = now.getTime() > Date.parse(grant.expiresAt);
  if (expired) {
    // Recovery after expiry: reconcile an already-existing object ONLY; refuse to create a new one.
    const rec = await reconcileExisting(deps, grant);
    if (rec === 'match') {
      await complete();
      return { completed: true, idempotent: false, reconciled: true, objectKey: grant.objectKey, rejection: null };
    }
    if (rec === 'absent') {
      await failEvent('expired: no object present to reconcile');
      return rReject('grant_expired', 'grant expired and no object exists; request a new attempt');
    }
    await failEvent('expired: existing object does not match the grant');
    return rReject('grant_binding_mismatch', 'existing object does not match the grant declaration');
  }

  // Not expired: stream to a private temp, validate exactly, then atomic create-only publish.
  let staged;
  try {
    // The grant's expiry bounds any internal publish retry (e.g. the S3 adapter's ambiguous-outcome retry).
    staged = await deps.writer.stage(grant.objectKey, { deadline: new Date(Date.parse(grant.expiresAt)) });
  } catch (err) {
    if (err instanceof UnsupportedExclusiveWriteError) {
      await failEvent('storage adapter cannot guarantee atomic create-only writes');
      return rReject('write_unsupported', 'storage adapter cannot guarantee atomic create-only writes');
    }
    throw err;
  }

  try {
    const hash = createHash('sha256');
    let size = 0;
    let aborted: RedeemRejectionCode | null = null;
    for await (const chunk of body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > cap) {
        aborted = 'too_large';
        break;
      }
      if (size > grant.declaredSize) {
        aborted = 'size_mismatch';
        break;
      }
      hash.update(buf);
      await staged.append(buf);
    }
    if (aborted) {
      await failEvent(`stream aborted: ${aborted}`);
      return rReject(
        aborted,
        aborted === 'too_large'
          ? `upload exceeded the ${cap}-byte per-artifact cap`
          : 'uploaded bytes exceeded the grant-declared size',
      );
    }
    if (size !== grant.declaredSize) {
      await failEvent('size mismatch');
      return rReject('size_mismatch', `uploaded ${size} bytes, grant declared ${grant.declaredSize}`);
    }
    if (hash.digest('hex') !== grant.declaredSha256) {
      await failEvent('checksum mismatch');
      return rReject('checksum_mismatch', 'uploaded bytes do not hash to the grant-declared sha256');
    }

    const res = await staged.publish(grant.contentType);
    if (res === 'created') {
      await complete();
      return { completed: true, idempotent: false, reconciled: false, objectKey: grant.objectKey, rejection: null };
    }
    // 'exists' → a concurrent redemption already landed it, or a crash-after-write is being retried.
    const rec = await reconcileExisting(deps, grant);
    if (rec === 'match') {
      await complete();
      return { completed: true, idempotent: true, reconciled: true, objectKey: grant.objectKey, rejection: null };
    }
    await failEvent('existing object mismatch on publish');
    return rReject('grant_binding_mismatch', 'an object already exists at the key but does not match the grant');
  } finally {
    // Clean up this request's own temp file on any outcome (success, failure, or cancellation).
    await staged.discard();
  }
}
