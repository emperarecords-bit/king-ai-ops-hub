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

const CONCERN_LABEL: Record<NeedsReviewConcern, string> = {
  review_due: 'review date passed',
  provenance_broken: 'evidence not inspectable',
  invalid_or_closed_scope: 'scope invalid or closed',
  disputed: 'disputed',
  possibly_multiple_claims: 'may contain multiple claims',
  restricted_no_disclosure_path: 'restricted — no disclosure path',
};

// Canonical groups, in the order a reviewer should read them. Needs-Review is rendered separately as a
// lens over these, so it is not in this ordered list of exclusive buckets.
const GROUP_ORDER: { key: KnowledgePortfolioGroup; title: string; purpose: string }[] = [
  { key: 'awaiting_review', title: 'Awaiting review', purpose: 'Proposals and drafts a person must judge before they can be used.' },
  { key: 'available', title: 'Available', purpose: 'Active records the assessment permits for normal current use. Available is not the same as verified.' },
  { key: 'use_with_qualification', title: 'Use with qualification', purpose: 'Active records that may be supplied only with an explicit qualification.' },
  { key: 'historical', title: 'Historical', purpose: 'Archived, superseded, expired, or scope-closed — inspectable, not for current use.' },
];

function Chip({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'accent' | 'warn' }) {
  const color = tone === 'accent' ? 'var(--accent)' : tone === 'warn' ? 'var(--danger, #b45309)' : 'var(--muted)';
  return <span className="rounded border px-1.5 py-0.5 text-xs" style={{ borderColor: 'var(--border)', color }}>{children}</span>;
}

function ReferenceRow({ projectKey, ref }: { projectKey: string; ref: KnowledgePortfolioReference }) {
  const d = ref.descriptor;
  const title = d.claim?.title ?? '(restricted — withheld from this view)';
  return (
    <li className="rounded-md border border-[var(--border)] p-3">
      <div className="mb-1 flex items-center justify-between gap-3">
        <Link href={`/p/${projectKey}/knowledge/${ref.id}`} className="text-sm font-medium hover:underline">
          {title}
          {ref.version > 1 ? <span className="ml-2 text-xs text-[var(--muted)]">v{ref.version}</span> : null}
        </Link>
        <Chip tone="accent">{CATEGORY_LABEL[d.category] ?? d.category}</Chip>
      </div>
      {/* How it was formed + how far it may be trusted — never conflating available with verified. */}
      <div className="flex flex-wrap gap-1.5 text-xs text-[var(--muted)]">
        <Chip>{d.formation.phrase}</Chip>
        <Chip>{d.verification.phrase}</Chip>
        <Chip>{d.freshness.phrase}</Chip>
        {d.provenance.phrase ? <Chip>{d.provenance.phrase}</Chip> : null}
        <Chip tone={d.disclosure.permitted ? 'muted' : 'warn'}>{d.disclosure.permitted ? 'workspace-internal' : 'restricted'}</Chip>
        <Chip>{d.applications.phrase}</Chip>
      </div>
      {ref.concerns.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {ref.concerns.map((c) => (
            <Chip key={c} tone="warn">{CONCERN_LABEL[c]}</Chip>
          ))}
        </div>
      ) : null}
    </li>
  );
}

/**
 * Knowledge Portfolio (K-conversation surface). Answers: what can this workspace rely on now, what
 * needs judgment, and what is available only with qualification or as history? Every reference is
 * rendered from the shared conversation descriptor — no second interpretation of trust.
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
        subtitle="What your team knows — grouped by how far it can be relied on. Every item is consulted, relevance-gated, before work in this workspace, and only this workspace."
      />

      <Card title="Add knowledge" className="mb-6">
        <NewKnowledgeForm projectKey={projectKey} />
      </Card>

      {total === 0 ? (
        <EmptyState>Nothing here yet. Add what your team should always know, or let a completed task propose it for your review.</EmptyState>
      ) : null}

      {/* Needs-Review LENS — evidence-backed concerns across active records; links to canonical records. */}
      {pf.needsReviewLens.length > 0 ? (
        <Card title={`Needs review (${pf.needsReviewLens.length})`} className="mb-6 border-[var(--accent)]">
          <p className="mb-3 text-xs text-[var(--muted)]">Active records with an evidence-backed concern — a lens over the groups below, not a separate bucket.</p>
          <ul className="space-y-3">
            {pf.needsReviewLens.map((ref) => (
              <ReferenceRow key={ref.id} projectKey={projectKey} ref={ref} />
            ))}
          </ul>
        </Card>
      ) : null}

      {GROUP_ORDER.map(({ key, title, purpose }) =>
        pf.groups[key].length > 0 ? (
          <Card key={key} title={`${title} (${pf.groups[key].length})`} className="mb-6">
            <p className="mb-3 text-xs text-[var(--muted)]">{purpose}</p>
            <ul className="space-y-3">
              {pf.groups[key].map((ref) => (
                <ReferenceRow key={ref.id} projectKey={projectKey} ref={ref} />
              ))}
            </ul>
          </Card>
        ) : null,
      )}
    </div>
  );
}
