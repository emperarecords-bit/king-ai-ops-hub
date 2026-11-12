/**
 * Artifact upload + evidence submission (design §4, §6).
 *
 * Upload order is: declare (grant) -> send bytes -> only then submit evidence referencing the
 * resulting storage keys. Submitting first would describe artifacts that may never land.
 *
 * Retries are allowed ONLY where a retry is safe and meaningful. The grant request is idempotent
 * by construction (an identical re-request returns the existing grant), and the evidence submission
 * is idempotent on its derived key, so both may be retried on a transport or 5xx failure. A 409,
 * 507, 410 or 422 is NOT retried: each of those says the server already has a different, settled
 * view, and hammering it cannot change that.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isInside } from '../harness/sink';
import type { SubmittedArtifact } from '../contract';
import { HubError, type HubClient } from './hub-client';

export interface ArtifactSource {
  readonly logicalPath: string;
  /** Path on disk. Resolved under the checkout; traversal outside it is refused. */
  readonly filePath: string;
  readonly contentType?: string;
}

export interface UploadOptions {
  readonly client: HubClient;
  readonly requestId: string;
  readonly attemptId: string;
  readonly checkoutDir: string;
  readonly artifacts: readonly ArtifactSource[];
  readonly maxAttempts?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;

/** Retry only what is safe to retry; see the module note. */
async function withRetries<T>(fn: () => Promise<T>, maxAttempts: number): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      const retryable = err instanceof HubError ? err.retryable : true; // transport errors are retryable
      if (!retryable || attempt === maxAttempts) throw err;
      // Linear backoff is sufficient and predictable; this is a CI client, not a thundering herd.
      await new Promise((r) => setTimeout(r, 250 * attempt));
    }
  }
  throw last;
}

/**
 * Upload every artifact and return exactly what the signed payload should reference.
 *
 * The storageKey in the returned record is the SERVER-generated object key from the grant, never
 * anything this client chose: design §4.3 requires opaque server-generated ids, and a runner that
 * invented its own key would be refused.
 */
export async function uploadArtifacts(opts: UploadOptions): Promise<readonly SubmittedArtifact[]> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const checkout = resolve(opts.checkoutDir);
  const out: SubmittedArtifact[] = [];

  for (const a of opts.artifacts) {
    const abs = resolve(join(checkout, a.filePath));
    if (!isInside(checkout, abs)) {
      throw new Error('artifact ' + a.logicalPath + ' resolves outside the checkout: ' + abs);
    }
    const bytes = readFileSync(abs);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const contentType = a.contentType ?? 'application/octet-stream';

    const grant = await withRetries(
      () =>
        opts.client.requestGrant({
          requestId: opts.requestId,
          attemptId: opts.attemptId,
          logicalPath: a.logicalPath,
          declaredSize: bytes.byteLength,
          declaredSha256: sha256,
          contentType,
        }),
      maxAttempts,
    );

    // The bytes are sent once. A create-only publish means a replay of a COMPLETED upload is the
    // server's business (it replays idempotently); what we must not do is retry a 422 checksum or
    // 400 size failure, because the body would be identical and so would the answer.
    await withRetries(() => opts.client.redeemGrant(grant.uploadPath, bytes, grant.contentType ?? contentType), maxAttempts);

    out.push({
      logicalPath: grant.logicalPath,
      storageKey: grant.objectKey,
      sizeBytes: bytes.byteLength,
      sha256,
    });
  }
  return out;
}

export { withRetries };
