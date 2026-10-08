import 'server-only';
import { and, eq, lte } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { notificationPreferences } from '@/db/schema';
import { getDb } from '@/db/client';
import { withUser } from '@/db/tenant';
import { log } from '@/lib/log';
import { gateChannel } from './registry';
import { EMAIL_CHANNEL_ID } from './channels/email-resend';
import { getOrDefaultPreferences } from './preferences';
import { nextDigestAt } from './schedule';
import { finalizeMessage, insertMessageWithLinks, outcomeToStatus, resultRows } from './deliver';

/**
 * Send due digests — a few scheduled summaries, never one email per event. Each run batches a user's digest-routed
 * events into ONE message via the explicit message/message_events relation (contents always recoverable).
 *
 * Claim + no double-flush: the cursor advance `next_digest_at <= now → next` is a CONDITIONAL update, so two
 * workers racing the same user, only one matches and proceeds. The cursor is ADVANCED BEFORE the send (the
 * standing-tick invariant) so a crash never causes a catch-up storm. Fail-closed like the immediate path: email
 * disabled / channel not live / no address → the digest records `suppressed`, nothing is sent.
 */
export interface DigestDeps {
  readonly env?: Record<string, string | undefined>;
  readonly fetcher?: typeof fetch;
  readonly now?: () => Date;
  readonly limit?: number;
}

export interface DigestResult {
  users: number;
  sent: number;
  suppressed: number;
  empty: number;
  failed: number;
  ambiguous: number;
}

interface PendingDigestEvent {
  event_id: string;
  org_id: string;
  project_id: string;
  severity: string;
  title: string;
  body: string;
}

export async function flushDueDigests(deps: DigestDeps = {}): Promise<DigestResult> {
  const env = deps.env ?? process.env;
  const now = deps.now?.() ?? new Date();
  const limit = deps.limit ?? 50;
  const fetcher = deps.fetcher;
  const res: DigestResult = { users: 0, sent: 0, suppressed: 0, empty: 0, failed: 0, ambiguous: 0 };

  const due = resultRows<{ user_id: string }>(
    await getDb().execute(sql`select * from app.list_due_digest_users(${now.toISOString()}::timestamptz, ${limit})`),
  );

  for (const u of due) {
    res.users += 1;
    try {
      const outcome = await flushOneUser(u.user_id, env, now, fetcher);
      if (outcome === 'sent') res.sent += 1;
      else if (outcome === 'suppressed') res.suppressed += 1;
      else if (outcome === 'empty') res.empty += 1;
      else if (outcome === 'failed') res.failed += 1;
      else if (outcome === 'ambiguous') res.ambiguous += 1;
    } catch (err) {
      log.warn('digest flush failed (tick continues)', { userId: u.user_id, errorClass: err instanceof Error ? err.name : 'unknown' });
    }
  }
  return res;
}

type FlushOutcome = 'sent' | 'suppressed' | 'empty' | 'failed' | 'ambiguous' | 'skipped';

async function flushOneUser(userId: string, env: Record<string, string | undefined>, now: Date, fetcher?: typeof fetch): Promise<FlushOutcome> {
  // Phase 1 (tx): claim the cursor, gather events, and create the message (or suppress). No network inside.
  const decision = await withUser({ userId }, async (tx): Promise<{ kind: FlushOutcome; msgId?: string; address?: string; subject?: string; body?: string; key?: string }> => {
    const prefs = await getOrDefaultPreferences(tx, userId);
    const next = nextDigestAt(now, prefs.timezone, prefs.digestTimesLocal);
    // CONDITIONAL cursor advance = the claim. Only one worker matches; the advance happens BEFORE any send.
    const claimed = await tx
      .update(notificationPreferences)
      .set({ lastDigestAt: now, nextDigestAt: next, updatedAt: now })
      .where(and(eq(notificationPreferences.userId, userId), lte(notificationPreferences.nextDigestAt, now)))
      .returning({ userId: notificationPreferences.userId });
    if (claimed.length === 0) return { kind: 'skipped' }; // another worker owns this window

    const events = resultRows<PendingDigestEvent>(
      await tx.execute(sql`select * from app.list_pending_digest_events(${userId}::uuid, ${200})`),
    );
    if (events.length === 0) return { kind: 'empty' };

    const subject = `Your King AI Ops digest — ${events.length} update${events.length === 1 ? '' : 's'}`;
    const body = events.map((e) => `• [${e.severity}] ${e.title}\n  ${e.body}`).join('\n\n');
    const key = `digest:${userId}:${now.toISOString()}`;
    const links = events.map((e) => ({ orgId: e.org_id, projectId: e.project_id, eventId: e.event_id }));
    const common = { recipientUserId: userId, kind: 'digest' as const, idempotencyKey: key, subject, body, links };

    if (!prefs.emailEnabled) {
      await insertMessageWithLinks(tx, { ...common, status: 'suppressed', attemptCount: 0, lastAttemptAt: null, resultCode: 'email_disabled', resultDetail: { detail: 'owner disabled email notifications' }, sentAt: null });
      return { kind: 'suppressed' };
    }
    const gate = gateChannel(EMAIL_CHANNEL_ID, env, fetcher);
    if (!gate.channel) {
      await insertMessageWithLinks(tx, { ...common, status: 'suppressed', attemptCount: 0, lastAttemptAt: null, resultCode: gate.reason, resultDetail: { detail: `email channel not live: ${gate.reason}` }, sentAt: null });
      return { kind: 'suppressed' };
    }
    if (!prefs.emailAddress) {
      await insertMessageWithLinks(tx, { ...common, status: 'suppressed', attemptCount: 0, lastAttemptAt: null, resultCode: 'no_recipient_address', resultDetail: { detail: 'no email address on file' }, sentAt: null });
      return { kind: 'suppressed' };
    }
    const msgId = await insertMessageWithLinks(tx, { ...common, status: 'sending', attemptCount: 1, lastAttemptAt: now, resultCode: null, resultDetail: {}, sentAt: null });
    if (!msgId) return { kind: 'skipped' }; // key already used (another worker) — nothing to do
    return { kind: 'sent', msgId, address: prefs.emailAddress, subject, body, key };
  });

  if (decision.kind !== 'sent') return decision.kind;

  // Phase 2 (no tx): send.
  const gate = gateChannel(EMAIL_CHANNEL_ID, env, fetcher);
  let status = outcomeToStatus('blocked');
  let resultCode = 'not_configured';
  let detail = 'email channel not live at send';
  let sentAt: Date | null = null;
  let final: FlushOutcome = 'suppressed';
  if (gate.channel) {
    const out = await gate.channel.send({ recipientAddress: decision.address!, subject: decision.subject!, textBody: decision.body!, idempotencyKey: decision.key! });
    status = outcomeToStatus(out.outcome);
    resultCode = out.resultCode;
    detail = out.detail;
    if (out.outcome === 'sent') { sentAt = now; final = 'sent'; }
    else if (out.outcome === 'failed') final = 'failed';
    else if (out.outcome === 'ambiguous') final = 'ambiguous';
  }

  // Phase 3 (tx): record the outcome.
  await withUser({ userId }, (tx) => finalizeMessage(tx, decision.msgId!, userId, { status, resultCode, detail, sentAt }));
  return final;
}
