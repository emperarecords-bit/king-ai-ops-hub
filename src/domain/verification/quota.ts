/**
 * VER-002 PR-6 — aggregate storage quota, domain side. Design §4.6, as corrected by Gate B.
 *
 * WHAT THIS MODULE REFUSES TO DO is as important as what it does. There is no timer, no expiry hook, and
 * no "drain window". A reservation is released only when it is finalized, or when the grant it was taken
 * for turned out not to exist (below). §4.6's original "confirmed-absent after a drain window" text is
 * RETRACTED — see the SUPERSEDED IN PART BY GATE B admonition on that section: a presigned URL's expiry
 * is evaluated by S3 at request START, so a PUT begun just before expiry can keep writing afterwards, and
 * releasing on expiry would let those bytes exceed the cap.
 *
 * FINALIZE FREES NOTHING. It moves bytes from reserved to committed; the total charged against the cap is
 * unchanged, because the object now occupies storage. Quota comes back only when the object is actually
 * deleted, through PR-7's retention path, and only the retention role may trigger that refund.
 */
import type { QuotaStore } from './ports';

/**
 * Default aggregate cap seeded on a tenant's first reservation, so turning quota on needs no backfill and
 * PR-4's existing grant path keeps working. Mirrors how PER_ARTIFACT_CAP_BYTES is expressed — a plain
 * constant with a per-call override — rather than adding env-schema surface in this PR.
 *
 * 5 GiB against a 25 MiB per-artifact cap is ~200 artifacts' headroom per project: generous enough not to
 * surprise an existing project, small enough that a runaway runner is bounded.
 */
export const DEFAULT_PROJECT_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;

export interface QuotaDeps {
  readonly quota: QuotaStore;
  /** Override the seeded cap (tests, and any future per-plan policy). */
  readonly quotaCapBytes?: number;
}

export type ReservationOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'quota_exceeded' };

/**
 * Take a reservation for bytes that are about to be granted. Returns a refusal rather than throwing,
 * because "the project is full" is an expected answer the caller turns into a 4xx, not a fault.
 */
export async function reserveForGrant(deps: QuotaDeps, bytes: number): Promise<ReservationOutcome> {
  if (!Number.isInteger(bytes) || bytes < 0) throw new Error(`reserveForGrant: bytes must be a non-negative integer (got ${bytes})`);
  const cap = deps.quotaCapBytes ?? DEFAULT_PROJECT_QUOTA_BYTES;
  const taken = await deps.quota.reserve(bytes, cap);
  return taken ? { ok: true } : { ok: false, reason: 'quota_exceeded' };
}

/**
 * Undo a reservation taken moments ago in the SAME transaction, when the grant insert turned out to be a
 * de-duplicated hit so no new grant was created.
 *
 * This is NOT the timed reclamation Gate B forbids, and the distinction is exact: Gate B is about a grant
 * that EXISTS and whose bytes might still land. Here no grant was created, so nothing can ever be written
 * against the reservation. Without this, re-requesting an identical grant would silently consume quota on
 * every retry — a client that retries on a dropped response would exhaust a project's cap.
 */
export async function releaseUnusedReservation(deps: QuotaDeps, bytes: number): Promise<void> {
  if (bytes <= 0) return;
  await deps.quota.release(bytes);
}

/**
 * Convert a completed upload's reservation into committed usage. Returns whether the move happened; false
 * means there was nothing reserved to move (a replay, or a grant predating quota), and in that case
 * committed bytes are deliberately NOT invented — inflating the counter on a replay would slowly starve a
 * project of quota it never used.
 */
export async function finalizeUpload(deps: QuotaDeps, bytes: number): Promise<boolean> {
  if (!Number.isInteger(bytes) || bytes < 0) throw new Error(`finalizeUpload: bytes must be a non-negative integer (got ${bytes})`);
  return deps.quota.finalize(bytes);
}
