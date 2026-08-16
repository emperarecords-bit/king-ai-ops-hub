'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { toPublicMessage } from '@/lib/errors';
import { log } from '@/lib/log';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { sendChatMessage } from '@/domain/chat/chat';
import { claimJobForTask, runClaimedJob } from '@/domain/jobs/jobs';

export interface ChatFormState {
  error: string | null;
  sentAt: number | null;
}

const schema = z.object({
  projectKey: z.string().min(1),
  agentId: z.string().uuid(),
  content: z.string().trim().min(1).max(8_000),
});

/**
 * Send one chat message. The run is kicked inline (claim + run without waiting
 * on the worker's poll cycle) exactly like the task form's submit path, so a
 * chat reply starts within seconds; the durable queue remains the net if this
 * process dies mid-run.
 */
export async function sendChatMessageAction(
  _prev: ChatFormState,
  formData: FormData,
): Promise<ChatFormState> {
  const parsed = schema.safeParse({
    projectKey: formData.get('projectKey'),
    agentId: formData.get('agentId'),
    content: formData.get('content'),
  });
  if (!parsed.success) return { error: 'Message is empty or too long.', sentAt: null };
  const { projectKey, agentId, content } = parsed.data;

  try {
    const ctx = await requireTenant(projectKey);
    // Chat runs are real (billed) tasks: read-only viewers observe, they don't spend.
    if (ctx.projectRole === 'viewer') return { error: 'Viewers cannot send messages.', sentAt: null };
    const { taskId } = await withTenant(ctx, (tx) => sendChatMessage(tx, ctx, { agentId, content }));
    revalidatePath(`/p/${projectKey}/agents/${agentId}/chat`);

    // Fire-and-forget inline kick — mirrors the task form's immediate-start path.
    void (async () => {
      try {
        const claimed = await claimJobForTask(ctx, taskId);
        if (claimed) await runClaimedJob(claimed);
      } catch (err) {
        log.warn('chat inline kick failed; worker will pick the job up', {
          taskId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    return { error: null, sentAt: Date.now() };
  } catch (err) {
    return { error: toPublicMessage(err), sentAt: null };
  }
}
