import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { buildKnowledgeReference } from '@/domain/knowledge/portfolio';
import { listInjectionsForKnowledge, listKnowledge, listKnowledgeSources } from '@/domain/knowledge/knowledge';
import { listKnowledgeProposals } from '@/domain/knowledge/extraction';
import { Card, PageHeader } from '@/components/ui';
import { KnowledgeStatusButtons, ReviseKnowledgeForm } from '../knowledge-forms';
import {
  PromoteProposalForm,
  RejectProposalForm,
  ReviseProposalForm,
  SplitProposalForm,
  SupportJudgmentForm,
  VerificationForm,
} from '../knowledge-review-forms';

export const dynamic = 'force-dynamic';

function Section({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <Card title={`${n}. ${title}`} className="mb-4">
      <div className="text-sm text-[var(--foreground)]">{children}</div>
    </Card>
  );
}

/**
 * Knowledge Detail — the complete evidence conversation for one record, rendered from the SAME shared
 * descriptor the Portfolio and selector use. It reports each trust dimension separately (a source
 * attachment never looks like verification); technical provenance is available but does not dominate.
 */
export default async function KnowledgeDetailPage({ params }: { params: Promise<{ projectKey: string; itemId: string }> }) {
  const { projectKey, itemId } = await params;
  const ctx = await requireTenant(projectKey);

  const ref = await withTenant(ctx, (tx) => buildKnowledgeReference(tx, ctx, itemId));
  if (!ref) notFound();
  const d = ref.descriptor;

  // ACCESS FILTERED AT RETRIEVAL: a viewer without access to a restricted record never causes the
  // sensitive queries (item body, application/subject details) to run — the bounded notice is all.
  if (d.visibility.operator !== 'full' || d.claim === null) {
    return (
      <div>
        <div className="mb-3">
          <Link href={`/p/${projectKey}/knowledge`} className="text-sm text-[var(--muted)] hover:underline">← Knowledge</Link>
        </div>
        <PageHeader title="Restricted Knowledge" subtitle="This record is not available to your account." />
        <Card title="Withheld">
          <p className="text-sm text-[var(--muted)]">A restricted Knowledge record exists but is not available to your account. Ask a workspace admin, or request the appropriate disclosure grant.</p>
        </Card>
      </div>
    );
  }

  const items = await withTenant(ctx, (tx) => listKnowledge(tx, ctx));
  const item = items.find((i) => i.id === itemId);
  const applications = await withTenant(ctx, (tx) => listInjectionsForKnowledge(tx, ctx, itemId));
  const isPendingProposal = ref.proposalReviewStatus === 'pending';
  const proposals = isPendingProposal ? await withTenant(ctx, (tx) => listKnowledgeProposals(tx, ctx, 'pending')) : [];
  const proposal = proposals.find((p) => p.knowledgeItemId === itemId) ?? null;
  // Sources are needed for a source-support judgment on a draft (proposals carry cited sources).
  const sources = item && item.status === 'draft' ? await withTenant(ctx, (tx) => listKnowledgeSources(tx, ctx, itemId, item.version)) : [];
  const verdictTone = d.currentUseVerdict.state === 'usable' ? 'var(--muted)' : d.currentUseVerdict.state === 'usable_with_qualification' ? 'var(--accent)' : 'var(--danger, #b45309)';

  return (
    <div>
      <div className="mb-3">
        <Link href={`/p/${projectKey}/knowledge`} className="text-sm text-[var(--muted)] hover:underline">← Knowledge</Link>
      </div>
      <PageHeader title={d.claim?.title ?? '(restricted — withheld from this view)'} subtitle="Evidence record — what is claimed, how it was formed, what supports it, and how far it may be relied on." />

      {/* 1. Claim */}
      <Section n={1} title="Claim">
        {d.claimGranularity === 'possibly_multiple' ? (
          <p className="mb-2 rounded border border-[var(--accent)] p-2 text-xs">This record may contain multiple independent claims — consider revising or splitting before relying on one verdict.</p>
        ) : null}
        <p className="whitespace-pre-wrap text-[var(--muted)]">{d.claim?.body ?? 'Withheld.'}</p>
      </Section>

      {/* 2. Current trust verdict */}
      <Section n={2} title="Current trust verdict">
        <p style={{ color: verdictTone }}>{d.currentUseVerdict.phrase}</p>
        <p className="mt-1 text-xs text-[var(--muted)]">For historical analysis: {d.historicalUseVerdict.phrase}.</p>
        {d.limitations.length > 0 ? (
          <ul className="mt-2 list-disc pl-5 text-xs text-[var(--muted)]">
            {d.limitations.map((l, i) => <li key={i}>{l}</li>)}
          </ul>
        ) : null}
      </Section>

      {/* 3. Formation */}
      <Section n={3} title="Formation">{d.formation.phrase} ({d.formation.epistemicBasis}).</Section>

      {/* 4. Provenance */}
      <Section n={4} title="Provenance">
        <p>{d.provenance.phrase}.</p>
        {d.availableEvidence.sources.length > 0 ? (
          <ul className="mt-2 space-y-1 text-xs text-[var(--muted)]">
            {d.availableEvidence.sources.map((s, i) => (
              <li key={i}>{s.label}{s.relied ? ' · relied upon' : ' · supplemental'} — {s.outcome}</li>
            ))}
          </ul>
        ) : null}
      </Section>

      {/* 5. Verification — deliberately separate from provenance; attachment ≠ support judgment. */}
      <Section n={5} title="Verification">
        <p>{d.verification.phrase} — {d.verification.events} recorded verification event{d.verification.events === 1 ? '' : 's'}.</p>
        <p className="mt-1 text-xs text-[var(--muted)]">Activation is not verification; attaching a source is not a support judgment.</p>
      </Section>

      {/* 6. Freshness */}
      <Section n={6} title="Freshness">{d.freshness.phrase}.</Section>

      {/* 7. Scope & relevance */}
      <Section n={7} title="Scope & relevance">
        <p>{d.scope.phrase}{d.scope.valid ? '' : ' — scope is invalid or closed'}.</p>
        <p className="mt-1 text-xs text-[var(--muted)]">{d.relevance.reason ? `Selected here because: ${d.relevance.reason}.` : 'Workspace scope means possible applicability — not automatic relevance to every task.'}</p>
      </Section>

      {/* 8. Disclosure */}
      <Section n={8} title="Disclosure">
        {d.disclosure.permitted ? 'Workspace-internal — disclosable to workspace consumers.' : `Restricted — ${d.disclosure.reason ?? 'not disclosable in this view'}.`}
      </Section>

      {/* 9. AI applications — a dispatch history, never "influence". Shows the FROZEN snapshot from
          dispatch alongside the current state; the two can legitimately differ. */}
      <Section n={9} title="AI applications">
        <p>{d.applications.phrase}.</p>
        {applications.length > 0 ? (
          <ul className="mt-2 space-y-2 text-xs text-[var(--muted)]">
            {applications.map((a, i) => {
              const dispatchProv = a.trustSnapshot?.provenanceState ?? null;
              const currentProv = d.provenance.state;
              return (
                <li key={i} className="rounded border border-[var(--border)] p-2">
                  <div>{a.consumerType} · v{a.version} · supplied {a.injectedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC{a.taskTitle ? ` · ${a.taskTitle}` : ''}</div>
                  {dispatchProv ? (
                    <div className="mt-1">
                      At dispatch: provenance <strong>{dispatchProv}</strong>
                      {dispatchProv !== currentProv ? <> · now: <strong>{currentProv}</strong> (the record has changed since it was supplied)</> : null}
                    </div>
                  ) : null}
                  {a.memoryText ? <details className="mt-1"><summary className="cursor-pointer">exact text supplied</summary><pre className="mt-1 whitespace-pre-wrap">{a.memoryText}</pre></details> : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </Section>

      {/* 10. Extraction & promotion (AI-proposed records only) */}
      {ref.proposalReviewStatus ? (
        <Section n={10} title="Extraction & promotion">
          <p>AI proposal — review status: {ref.proposalReviewStatus}. Suggested values are the AI&apos;s recommendation; the operator&apos;s explicit choices at promotion are recorded separately.</p>
        </Section>
      ) : null}

      {/* 12. Related decisions — never inferred. */}
      <Section n={12} title="Related decisions">{d.decisionRelationship.phrase}</Section>

      {/* 13. Actions — only valid, authorized controls for this record's lifecycle. */}
      {item ? (
        <Card title="Actions" className="mb-4">
          <div className="flex flex-wrap items-start gap-2">
            {isPendingProposal && proposal ? (
              <>
                <PromoteProposalForm projectKey={projectKey} proposalId={proposal.id} suggested={{ scopeKind: proposal.suggestedScopeKind, disclosure: proposal.suggestedDisclosure }} />
                <ReviseProposalForm projectKey={projectKey} proposalId={proposal.id} title={d.claim?.title ?? ''} claim={d.claim?.body ?? ''} />
                <SplitProposalForm projectKey={projectKey} proposalId={proposal.id} />
                <RejectProposalForm projectKey={projectKey} proposalId={proposal.id} />
                <SupportJudgmentForm projectKey={projectKey} itemId={item.id} sources={sources.map((s) => ({ id: s.id, label: s.sourceLabel }))} />
              </>
            ) : (
              <>
                <ReviseKnowledgeForm projectKey={projectKey} itemId={item.id} currentBody={item.body} />
                <KnowledgeStatusButtons projectKey={projectKey} itemId={item.id} status={item.status} />
                {item.status === 'active' ? <VerificationForm projectKey={projectKey} itemId={item.id} /> : null}
                {item.status === 'draft' && sources.length > 0 ? <SupportJudgmentForm projectKey={projectKey} itemId={item.id} sources={sources.map((s) => ({ id: s.id, label: s.sourceLabel }))} /> : null}
              </>
            )}
          </div>
          <p className="mt-3 text-xs text-[var(--muted)]">
            Source classification is managed in Documents. Disclosure grants for restricted Knowledge are managed in Governance — a restricted record is not a dead end.
          </p>
        </Card>
      ) : null}
    </div>
  );
}
