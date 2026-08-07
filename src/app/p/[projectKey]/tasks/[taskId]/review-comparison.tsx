import { ModelText, ProviderBadge, StatusBadge } from '@/components/ui';
import type { MessageRow, RunStepRow } from '@/domain/tasks/tasks';

const SEVERITY_STYLE: Record<string, string> = {
  critical: 'bg-[#3a2026] text-[var(--danger)]',
  major: 'bg-[#3a3220] text-[#e5c07b]',
  minor: 'bg-[#22303a] text-[#7bb8e5]',
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

export function ReviewComparison({
  steps,
  messages,
  reviewerName,
}: {
  steps: readonly RunStepRow[];
  messages: readonly MessageRow[];
  reviewerName: string | null;
}) {
  const primaryStep = steps.find((step) => step.kind === 'primary') ?? null;
  const reviewStep = steps.find((step) => step.kind === 'review') ?? null;
  const revisionStep = steps.find((step) => step.kind === 'revision') ?? null;
  if (!reviewStep) return null;
  const messageFor = (step: RunStepRow | null) =>
    step ? (messages.find((message) => message.runStepId === step.id) ?? null) : null;
  const detail = reviewStep.verdictDetail;
  const issues = detail?.issues ?? [];
  const provenance = detail?.provenance;
  const historicalReviewerName = provenance?.reviewerDisplayName ?? reviewerName;
  const hasImmutableProvenance = Boolean(provenance?.reviewerDisplayName && provenance?.rubricHash && provenance?.executedAt);

  return (
    <section aria-labelledby="review-comparison-heading" className="mb-6">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 id="review-comparison-heading" className="text-lg font-semibold">Cross-provider review</h2>
        <StatusBadge status={detail?.verdict ?? reviewStep.verdict ?? 'unavailable'} />
        {reviewStep.provider ? <ProviderBadge provider={reviewStep.provider} /> : null}
        <span className="text-sm text-[var(--muted)]">
          {historicalReviewerName ?? 'Reviewer'}
          {provenance?.model ? ` · ${provenance.model}` : reviewStep.model ? ` · ${reviewStep.model}` : ''}
        </span>
        {!hasImmutableProvenance ? <span className="text-xs text-[var(--muted)]">Legacy record — immutable reviewer metadata was not recorded.</span> : null}
      </div>

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

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <ResponsePanel title="Primary response" message={messageFor(primaryStep)} />
        <section className="min-w-0 rounded-md border border-[var(--border)] bg-[var(--surface)] p-4" aria-label="Reviewer findings">
          <h3 className="mb-3 font-semibold">Reviewer findings</h3>
          {!detail ? (
            <p className="text-sm text-[var(--muted)]">Structured findings were not recorded for this historical run.</p>
          ) : issues.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">No claim findings were raised.</p>
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
        <ResponsePanel title="Revised response" message={messageFor(revisionStep)} />
      </div>
    </section>
  );
}
