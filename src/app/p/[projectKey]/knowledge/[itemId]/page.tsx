import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { loadKnowledgeDetail } from '@/domain/knowledge/detail';
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

  // ONE gated loader (access resolved + sensitive queries gated at retrieval).
  const view = await withTenant(ctx, (tx) => loadKnowledgeDetail(tx, ctx, itemId));
  if (!view) notFound();

  if (!view.visible) {
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

  const { ref, item, applications, sources, proposal } = view;
  const d = ref.descriptor;
  const isPendingProposal = ref.proposalReviewStatus === 'pending';
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

      {/* 4. Provenance — current resolution up front; exact hashes behind progressive disclosure. */}
      <Section n={4} title="Provenance">
        <p>{d.provenance.phrase}.</p>
        {d.availableEvidence.sources.length > 0 ? (
          <ul className="mt-2 space-y-1 text-xs text-[var(--muted)]">
            {d.availableEvidence.sources.map((s, i) => (
              <li key={i}>{s.label}{s.relied ? ' · relied upon' : ' · supplemental'} — {s.outcome}</li>
            ))}
          </ul>
        ) : null}
        {sources.length > 0 ? (
          <details className="mt-2 text-xs text-[var(--muted)]">
            <summary className="cursor-pointer">technical provenance (exact versions)</summary>
            <ul className="mt-1 space-y-1">
              {sources.map((s, i) => (
                <li key={i}>
                  {s.sourceLabel} · {s.transformation} · sha256 {s.sourceVersionHash ?? '—'}
                  {s.locator ? ` · “${s.locator}”` : ''}
                </li>
              ))}
            </ul>
          </details>
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

      {/* 8. Disclosure — the INSTITUTIONAL grant state; a live grant here is not per-operation permission. */}
      <Section n={8} title="Disclosure">
        {ref.restrictedGrantState === null
          ? 'Workspace-internal — disclosable to workspace consumers.'
          : ref.restrictedGrantState === 'granted'
            ? `Restricted · disclosure grant on file — ${d.disclosure.reason ?? 'a bounded agent and purpose are authorized'}. Whether a particular AI operation may receive it still depends on that operation's execution identities.`
            : `Restricted · ${d.disclosure.reason ?? 'no currently usable disclosure grant is recorded'}.`}
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

      {/* 13. Actions — ONLY controls valid for this record's exact lifecycle. A pending proposal gets the
          review controls; an active record gets revise/archive/confirm-dispute; a manual draft gets
          activate/discard (+ support judgment when it cites sources). An archived/rejected/split record
          gets none (a split parent is therefore unpromotable). */}
      {item && (isPendingProposal || item.status === 'active' || item.status === 'draft') ? (
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
            ) : item.status === 'active' ? (
              <>
                <ReviseKnowledgeForm projectKey={projectKey} itemId={item.id} currentBody={item.body} />
                <KnowledgeStatusButtons projectKey={projectKey} itemId={item.id} status={item.status} />
                <VerificationForm projectKey={projectKey} itemId={item.id} />
              </>
            ) : (
              /* manual draft (not an AI proposal) */
              <>
                <KnowledgeStatusButtons projectKey={projectKey} itemId={item.id} status={item.status} />
                {sources.length > 0 ? <SupportJudgmentForm projectKey={projectKey} itemId={item.id} sources={sources.map((s) => ({ id: s.id, label: s.sourceLabel }))} /> : null}
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
