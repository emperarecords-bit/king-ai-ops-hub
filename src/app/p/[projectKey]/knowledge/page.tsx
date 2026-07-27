import Link from 'next/link';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import {
  buildKnowledgePortfolio,
  type KnowledgePortfolioGroup,
  type KnowledgePortfolioReference,
  type NeedsReviewConcern,
} from '@/domain/knowledge/portfolio';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { NewKnowledgeForm } from './knowledge-forms';

export const dynamic = 'force-dynamic';

const CATEGORY_LABEL: Record<string, string> = {
  restricted_withheld: 'Restricted',
  ai_extracted_draft: 'AI proposal',
  disputed: 'Disputed',
  stale_historical: 'Historical',
  review_due: 'Review due',
  superseded_correction: 'Superseded',
  source_supported: 'Source-supported',
  document_summary: 'Summary',
  inference: 'Inference',
  human_assertion: 'Human assertion',
  observation: 'Observation',
  withheld_other: 'Withheld',
};

// Concise, specific sentences for the Needs-Review lens — the operator should know WHAT needs judgment
// before opening the record.
const CONCERN_SENTENCE: Record<NeedsReviewConcern, string> = {
  review_due: 'Review date passed.',
  relied_source_unavailable: 'Relied-upon source version is unavailable — withheld from current factual use.',
  supplemental_partial: 'Some supplemental sources are unavailable; relied-upon support is intact.',
  invalid_or_closed_scope: 'Scope is invalid or closed.',
  disputed: 'Disputed claim.',
  possibly_multiple_claims: 'May contain several independent claims.',
  restricted_no_disclosure_path: 'Restricted — no currently usable disclosure grant is recorded.',
};

function Chip({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'accent' | 'warn' }) {
  const color = tone === 'accent' ? 'var(--accent)' : tone === 'warn' ? 'var(--danger, #b45309)' : 'var(--muted)';
  return <span className="rounded border px-1.5 py-0.5 text-xs" style={{ borderColor: 'var(--border)', color }}>{children}</span>;
}

function titleOf(r: KnowledgePortfolioReference): string {
  return r.descriptor.claim?.title ?? '(restricted — withheld from this view)';
}
function TitleLink({ projectKey, r }: { projectKey: string; r: KnowledgePortfolioReference }) {
  return (
    <Link href={`/p/${projectKey}/knowledge/${r.id}`} className="text-sm font-medium hover:underline">
      {titleOf(r)}
      {r.version > 1 ? <span className="ml-2 text-xs text-[var(--muted)]">v{r.version}</span> : null}
    </Link>
  );
}

/** Available & Use-With-Qualification: compact facts, led by how it was formed. No zero-application
 *  boilerplate; the workspace-internal default is not chipped (only `restricted` is noteworthy). */
function FactCard({ projectKey, r }: { projectKey: string; r: KnowledgePortfolioReference }) {
  const d = r.descriptor;
  return (
    <li className="rounded-md border border-[var(--border)] p-3">
      <div className="mb-1 flex items-center justify-between gap-3">
        <TitleLink projectKey={projectKey} r={r} />
        <Chip tone="accent">{CATEGORY_LABEL[d.category] ?? d.category}</Chip>
      </div>
      <div className="flex flex-wrap gap-1.5 text-xs text-[var(--muted)]">
        <Chip>{d.formation.phrase}</Chip>
        <Chip>{d.verification.phrase}</Chip>
        <Chip>{d.freshness.phrase}</Chip>
        {d.provenance.phrase ? <Chip>{d.provenance.phrase}</Chip> : null}
        {r.restrictedGrantState ? (
          <Chip tone={r.restrictedGrantState === 'granted' ? 'muted' : 'warn'}>
            {r.restrictedGrantState === 'granted' ? 'restricted · disclosure grant on file' : 'restricted · no usable grant'}
          </Chip>
        ) : null}
        {d.applications.count > 0 ? <Chip>{d.applications.phrase}</Chip> : null}
      </div>
    </li>
  );
}

/** Awaiting review: proposal/draft lifecycle led — a closed originating task is a scope note, not an
 *  archival verdict. */
