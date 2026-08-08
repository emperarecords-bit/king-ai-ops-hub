import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { getApprovalDetail } from '@/domain/approvals/approvals';
import { assessConsequence, readConsequence } from '@/domain/approvals/consequence';
import { NotFoundError } from '@/lib/errors';
import { currentEpochMs } from '@/lib/clock';
import { Card, PageHeader } from '@/components/ui';
import { Breadcrumb } from '../../breadcrumb';
import { ConsequenceReadPanel, ConsequenceLevelChip } from '../consequence-view';
import { AuthorizeForm } from '../authorize-form';
import { WithdrawForm } from '../withdraw-form';
import { ExecutorFoundationStatus } from '../executor-status';

const AUTHORIZATION_LABEL: Record<string, string> = {
  pending: 'Proposed — awaiting your decision',
  approved: 'Authorized',
  rejected: 'Refused',
  expired: 'Expired before decision',
  withdrawn: 'Withdrawn',
};

function ts(d: Date): string {
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * The authorization decision surface (Approvals detail). Conducts the conversation in order: the
 * exact authority requested → why it was proposed → established consequences → the three lifecycles →
 * integrity & validity → the decision → and, once decided, the durable authorization record.
 */
export default async function ApprovalDetailPage({
  params,
}: {
  params: Promise<{ projectKey: string; approvalId: string }>;
}) {
  const { projectKey, approvalId } = await params;
  const ctx = await requireTenant(projectKey);
  const isAdmin = ctx.projectRole === 'admin';

  let a;
  try {
    a = await withTenant(ctx, (tx) => getApprovalDetail(tx, ctx, approvalId));
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }

  const payload = (a.payload ?? {}) as Record<string, unknown>;
  const profile = assessConsequence({ type: a.actionType, summary: a.summary, payload });
  const readout = readConsequence(profile);
  const pending = a.status === 'pending';
  const expired = pending && a.expiresAt.getTime() < currentEpochMs();

  // Three distinct lifecycles — the operator must never infer whether the action actually happened.
  const aiWork = a.taskStatus === 'completed' ? 'Finished' : a.taskStatus.replaceAll('_', ' ');
  const authorizationState = AUTHORIZATION_LABEL[a.status] ?? a.status;
  const executionState = a.status === 'approved' ? 'Authorized, not executed — live execution disabled' : 'Not started';

  return (
    <div className="mx-auto max-w-3xl">
      <Breadcrumb leaf={a.summary} />
      <PageHeader
        title="Authorization request"
        subtitle={`${a.actionType} · ${a.objectiveTitle ? `toward ${a.objectiveTitle}` : 'operational'}`}
        action={<ConsequenceLevelChip readout={readout} />}
      />

      {/* §1 — The exact authority requested. */}
      <Card title="The authority you're being asked to grant" className="mb-6">
        <p className="text-[15px] leading-relaxed">{a.summary}</p>
        <p className="mt-2 text-xs text-[var(--muted)]">
          Authorizing grants exactly this — the action shown with these parameters — and nothing broader.
        </p>
      </Card>

      {/* §2 — Why it was proposed (explain, don't advocate). */}
      <Card title="Why this was proposed" className="mb-6">
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-[var(--muted)]">Originating task</dt>
            <dd>
              <Link href={`/p/${projectKey}/tasks/${a.taskId}`} className="text-[var(--accent)]">
                {a.taskTitle}
              </Link>
            </dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--muted)]">Objective</dt>
            <dd>
              {a.objectiveId ? (
                <Link href={`/p/${projectKey}/objectives/${a.objectiveId}`} className="text-[var(--accent)]">
                  {a.objectiveTitle}
                </Link>
              ) : (
                <span className="text-[var(--muted)]">Operational — not tied to an objective</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--muted)]">Accountable owner</dt>
            <dd>{a.ownerName ?? 'unowned'}</dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--muted)]">Proposed by</dt>
            <dd>the assigned agent{a.requestedBy ? ` (${a.requestedBy})` : ''}</dd>
          </div>
        </dl>
      </Card>

      {/* §3 — Established consequences (evidence only). */}
      <Card title="Consequences" className="mb-6">
        <p className="mb-3 text-sm text-[var(--muted)]">{readout.summary}</p>
        <ConsequenceReadPanel profile={profile} />
      </Card>

      {/* §4 — The three lifecycles, kept distinct. */}
      <Card title="State" className="mb-6">
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-[var(--muted)]">AI work</dt>
            <dd className="capitalize">{aiWork}</dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--muted)]">Authorization</dt>
            <dd>
              {authorizationState}
              {a.decidedByName ? ` by ${a.decidedByName}` : ''}
              {a.decidedAt ? ` on ${ts(a.decidedAt)}` : ''}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--muted)]">Action execution</dt>
            <dd>{executionState}</dd>
          </div>
        </dl>
      </Card>

      <Card title="Executor boundary" className="mb-6">
        <ExecutorFoundationStatus actionType={a.actionType} />
      </Card>

      {/* §5 — Integrity & validity. */}
      <Card title="Integrity & validity" className="mb-6">
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-[var(--muted)]">Proposed</dt>
            <dd>{ts(a.createdAt)}</dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--muted)]">Decision deadline</dt>
            <dd>{ts(a.expiresAt)}{expired ? ' — passed' : ''}</dd>
          </div>
        </dl>
        {a.originatingTaskCancelled ? (
          <p className="mt-3 text-sm text-[var(--danger)]">
            The originating task was cancelled — this authorization is no longer valid to grant.
          </p>
        ) : null}
        {a.hasPendingDuplicate ? (
          <p className="mt-3 text-sm text-[var(--warning,#c99a3a)]">
            An identical authorization request (same action and payload) is already pending. Authorizing
            both would grant the same external action twice.
          </p>
        ) : null}
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-[var(--muted)]">Exact payload &amp; integrity hash</summary>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded bg-[var(--background)] p-3 font-mono text-xs">
            {JSON.stringify(a.payload, null, 2)}
          </pre>
          <p className="mt-1 font-mono text-[10px] text-[var(--muted)]">sha256 {a.payloadSha256}</p>
        </details>
      </Card>

      {/* §6 / §7 — Decision, or the durable record once decided. */}
      {pending && !expired ? (
        <Card title="Your decision">
          {isAdmin ? (
            <AuthorizeForm
              projectKey={projectKey}
              approvalId={a.id}
              requireConfirmation={readout.level === 'consequential' || readout.needsClarification}
              confirmLabel={`I authorize this ${a.actionType}: ${a.summary}`}
            />
          ) : (
            <p className="text-sm text-[var(--muted)]">Only project admins can decide authorizations.</p>
          )}
        </Card>
      ) : (
        <Card title="Authorization record">
          <p className="text-sm">
            <span className="font-medium">{authorizationState}</span>
            {a.decidedByName ? ` by ${a.decidedByName}` : ''}
            {a.decidedAt ? ` on ${ts(a.decidedAt)}` : ''}.
          </p>
          {a.decisionNote ? (
            <p className="mt-2 text-sm">
              <span className="text-[var(--muted)]">Rationale: </span>
              {a.decisionNote}
            </p>
          ) : null}
          {a.status === 'approved' ? (
            <p className="mt-2 text-xs text-[var(--muted)]">
              Authorized, not executed — the Phase 3 foundation permits validation and preview only. No
              live executor capability is enabled.
            </p>
          ) : null}
          <p className="mt-3 text-xs text-[var(--muted)]">
            Full technical history is in the{' '}
            <Link href={`/p/${projectKey}/audit`} className="text-[var(--accent)]">
              audit log
            </Link>
            .
          </p>
          {a.status === 'approved' && isAdmin ? (
            <WithdrawForm projectKey={projectKey} approvalId={a.id} />
          ) : null}
        </Card>
      )}
    </div>
  );
}
