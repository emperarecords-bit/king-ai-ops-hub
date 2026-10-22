import 'server-only';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The build this server is running: the release's `sourceCommit` from /app/source-identity.json (written into every
 * production image by the Dockerfile, verified by the release ceremony). 'dev' when absent (local / tests). Read once.
 *
 * Used for build-skew detection (Hub prod 2026-10-22): an Ops Chat tab left open across a deploy keeps running the
 * OLD client code — it never got the live-refresh behaviour, so finished work never appeared in it. The page records
 * the build it was rendered by; GET /api/ops-chat/version reports the current one; a mismatch shows "Ops Chat was
 * updated — reload".
 */
let cached: string | null = null;

export function currentBuildId(): string {
  if (cached !== null) return cached;
  try {
    const raw = JSON.parse(readFileSync(join(process.cwd(), 'source-identity.json'), 'utf8')) as { sourceCommit?: unknown };
    cached = typeof raw.sourceCommit === 'string' && /^[0-9a-f]{7,40}$/.test(raw.sourceCommit) ? raw.sourceCommit : 'dev';
  } catch {
    cached = 'dev';
  }
  return cached;
}

/** Test seam: forget the cached value. */
export function resetBuildIdForTests(): void {
  cached = null;
}
