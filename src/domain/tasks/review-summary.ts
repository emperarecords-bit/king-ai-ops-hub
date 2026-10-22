import type { MessageRow, RunStepRow } from '@/domain/tasks/tasks';

/**
 * What the review of a run ACTUALLY was, in plain words, from the stored step + reviewer message only.
 *
 * Hub prod 2026-10-22 (run 2db706f8): the reviewer returned an EMPTY reply, which the parser stores as a malformed
 * "reject" with no findings. The task page showed a "reject" badge and "No claim findings were raised" — it read as
 * a substantive rejection when no review happened at all. This keeps the two apart, for new runs (the engine now
 * records an empty review as a failed step) and for historical ones (empty / unreadable reviewer text).
 */
export type ReviewSummaryState =
  | 'none'
  | 'approved'
  | 'revised'
  | 'changes_requested'
  | 'rejected'
  | 'empty'
  | 'unreadable'
  | 'failed';

export interface ReviewSummary {
  state: ReviewSummaryState;
  /** Short badge text. */
  label: string;
  /** One or two plain sentences for the owner. */
  headline: string;
  /** True when the reviewer produced a real verdict (findings, if any, are meaningful). */
  substantive: boolean;
}

const REVIEW_RESULT_BLOCK = /```review-result\s*\n/;

export function reviewStepOf(steps: readonly RunStepRow[]): RunStepRow | null {
  return steps.find((s) => s.kind === 'review') ?? null;
}

export function summarizeReview(steps: readonly RunStepRow[], messages: readonly MessageRow[]): ReviewSummary {
  const step = reviewStepOf(steps);
  if (!step) {
    return { state: 'none', label: 'No review', headline: 'No reviewer looked at this answer.', substantive: false };
  }
  const message = messages.find((m) => m.runStepId === step.id) ?? null;
  const text = message?.content ?? '';

  if (!step.succeeded) {
    if (/empty response/i.test(step.errorMessage ?? '')) {
      return {
        state: 'empty',
        label: 'No review — reviewer replied empty',
        headline: 'The reviewer returned an empty response (it was retried once). No review was done, so this answer is unreviewed.',
        substantive: false,
      };
    }
    return {
      state: 'failed',
      label: 'No review — reviewer failed',
      headline: `The review did not complete${step.errorMessage ? `: ${step.errorMessage}` : '.'} This answer is unreviewed.`,
      substantive: false,
    };
  }

  // Historical runs: a recorded reviewer message with no text at all.
  if (message && text.trim() === '') {
    return {
      state: 'empty',
      label: 'No review — reviewer replied empty',
      headline: 'The reviewer returned an empty response. No review was done, so this answer is unreviewed — the "reject" recorded for it is not a real rejection.',
      substantive: false,
    };
  }

  const detail = step.verdictDetail;
  const verdict = detail?.verdict ?? step.verdict;
  const issues = detail?.issues ?? [];
  const revision = steps.find((s) => s.kind === 'revision') ?? null;

  // A v2 "reject" with no findings and no structured block is the parser's fallback for unreadable output.
  if (verdict === 'reject' && issues.length === 0 && detail?.contractVersion === '2' && message && !REVIEW_RESULT_BLOCK.test(text)) {
    return {
      state: 'unreadable',
      label: 'No review — reply unreadable',
      headline: 'The reviewer replied, but not in the required format, so no verdict could be read. This is not a rejection; the answer is unreviewed.',
      substantive: false,
    };
  }

  if (verdict === 'approve') {
    return { state: 'approved', label: 'Approved', headline: 'The reviewer checked this answer and approved it as written.', substantive: true };
  }
  if (verdict === 'revise') {
    return revision?.succeeded
      ? {
          state: 'revised',
          label: 'Revised after review',
          headline: 'The reviewer asked for changes; the answer was revised once to address them. The Answer tab shows the revised version.',
          substantive: true,
        }
      : {
          state: 'changes_requested',
          label: 'Changes requested — not revised',
          headline: 'The reviewer asked for changes, but no revision was produced. The answer stands as originally written — treat it with caution.',
          substantive: true,
        };
  }
  if (verdict === 'reject') {
    return {
      state: 'rejected',
      label: 'Rejected by reviewer',
      headline:
        issues.length > 0
          ? `The reviewer rejected this answer (${issues.length} finding${issues.length === 1 ? '' : 's'} below). No revision was produced — treat it with caution.`
          : 'The reviewer rejected this answer without giving specific findings. No revision was produced — treat it with caution.',
      substantive: true,
    };
  }
  return { state: 'failed', label: 'Review state unknown', headline: 'The review step has no recorded verdict.', substantive: false };
}
