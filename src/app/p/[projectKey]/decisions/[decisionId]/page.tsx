import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { getDecisionDetail } from '@/domain/decisions/decisions';
import { INACTIVE_LABEL } from '@/domain/decisions/assess';
import { listObjectives } from '@/domain/objectives/objectives';
import { NotFoundError } from '@/lib/errors';
import { Card, PageHeader } from '@/components/ui';
import { Breadcrumb } from '../../breadcrumb';
import { ReviewDecision, RetireButton } from '../decision-forms';

const SCOPE_LABEL: Record<string, string> = { task: 'This task', objective: 'An objective', workspace: 'Whole workspace' };
const REASON_WORD: Record<string, string> = { task: 'same task', objective: 'same objective', reference: 'shared supporting reference' };
const ACTION_LABEL: Record<string, string> = { proposed: 'Proposed', accepted: 'Accepted', rejected: 'Refused', retired: 'Retired', superseded: 'Superseded' };

function ts(d: Date): string {
  return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}
function eventWord(action: string): string {
  return ACTION_LABEL[action.replace('decision.', '')] ?? action.replace('decision.', '');
}

export default async function DecisionDetailPage({ params }: { params: Promise<{ projectKey: string; decisionId: string }> }) {
  const { projectKey, decisionId } = await params;
  const ctx = await requireTenant(projectKey);
  const isAdmin = ctx.projectRole === 'admin';
  const base = `/p/${projectKey}`;

  let d;
  let objectives;
  try {
    ({ d, objectives } = await withTenant(ctx, async (tx) => ({
      d: await getDecisionDetail(tx, ctx, decisionId),
      objectives: await listObjectives(tx, ctx),
    })));
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }

  const a = d.assessment;
  const accepted = d.lifecycle.find((e) => e.action === 'decision.accepted');
  const refused = d.lifecycle.find((e) => e.action === 'decision.rejected');
  const retired = d.lifecycle.find((e) => e.action === 'decision.retired');

  return (
    <div className="mx-auto max-w-3xl">
      <Breadcrumb leaf={d.title} />
      <PageHeader
        title={d.title}
        subtitle={
          a.memoryRole === 'guidance'
            ? a.isActiveGuidance
              ? `Active guidance · ${(SCOPE_LABEL[d.scope] ?? '').toLowerCase()}`
              : `Guidance · ${a.inactiveReason ? INACTIVE_LABEL[a.inactiveReason] : 'inactive'}`
            : a.recordStatus === 'proposed'
              ? 'Proposed — awaiting review'
              : 'Record only — preserved memory'
        }
      />

      {/* 1–3 · Conclusion, rationale, evidence */}
      <Card title="Conclusion" className="mb-6">
        <p className="text-[15px] leading-relaxed">{d.summary}</p>
        {d.rationale ? (
          <>
            <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Rationale</h3>
            <p className="mt-1 text-sm">{d.rationale}</p>
          </>
        ) : null}
        <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Evidence & references</h3>
        {d.supportingRefs.filter((r) => !r.startsWith('supersedes:')).length > 0 ? (
          <ul className="mt-1 list-inside list-disc text-sm text-[var(--muted)]">
            {d.supportingRefs.filter((r) => !r.startsWith('supersedes:')).map((r) => <li key={r}>{r}</li>)}
          </ul>
        ) : (
          <p className="mt-1 text-sm text-[var(--muted)]">No supporting references recorded.</p>
        )}
        {d.suggestionReason ? <p className="mt-2 text-xs text-[var(--muted)]">AI evidence note: {d.suggestionReason}</p> : null}
      </Card>

      {/* 4–5 · Provenance & authority */}
      <Card title="Provenance & authority" className="mb-6">
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-[var(--muted)]">Proposed by</dt>
            <dd>
              {d.authorLabel}
              {d.originatingTaskId ? (
                <> · from <Link href={`${base}/tasks/${d.originatingTaskId}`} className="text-[var(--accent)]">{d.originatingTaskTitle ?? 'a task'}</Link></>
              ) : null}
              {' '}· {ts(d.createdAt)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--muted)]">Accepted by</dt>
            <dd>{accepted ? `${accepted.actorName ?? 'unknown'} · ${ts(accepted.at)}` : 'no recorded acceptance event'}</dd>
          </div>
          {refused ? (
            <div>
              <dt className="text-xs text-[var(--muted)]">Refused by</dt>
              <dd>{refused.actorName ?? 'unknown'} · {ts(refused.at)}{refused.reason ? ` — ${refused.reason}` : ''}</dd>
            </div>
          ) : null}
          {retired ? (
            <div>
              <dt className="text-xs text-[var(--muted)]">Retired by</dt>
              <dd>{retired.actorName ?? 'unknown'} · {ts(retired.at)}{retired.reason ? ` — ${retired.reason}` : ''}</dd>
            </div>
          ) : null}
          {d.suggestedApplicability ? (
            <div>
              <dt className="text-xs text-[var(--muted)]">AI suggestion</dt>
              <dd className="text-[var(--info)]">{d.suggestedApplicability}{d.suggestedScope ? ` · ${d.suggestedScope}` : ''}{d.suggestionConfidence ? ` · ${d.suggestionConfidence} confidence` : ''} — evidence, not authority</dd>
            </div>
          ) : null}
        </dl>
      </Card>

      {/* 6–9 · Memory role, scope, effective period, active state */}
      <Card title="Memory role" className="mb-6">
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-[var(--muted)]">Role</dt>
            <dd>{a.memoryRole === 'guidance' ? 'Active guidance' : 'Record only'}</dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--muted)]">State</dt>
            <dd className={a.isActiveGuidance ? 'text-[var(--success)]' : ''}>
              {a.isActiveGuidance ? 'Active' : a.inactiveReason ? INACTIVE_LABEL[a.inactiveReason] : 'inactive'}
            </dd>
          </div>
          {a.memoryRole === 'guidance' ? (
            <>
              <div>
                <dt className="text-xs text-[var(--muted)]">Scope</dt>
                <dd>{SCOPE_LABEL[d.scope]}{d.scope === 'task' ? ` — ${d.scopeTaskTitle ?? '(missing task)'}` : d.scope === 'objective' ? ` — ${d.scopeObjectiveTitle ?? '(missing objective)'}` : ''}</dd>
              </div>
              <div>
                <dt className="text-xs text-[var(--muted)]">Effective period</dt>
                <dd>{d.effectiveUntil ? `Through ${ts(d.effectiveUntil)}` : 'Open-ended (reviewable)'}</dd>
              </div>
            </>
          ) : null}
        </dl>
      </Card>

      {/* 10 · History */}
      {(d.supersedesTitle || d.supersededByTitle || d.lifecycle.length > 0) ? (
        <Card title="Lifecycle history" className="mb-6">
          {d.supersedesTitle ? <p className="text-sm">Supersedes: <span className="text-[var(--muted)]">{d.supersedesTitle}</span> (now historical).</p> : null}
          {d.supersededByTitle ? <p className="text-sm">Superseded by: <span className="text-[var(--muted)]">{d.supersededByTitle}</span>.</p> : null}
          <ul className="mt-2 space-y-1 text-sm">
            {d.lifecycle.map((e, i) => (
              <li key={i} className="text-[var(--muted)]">
                {eventWord(e.action)}{e.actorName ? ` by ${e.actorName}` : ''} · {ts(e.at)}{e.reason ? ` — ${e.reason}` : ''}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {/* 11–12 · Decision Memory applications + exact text supplied */}
      <Card title={`Decision Memory applications (${d.applications.length})`} className="mb-6">
        <p className="mb-3 text-xs text-[var(--muted)]">Runs where this guidance was supplied to the AI — an injection record, not a claim of influence.</p>
        {d.applications.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">Not yet supplied to any run.</p>
        ) : (
          <ul className="space-y-3">
            {d.applications.map((app, i) => (
              <li key={i} className="rounded border border-[var(--border)] p-3 text-sm">
                <div className="text-xs text-[var(--muted)]">
                  {app.taskTitle ? app.taskTitle : 'a task'} · qualified by {REASON_WORD[app.reason] ?? app.reason} · {ts(app.injectedAt)}
                </div>
                {app.memoryText ? (
                  <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded bg-[var(--background)] p-2 font-mono text-xs">{app.memoryText}</pre>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* 13 · Shared applicability (observed overlap, not conflict) */}
      {d.sharesApplicabilityWith.length > 0 ? (
        <Card title="Shared applicability" className="mb-6">
          <p className="text-sm text-[var(--muted)]">
            Multiple active guidance decisions apply to this objective. This is an observed overlap, not a
            conflict — they may all apply without tension.
          </p>
          <ul className="mt-2 list-inside list-disc text-sm">
            {d.sharesApplicabilityWith.map((s) => (
              <li key={s.id}><Link href={`${base}/decisions/${s.id}`} className="text-[var(--accent)]">{s.title}</Link></li>
            ))}
          </ul>
        </Card>
      ) : null}

      {/* 14 · Valid current actions */}
      {isAdmin && a.actions.length > 0 ? (
        <Card title="Actions">
          {a.recordStatus === 'proposed' ? (
            <ReviewDecision projectKey={projectKey} decisionId={d.id} objectives={objectives.map((o) => ({ id: o.id, title: o.title }))} />
          ) : a.actions.includes('retire') ? (
            <RetireButton projectKey={projectKey} decisionId={d.id} />
          ) : (
            <p className="text-sm text-[var(--muted)]">To change this decision, file a superseding decision (broader or materially changed guidance is a new, traceable decision).</p>
          )}
        </Card>
      ) : null}
    </div>
  );
}
