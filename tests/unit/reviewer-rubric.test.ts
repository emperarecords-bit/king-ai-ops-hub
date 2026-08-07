import { describe, expect, it } from 'vitest';
import {
  canonicalReviewRubric,
  MAX_REVIEW_RUBRIC_BYTES,
  reviewRubricBytes,
  reviewRubricHash,
  validateReviewRubric,
} from '@/domain/agents/reviewer-rubric';

describe('reviewer rubric validation and canonical hashing', () => {
  it('accepts null/blank as no rubric with one stable hash', () => {
    expect(validateReviewRubric(null)).toBeNull();
    expect(validateReviewRubric('  \r\n')).toBeNull();
    expect(reviewRubricHash(null)).toBe(reviewRubricHash(' \n'));
  });

  it('accepts exactly 8192 UTF-8 bytes and rejects 8193', () => {
    expect(reviewRubricBytes('a'.repeat(MAX_REVIEW_RUBRIC_BYTES))).toBe(8192);
    expect(validateReviewRubric('a'.repeat(8192))).toHaveLength(8192);
    expect(() => validateReviewRubric('a'.repeat(8193))).toThrow(/8192 UTF-8 bytes/);
  });

  it('enforces the boundary by bytes for multibyte Unicode', () => {
    const accepted = 'é'.repeat(4096);
    expect(reviewRubricBytes(accepted)).toBe(8192);
    expect(validateReviewRubric(accepted)).toBe(accepted);
    expect(() => validateReviewRubric(`${accepted}a`)).toThrow(/received 8193/);
  });

  it('normalizes line endings only and produces deterministic SHA-256', () => {
    expect(canonicalReviewRubric('  keep  \r\nnext\r')).toBe('  keep  \nnext\n');
    expect(reviewRubricHash('first\r\nsecond')).toBe(reviewRubricHash('first\nsecond'));
    expect(reviewRubricHash('same')).toBe(reviewRubricHash('same'));
    expect(reviewRubricHash('same')).toMatch(/^[0-9a-f]{64}$/);
    expect(reviewRubricHash('same ')).not.toBe(reviewRubricHash('same'));
  });
});