function AwaitingCard({ projectKey, r }: { projectKey: string; r: KnowledgePortfolioReference }) {
  const isProposal = r.proposalReviewStatus === 'pending';
  return (
    <li className="rounded-md border border-[var(--border)] p-3">
      <div className="mb-1 flex items-center justify-between gap-3">
        <TitleLink projectKey={projectKey} r={r} />
        <Chip tone="accent">{isProposal ? 'AI proposal' : 'Draft'}</Chip>
      </div>
      <div className="flex flex-wrap gap-1.5 text-xs text-[var(--muted)]">
        <Chip>{isProposal ? 'awaiting review — suggested values are the AI’s, not yet chosen' : 'draft — not yet activated'}</Chip>
        {r.originatingTaskClosed ? <Chip>originating task is closed (affects suggested scope)</Chip> : null}
      </div>
    </li>
  );
}

/** Historical: led by the specific institutional reason, never flattened to "historical". */
function HistoricalCard({ projectKey, r }: { projectKey: string; r: KnowledgePortfolioReference }) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-md border border-[var(--border)] p-3">
      <TitleLink projectKey={projectKey} r={r} />
      <Chip>{r.historicalReason ?? 'Historical'}</Chip>
    </li>
  );
}

/** Needs-Review lens: concise references to canonical records — no duplicated cards. */
function LensRow({ projectKey, r }: { projectKey: string; r: KnowledgePortfolioReference }) {
  return (
    <li className="rounded-md border border-[var(--border)] p-3">
      <TitleLink projectKey={projectKey} r={r} />
      <ul className="mt-1 list-disc pl-5 text-xs text-[var(--muted)]">
        {r.concerns.map((c) => <li key={c}>{CONCERN_SENTENCE[c]}</li>)}
      </ul>
    </li>
  );
}

const GROUP_ORDER: { key: KnowledgePortfolioGroup; title: string; purpose: string }[] = [
  { key: 'awaiting_review', title: 'Awaiting review', purpose: 'Proposals and drafts a person must judge before they can be used. AI suggestions are not operator choices.' },
  { key: 'available', title: 'Available', purpose: 'Active records the assessment permits for normal current use. Available is not the same as verified.' },
  { key: 'use_with_qualification', title: 'Use with qualification', purpose: 'Active workspace context, usable with an explicit qualification.' },
  { key: 'historical', title: 'Historical', purpose: 'Inactive records — each keeps its specific reason. Inspectable, not for current use.' },
];

/**
 * Knowledge Portfolio. Answers: what can this workspace rely on now, what needs judgment, and what is
 * available only with qualification or as history? Every reference renders from the shared conversation
 * descriptor — no second interpretation of trust.
 */
export default async function KnowledgePage({ params }: { params: Promise<{ projectKey: string }> }) {
  const { projectKey } = await params;
  const ctx = await requireTenant(projectKey);
  const pf = await withTenant(ctx, (tx) => buildKnowledgePortfolio(tx, ctx));
  const total = Object.values(pf.groups).reduce((n, g) => n + g.length, 0);

  return (
    <div>
      <PageHeader
        title="Knowledge"
        subtitle="What your team knows. Active Knowledge is considered when the Hub assembles context for relevant AI work in this workspace — and only this workspace."
      />

      <Card title="Add knowledge" className="mb-6">
        <NewKnowledgeForm projectKey={projectKey} />
      </Card>

      {total === 0 ? (
        <EmptyState>Nothing here yet. Add what your team should always know, or let a completed task propose it for your review.</EmptyState>
      ) : null}

      {/* Needs-Review LENS — concise references to canonical records carrying an evidence-backed concern. */}
      {pf.needsReviewLens.length > 0 ? (
        <Card title={`Needs review (${pf.needsReviewLens.length})`} className="mb-6 border-[var(--accent)]">
          <p className="mb-3 text-xs text-[var(--muted)]">A lens over the groups below — what deserves attention. The record still lives in its canonical group.</p>
          <ul className="space-y-2">
            {pf.needsReviewLens.map((r) => (
              <LensRow key={r.id} projectKey={projectKey} r={r} />
            ))}
          </ul>
        </Card>
      ) : null}

      {GROUP_ORDER.map(({ key, title, purpose }) =>
        pf.groups[key].length > 0 ? (
          <Card key={key} title={`${title} (${pf.groups[key].length})`} className="mb-6">
            <p className="mb-3 text-xs text-[var(--muted)]">{purpose}</p>
            <ul className="space-y-3">
              {pf.groups[key].map((r) =>
                key === 'awaiting_review' ? (
                  <AwaitingCard key={r.id} projectKey={projectKey} r={r} />
                ) : key === 'historical' ? (
                  <HistoricalCard key={r.id} projectKey={projectKey} r={r} />
                ) : (
                  <FactCard key={r.id} projectKey={projectKey} r={r} />
                ),
              )}
            </ul>
          </Card>
        ) : null,
      )}
    </div>
  );
}
