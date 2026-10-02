import type { ReviewMode, ReviewOutcome } from '@/types/domain';

/**
 * Answer-routing Phase 1 — the review-state badge. Makes it clear, on the task result, whether review was
 * performed, not required, forced, or REQUIRED-BUT-UNMET. Reads only the run's persisted decision trail; a
 * legacy run (all fields null) renders nothing rather than fabricating a state.
 */
export interface ReviewStateRun {
  requestedMode: ReviewMode | null;
  effectiveMode: ReviewMode | null;
  reviewRequired: boolean | null;
  reviewForced: boolean | null;
  reviewOutcome: ReviewOutcome | null;
}

const OUTCOME_STYLE: Record<ReviewOutcome, { label: string; className: string; blurb: string }> = {
  reviewed: {
    label: 'Reviewed',
    className: 'bg-[#22303a] text-[#7bb8e5]',
    blurb: 'A reviewer cross-checked this answer.',
  },
  omitted: {
    label: 'Quick — review not required',
    className: 'bg-[var(--surface)] text-[var(--muted)] border border-[var(--border)]',
    blurb: 'Review was not required for this task and was not performed.',
  },
  required_unmet: {
    label: 'Unreviewed draft — required review not completed',
    className: 'bg-[#3a2026] text-[var(--danger)]',
    blurb:
      'A review is required but did not complete (reviewer unavailable, failed, timed out, or returned an invalid result). This answer has NOT been reviewed — do not treat it as reviewed.',
  },
  optional_degraded: {
    label: 'Optional review did not complete',
    className: 'bg-[#3a3220] text-[#e5c07b]',
    blurb: 'An optional review was requested but did not complete; the answer stands unreviewed.',
  },
};

export function ReviewStateBadge({ run }: { run: ReviewStateRun }) {
  if (!run.effectiveMode && !run.reviewOutcome) {
    // Legacy run predating answer-routing — nothing recorded, so claim nothing.
    return null;
  }
  const outcome = run.reviewOutcome;
  const style = outcome ? OUTCOME_STYLE[outcome] : null;

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2" aria-label="Review state">
      {style ? (
        <span className={`rounded px-2 py-0.5 text-xs font-semibold ${style.className}`}>{style.label}</span>
      ) : null}
      {run.reviewForced ? (
        <span className="rounded bg-[#3a3220] px-2 py-0.5 text-xs font-semibold text-[#e5c07b]">
          Quick request forced to Reviewed (review required)
        </span>
      ) : null}
      {run.requestedMode && run.effectiveMode && run.requestedMode !== run.effectiveMode && !run.reviewForced ? (
        <span className="text-xs text-[var(--muted)]">
          requested {run.requestedMode} · ran {run.effectiveMode}
        </span>
      ) : null}
      {style ? <span className="text-xs text-[var(--muted)]">{style.blurb}</span> : null}
    </div>
  );
}
