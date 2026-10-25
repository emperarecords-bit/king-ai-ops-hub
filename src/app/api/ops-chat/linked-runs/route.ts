import { z } from 'zod';
import { AppError, toPublicMessage } from '@/lib/errors';
import { log } from '@/lib/log';
import { requireUser, tenantForUser } from '@/domain/auth/guard';
import { withUser } from '@/db/tenant';
import { conversationExists, listRunStartingCards } from '@/domain/opschat/conversations';
import { loadContinuityCards } from '@/domain/opschat/continuity';
import { completionEntries } from '@/domain/opschat/conversation-continuity';
import { type LinkedRunView } from '@/domain/opschat/linked-run-view';

/**
 * P5c-3 — GET /api/ops-chat/linked-runs?conversationId=<id>
 *
 * Live refresh for an open Ops Chat conversation: the current linked-run view of every confirmed dispatch / re-run /
 * update card in it, and one completion entry per finished run — so a run that finishes while the owner is looking
 * appears in the chat without them asking. Read-only, no model call, no governed action. Owner-private: the
 * conversation must be the caller's own (RLS + explicit user filter); workspace reads go through the membership gate.
 * The browser polls this only while the tab is visible and something it started can still change.
 */

const Query = z.object({ conversationId: z.string().uuid() });

export async function GET(req: Request): Promise<Response> {
  let userId: string;
  try {
    userId = (await requireUser()).id;
  } catch (err) {
    return Response.json({ error: toPublicMessage(err) }, { status: err instanceof AppError && err.code === 'unauthenticated' ? 401 : 403 });
  }
  const parsed = Query.safeParse({ conversationId: new URL(req.url).searchParams.get('conversationId') });
  if (!parsed.success) return Response.json({ error: 'Invalid request.' }, { status: 400 });
  const { conversationId } = parsed.data;
  try {
    const found = await withUser({ userId }, async (tx) => {
      if (!(await conversationExists(tx, userId, conversationId))) return null;
      return listRunStartingCards(tx, userId, conversationId);
    });
    // Another user's (or a non-existent) conversation is simply not found — never a hint that it exists.
    if (!found) return Response.json({ error: 'Not found.' }, { status: 404 });
    const cards = await loadContinuityCards(found, (key) => tenantForUser(userId, key));
    const views: Record<string, LinkedRunView> = {};
    for (const c of cards) if (c.view) views[c.proposalId] = c.view;
    return Response.json({ views, entries: completionEntries(cards) }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    log.warn('ops-chat linked-runs refresh failed', { errorClass: err instanceof Error ? err.name : 'unknown' });
    return Response.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}
