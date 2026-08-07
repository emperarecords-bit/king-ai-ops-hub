import { createHash } from 'node:crypto';
import { ValidationError } from '@/lib/errors';

export const MAX_REVIEW_RUBRIC_BYTES = 8192;
export const REVIEW_RUBRIC_HASH_VERSION = 'review-rubric/v1';

export function reviewRubricBytes(value: string | null | undefined): number {
  return Buffer.byteLength(value ?? '', 'utf8');
}

/**
 * Canonical rubric content:
 * - null and whitespace-only values mean no additional rubric and become '';
 * - CRLF and lone CR become LF for cross-platform identity;
 * - substantive leading/trailing whitespace and all other Unicode are preserved.
 */
export function canonicalReviewRubric(value: string | null | undefined): string {
  if (value == null || value.trim().length === 0) return '';
  return value.replace(/\r\n?/g, '\n');
}

export function reviewRubricHash(value: string | null | undefined): string {
  return createHash('sha256')
    .update(`${REVIEW_RUBRIC_HASH_VERSION}\0`, 'utf8')
    .update(canonicalReviewRubric(value), 'utf8')
    .digest('hex');
}

/** Returns null for the intentionally-empty state; preserves substantive text byte-for-byte. */
export function validateReviewRubric(value: string | null | undefined): string | null {
  if (value == null || value.trim().length === 0) return null;
  const bytes = reviewRubricBytes(value);
  if (bytes > MAX_REVIEW_RUBRIC_BYTES) {
    throw new ValidationError([`Reviewer rubric must be at most ${MAX_REVIEW_RUBRIC_BYTES} UTF-8 bytes (received ${bytes}).`]);
  }
  return value;
}
