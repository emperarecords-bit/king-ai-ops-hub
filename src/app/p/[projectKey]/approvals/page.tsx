import Link from 'next/link';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { expireStaleApprovals, listApprovalsForQueue, reconcileStrandedApprovalTasks, type QueueApprovalRow } from '@/domain/approvals/approvals';
import { executionRecordsForApprovals } from '@/domain/execution/execution-results';
import { assessConsequence, isInlineAuthorizable, readConsequence } from '@/domain/approvals/consequence';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { DecisionForm } from './decision-form';
import { ConsequenceLevelChip } from './consequence-view';

// Operator-facing authorization words (schema keeps approved/rejected).
const AUTHORIZATION_LABEL: Record<string, string> = {
  approved: 'Authorized · not executed',
  rejected: 'Refused',
  expired: 'Expired',
  withdrawn: 'Withdrawn',
};

function ts(d: Date): string {
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

function readRow(a: QueueApprovalRow) {
  const payload = (a.payload ?? {}) as Record<string, unknown>;
  const readout = readConsequence(assessConsequence({ type: a.actionType, summary: a.summary, payload }));
  // Inline authorization is allowed ONLY when nothing material is hidden from the compact reference.
  return { readout, inline: isInlineAuthorizable(readout, payload) };
}

/**
 * The authorization queue. Not a flat wall of two-button cards: pending requests whose consequence
 * can't be established are surfaced first as "needs clarification"; the rest are ordered
 * consequential-first, where only routine, workspace-internal actions offer a compact inline
 * decision — anything consequential must be opened and read before it can be authorized.
 */
export default async function ApprovalsPage({
  params,
}: {
  params: Promise<{ projectKey: string }>;
}) {
  const { projectKey } = await params;
  const ctx = await requireTenant(projectKey);

  const { rows, executions } = await withTenant(ctx, async (tx) => {
    await expireStaleApprovals(tx, ctx); // the queue never lies
    await reconcileStrandedApprovalTasks(tx, ctx); // no task stays "awaiting" once every proposal is decided
    const list = await listApprovalsForQueue(tx, ctx);
    // Durable execution outcomes (from the audit log) for everything already decided.
    const decidedIds = list.filter((a) => a.status !== 'pending').map((a) => a.id);
    return { rows: list, executions: await executionRecordsForApprovals(tx, ctx, decidedIds) };
  });

  const assessed = rows.map((a) => {
    const { readout, inline } = readRow(a);
    return { a, r: readout, inline };
  });
  const pending = assessed.filter((x) => x.a.status === 'pending');
  const needsClarification = pending.filter((x) => x.r.needsClarification);
  const awaiting = pending
    .filter((x) => !x.r.needsClarification)
    .sort((x, y) => Number(y.r.level === 'consequential') - Number(x.r.level === 'consequential'));
  const decided = assessed.filter((x) => x.a.status !== 'pending');

  return (
    <div>
      <PageHeader
        title="Authorization queue"
        subtitle="Where autonomous intent crosses into authority you grant. Nothing is authorized without your explicit decision, and every decision is audited."
      />

      <p className="mb-6 rounded-md border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-sm text-[var(--muted)]">
        <span className="font-medium text-[var(--foreground)]">Authorizing can execute.</span>{' '}
        Actions with a live executor (currently: pull requests) are carried out by the Hub the moment
        you authorize them, and the outcome is recorded below. Everything else records authorization
        only — execution for those still happens separately.
      </p>

      {needsClarification.length > 0 ? (
        <Card title={`Needs clarification (${needsClarification.length})`} className="mb-6 border-[#6b5a3d]">
          <p className="mb-3 text-xs text-[var(--muted)]">
            Pending — but the Hub cannot establish the material consequence. Read before deciding.
          </p>
          <ul className="space-y-3">
            {needsClarification.map(({ a, r }) => (
              <QueueReference key={a.id} projectKey={projectKey} a={a} r={r} inline={false} />
            ))}
          </ul>
        </Card>
      ) : null}

      <Card title={`Awaiting authorization (${awaiting.length})`} className="mb-6">
        {awaiting.length === 0 ? (
          <EmptyState>No actions awaiting authorization.</EmptyState>
        ) : (
          <ul className="space-y-3">
            {awaiting.map(({ a, r, inline }) => (
              <QueueReference key={a.id} projectKey={projectKey} a={a} r={r} inline={inline} />
            ))}
          </ul>
        )}
      </Card>

      <Card title={`Decided (${decided.length})`}>
        {decided.length === 0 ? (
          <EmptyState>No history yet.</EmptyState>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {decided.map(({ a }) => {
              const exec = executions.get(a.id);
              return (
                <li key={a.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                  <div className="min-w-0">
                    <Link href={`/p/${projectKey}/approvals/${a.id}`} className="hover:text-[var(--accent)]">
                      <span className="font-mono text-xs text-[var(--muted)]">{a.actionType}</span>{' '}
                      <span className="truncate">{a.summary}</span>
                    </Link>
                    {a.decisionNote ? <p className="text-xs text-[var(--muted)]">note: {a.decisionNote}</p> : null}
                    {exec?.outcome === 'succeeded' && exec.prUrl ? (
                      <p className="text-xs">
                        <a href={exec.prUrl} target="_blank" rel="noreferrer" className="text-[var(--success)] underline">
                          Executed — pull request #{exec.prNumber} ↗
                        </a>
                      </p>
                    ) : null}
                  </div>
                  <span
                    className={`shrink-0 rounded px-2 py-0.5 text-xs ${
                      exec?.outcome === 'succeeded'
                        ? 'bg-[var(--surface-raised)] text-[var(--success)]'
                        : exec
                          ? 'bg-[var(--surface-raised)] text-amber-400'
                          : 'bg-[var(--surface-raised)] text-[var(--muted)]'
                    }`}
                  >
                    {exec
                      ? exec.outcome === 'succeeded'
                        ? 'Executed'
                        : `Execution ${exec.outcome}`
                      : (AUTHORIZATION_LABEL[a.status] ?? a.status)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

/** A concise queue reference — operator language and originating context, not raw JSON. */
function QueueReference({
  projectKey,
  a,
  r,
  inline,
}: {
  projectKey: string;
  a: QueueApprovalRow;
  r: ReturnType<typeof readConsequence>;
  inline: boolean;
}) {
  return (
    <li className="rounded-md border border-[var(--border)] p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-[var(--muted)]">{a.actionType}</span>
        <Link href={`/p/${projectKey}/approvals/${a.id}`} className="text-sm font-medium hover:text-[var(--accent)]">
          {a.summary}
        </Link>
        <ConsequenceLevelChip readout={r} />
        <span className="ml-auto text-xs text-[var(--muted)]">expires {ts(a.expiresAt)}</span>
      </div>
      <p className="mt-1 text-xs text-[var(--muted)]">
        {r.summary}
      </p>
      <p className="mt-1 text-xs text-[var(--muted)]">
        From{' '}
        <Link href={`/p/${projectKey}/tasks/${a.taskId}`} className="text-[var(--accent)]">
          {a.taskTitle}
        </Link>
        {a.objectiveTitle ? ` · toward ${a.objectiveTitle}` : ''} · owner {a.ownerName ?? 'unowned'}
      </p>
      {inline ? (
        <DecisionForm projectKey={projectKey} approvalId={a.id} />
      ) : (
        <Link
          href={`/p/${projectKey}/approvals/${a.id}`}
          className="mt-3 inline-block rounded-md border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--foreground)]"
        >
          Open to review &amp; decide →
        </Link>
      )}
    </li>
  );
}
