import Link from 'next/link';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { loadChatThread } from '@/domain/chat/chat';
import { Card, PageHeader } from '@/components/ui';
import { ChatClient } from './chat-client';

/**
 * Employee Chat (EV-004). Texting-style surface over the ordinary task/run
 * machinery: every message the owner sends becomes a governed run for this
 * employee; every reply is the run's recorded output. This page is a THIN
 * window onto that record — it holds no state of its own.
 */
export default async function EmployeeChatPage({
  params,
}: {
  params: Promise<{ projectKey: string; agentId: string }>;
}) {
  const { projectKey, agentId } = await params;
  const ctx = await requireTenant(projectKey);
  const thread = await withTenant(ctx, (tx) => loadChatThread(tx, ctx, agentId));

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader
        title={`Chat — ${thread.agentName}`}
        subtitle="Talk to this employee directly. Every exchange is a normal, budgeted, audited run."
      />
      <div className="flex items-center gap-4 text-sm">
        <Link href={`/p/${projectKey}/agents`} className="underline opacity-70 hover:opacity-100">
          ← Back to Employees
        </Link>
        <Link href={`/p/${projectKey}/agents/${agentId}/talk`} className="underline opacity-70 hover:opacity-100">
          🎤 Voice mode
        </Link>
      </div>
      <Card>
        <ChatClient
          projectKey={projectKey}
          agentId={agentId}
          entries={thread.entries.map((e) => ({
            id: e.id,
            role: e.role,
            content: e.content,
            at: e.createdAt.toISOString(),
          }))}
          awaitingReply={thread.awaitingReply}
        />
      </Card>
    </div>
  );
}
