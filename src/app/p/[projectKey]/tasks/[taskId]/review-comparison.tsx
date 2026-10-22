import { ModelText, ProviderBadge } from '@/components/ui';
import type { MessageRow, RunStepRow } from '@/domain/tasks/tasks';
import { reviewStepOf, summarizeReview, type ReviewSummaryState } from '@/domain/tasks/review-summary';

const SEVERITY_STYLE: Record<string, string> = {
  critical: 'bg-[#3a2026] text-[var(--danger)]',
  major: 'bg-[#3a3220] text-[#e5c07b]',
  minor: 'bg-[#22303a] text-[#7bb8e5]',
};

const STATE_STYLE: Record<ReviewSummaryState, string> = {
  none: 'bg-[var(--surface)] text-[var(--muted)] border border-[var(--border)]',
  approved: 'bg-[#22303a] text-[#7bb8e5]',
  revised: 'bg-[#22303a] text-[#7bb8e5]',
  changes_requested: 'bg-[#3a3220] text-[#e5c07b]',
  rejected: 'bg-[#3a2026] text-[var(--danger)]',
  empty: 'bg-[#3a2026] text-[var(--danger)]',
  unreadable: 'bg-[#3a2026] text-[var(--danger)]',
  failed: 'bg-[#3a2026] text-[var(--danger)]',
};

function ResponsePanel({ title, message }: { title: string; message: MessageRow | null }) {
  return (
    <section className="min-w-0 rounded-md border border-[var(--border)] bg-[var(--surface)] p-4" aria-label={title}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">{title}</h3>
        {message?.provider ? <ProviderBadge provider={message.provider} /> : null}
        {message?.createdAt ? (
          <time className="text-xs text-[var(--muted)]" dateTime={message.createdAt.toISOString()}>
            {message.createdAt.toISOString().slice(0, 16).replace('T', ' ')} UTC
          </time>
        ) : null}
      </div>
      {message ? (
        <div className="break-words"><ModelText content={message.content} /></div>
      ) : (
        <p className="text-sm text-[var(--muted)]">Not recorded for this historical run.</p>
      )}
    </section>
  );
}

/**
 * The Review tab: first, in plain words, what the review actually was (summarizeReview — an empty or unreadable
 * reviewer reply is "no review", never a "reject"); then the findings when there are real ones; the original vs
 * revised side by side ONLY when a revision exists (otherwise the original IS the answer on the Answer tab, and
 * repeating it here was what made the page read as several jumbled answers); the reviewer's own words collapsed.
 */
export function ReviewComparison({
  steps,
  messages,
  reviewerName,
}: {
  steps: readonly RunStepRow[];
  messages: readonly MessageRow[];
  reviewerName: string | null;
}) {
  const summary = summarizeReview(steps, messages);
  const primaryStep = steps.find((step) => step.kind === 'primary') ?? null;
  const reviewStep = reviewStepOf(steps);
  const revisionStep = steps.find((step) => step.kind === 'revision') ?? null;
  const messageFor = (step: RunStepRow | null) =>
    step ? (messages.find((message) => message.runStepId === step.id) ?? null) : null;

  if (!reviewStep) {
    return (
      <section aria-labelledby="review-heading" className="mb-6">
        <h2 id="review-heading" className="mb-2 text-lg font-semibold">Review</h2>
        <p className="text-sm text-[var(--muted)]">{summary.headline}</p>
      </section>
    );
  }

  const detail = reviewStep.verdictDetail;
  const issues = summary.substantive ? (detail?.issues ?? []) : [];
  const provenance = detail?.provenance;
  const historicalReviewerName = provenance?.reviewerDisplayName ?? reviewerName;
  const hasImmutableProvenance = Boolean(provenance?.reviewerDisplayName && provenance?.rubricHash && provenance?.executedAt);
  const reviewerMessage = messageFor(reviewStep);

  return (
    <section aria-labelledby="review-heading" className="mb-6">
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <h2 id="review-heading" className="text-lg font-semibold">Review</h2>
        <span data-testid="review-state" className={`rounded px-2 py-0.5 text-xs font-semibold ${STATE_STYLE[summary.state]}`}>
          {summary.label}
        </span>
        {reviewStep.provider ? <ProviderBadge provider={reviewStep.provider} /> : null}
        <span className="text-sm text-[var(--muted)]">
          {historicalReviewerName ?? 'Reviewer'}
          {provenance?.model ? ` · ${provenance.model}` : reviewStep.model ? ` · ${reviewStep.model}` : ''}
        </span>
        {!hasImmutableProvenance ? <span className="text-xs text-[var(--muted)]">Legacy record — immutable reviewer metadata was not recorded.</span> : null}
      </div>
      <p data-testid="review-headline" className="mb-4 text-sm">{summary.headline}</p>

      {summary.substantive ? (
        <section className="mb-4 min-w-0 rounded-md border border-[var(--border)] bg-[var(--surface)] p-4" aria-label="Reviewer findings">
          <h3 className="mb-3 font-semibold">Findings</h3>
          {!detail ? (
            <p className="text-sm text-[var(--muted)]">Structured findings were not recorded for this historical run.</p>
          ) : issues.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">No specific findings were raised.</p>
          ) : (
            <ol className="space-y-3">
              {issues.map((issue, index) => (
                <li key={`${issue.claimAnchor ?? 'legacy'}-${index}`} className="break-words rounded border border-[var(--border)] p-3 text-sm">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className={`rounded px-2 py-0.5 text-xs font-semibold uppercase ${SEVERITY_STYLE[issue.severity] ?? ''}`}>
                      {issue.severity}
                    </span>
                    <code className="break-all text-xs text-[var(--muted)]">{issue.claimAnchor ?? 'Legacy finding — no claim anchor'}</code>
                  </div>
                  <p><strong>Rationale:</strong> {issue.rationale ?? issue.detail ?? issue.summary}</p>
                  {issue.requestedRevision ? <p className="mt-2"><strong>Requested revision:</strong> {issue.requestedRevision}</p> : null}
                </li>
              ))}
            </ol>
          )}
        </section>
      ) : null}

      {revisionStep ? (
        <div className="mb-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
          <ResponsePanel title="Original response" message={messageFor(primaryStep)} />
          <ResponsePanel title="Revised response" message={messageFor(revisionStep)} />
        </div>
      ) : null}

      {reviewerMessage && reviewerMessage.content.trim() !== '' ? (
        <details className="mb-3 rounded border border-[var(--border)] bg-[var(--surface)] p-3 text-sm">
          <summary className="cursor-pointer font-medium">The reviewer&apos;s own words</summary>
          <div className="mt-3 break-words"><ModelText content={reviewerMessage.content} /></div>
        </details>
      ) : null}

      {hasImmutableProvenance ? (
        <details className="mb-3 rounded border border-[var(--border)] bg-[var(--surface)] p-3 text-sm">
          <summary className="cursor-pointer font-medium">Execution-time reviewer rubric</summary>
          <dl className="mt-3 grid gap-2 sm:grid-cols-2">
            <div><dt className="text-xs text-[var(--muted)]">Executed</dt><dd>{provenance!.executedAt}</dd></div>
            <div><dt className="text-xs text-[var(--muted)]">Rubric hash</dt><dd><code className="break-all text-xs">{provenance!.rubricHash}</code></dd></div>
          </dl>
          <pre className="mt-3 whitespace-pre-wrap break-words rounded bg-[var(--background)] p-3 text-xs">{provenance!.rubricSnapshot ?? 'No additional reviewer rubric.'}</pre>
        </details>
      ) : null}
    </section>
  );
}
