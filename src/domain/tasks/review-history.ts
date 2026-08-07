import { z } from 'zod';
import { REVIEW_SEVERITIES, REVIEW_VERDICTS, type ReviewDetail } from '@/types/domain';

const legacyIssue = z.object({
  severity: z.enum(REVIEW_SEVERITIES),
  summary: z.string().trim().min(1).max(500),
  detail: z.string().trim().max(2_000).optional(),
}).strip();

const v2Issue = z.object({
  severity: z.enum(REVIEW_SEVERITIES),
  summary: z.string().trim().min(1).max(2_000),
  detail: z.string().trim().max(2_000).optional(),
  claimAnchor: z.string().min(1).max(100),
  rationale: z.string().trim().min(1).max(2_000),
  requestedRevision: z.string().trim().min(1).max(2_000).optional(),
}).strip();

const provenance = z.object({
  reviewerAgentId: z.string().min(1).max(100),
  provider: z.enum(['openai', 'anthropic']),
  model: z.string().min(1).max(500),
}).strip();

const v2 = z.object({
  contractVersion: z.literal('2'),
  verdict: z.enum(REVIEW_VERDICTS),
  issues: z.array(v2Issue).max(20),
  provenance,
}).strip();

const legacy = z.object({
  verdict: z.enum(REVIEW_VERDICTS),
  issues: z.array(legacyIssue).max(20).default([]),
}).strip();

/**
 * Runtime read boundary for JSON written by every review-contract generation.
 * Unknown/invalid JSON becomes null, so historical corruption cannot crash a
 * task page or be presented as a trusted review. No database rewrite occurs.
 */
export function normalizeHistoricalReviewDetail(value: unknown): ReviewDetail | null {
  const current = v2.safeParse(value);
  if (current.success) return current.data;
  if (typeof value === 'object' && value !== null && 'contractVersion' in value) return null;
  const old = legacy.safeParse(value);
  return old.success ? old.data : null;
}
