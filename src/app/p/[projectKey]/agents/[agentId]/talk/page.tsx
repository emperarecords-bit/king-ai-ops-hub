import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { loadChatThread } from '@/domain/chat/chat';
import { TalkClient } from './talk-client';

/**
 * Voice Mode — the same governed chat thread as /chat, presented as a phone-first conversation:
 * tap, talk, pause to send, hear the reply, talk again. A thin window; no state of its own.
 */
export default async function TalkPage({
  params,
}: {
  params: Promise<{ projectKey: string; agentId: string }>;
}) {
  const { projectKey, agentId } = await params;
  const ctx = await requireTenant(projectKey);
  const thread = await withTenant(ctx, (tx) => loadChatThread(tx, ctx, agentId));

  return (
    <div className="mx-auto max-w-lg">
      <h1 className="mb-1 text-lg font-semibold">{thread.agentName}</h1>
      <p className="mb-4 text-sm opacity-60">Voice conversation — every exchange is a normal, budgeted, audited run.</p>
      <TalkClient
        projectKey={projectKey}
        agentId={agentId}
        agentName={thread.agentName}
        entries={thread.entries.map((e) => ({ id: e.id, role: e.role, content: e.content, at: e.createdAt.toISOString() }))}
        awaitingReply={thread.awaitingReply}
      />
    </div>
  );
}
