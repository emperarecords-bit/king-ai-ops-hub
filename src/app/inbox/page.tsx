import Link from 'next/link';
import { listMyProjectsWithOrgRoles } from '@/domain/auth/guard';
import { ownerInbox } from '@/domain/inbox/inbox';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { InboxDecisionForm } from './inbox-decision-form';

/**
 * The Owner Inbox (EV-011 follow-up): every pending approval, every business,
 * one stack, oldest first. The owner's day as "things to okay". Each card is
 * decided through the ordinary per-workspace authority path — this page adds
 * visibility, never privilege.
 */
export default async function InboxPage() {
  const { user, projects, orgRoles } = await listMyProjectsWithOrgRoles();
  const inbox = await ownerInbox(user.id, projects, orgRoles);

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <PageHeader
        title="Inbox"
        subtitle={
          inbox.items.length === 0
            ? `Nothing needs your okay — checked ${inbox.workspacesChecked} businesses.`
            : `${inbox.items.length} thing${inbox.items.length === 1 ? '' : 's'} waiting for your okay across ${inbox.workspacesWithPending} business${inbox.workspacesWithPending === 1 ? '' : 'es'}.`
        }
      />
      <div className="text-sm">
        <Link href="/projects" className="underline opacity-70 hover:opacity-100">
          ← Morning Briefing
        </Link>
      </div>

      {inbox.items.length === 0 ? (
        <EmptyState>
          All clear. When an employee proposes something consequential — sending, publishing, spending, changing
          code — it appears here and waits for you.
        </EmptyState>
      ) : (
        inbox.items.map((item) => (
          <Card key={item.approvalId}>
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
                <span className="rounded bg-[var(--surface-raised)] px-2 py-0.5 text-[var(--foreground)]">
                  {item.workspaceName}
                </span>
                <span className="rounded border border-[var(--border)] px-2 py-0.5">{item.actionType}</span>
                {item.employeeName ? <span>from {item.employeeName}</span> : null}
                <span>· waiting since {item.createdAt.toISOString().slice(0, 16).replace('T', ' ')} UTC</span>
              </div>
              <div className="text-sm font-semibold">
                <Link href={`/p/${item.projectKey}/approvals/${item.approvalId}`} className="hover:underline">
                  {item.summary}
                </Link>
              </div>
              <div className="text-xs text-[var(--muted)]">
                Task:{' '}
                <Link href={`/p/${item.projectKey}/tasks/${item.taskId}`} className="underline">
                  {item.taskTitle}
                </Link>
              </div>
              <InboxDecisionForm projectKey={item.projectKey} approvalId={item.approvalId} />
            </div>
          </Card>
        ))
      )}
    </div>
  );
}
