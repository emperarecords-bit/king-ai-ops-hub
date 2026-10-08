import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { withUser } from '@/db/tenant';
import { log } from '@/lib/log';
import { gateChannel } from './registry';
import { EMAIL_CHANNEL_ID } from './channels/email-resend';
import { getOrDefaultPreferences } from './preferences';
import { inQuietHours } from './schedule';
import { finalizeMessage, insertMessageWithLinks, outcomeToStatus, resultRows } from './deliver';

/**
 * Deliver due IMMEDIATE notifications (critical / action_required). Fail-closed by default: if the email channel
 * is not live (kill switch, not enabled, no key, no sender) OR the owner disabled email OR no address is on file,
 * the message is recorded `suppressed` and NOTHING is sent. Quiet hours defer ONLY action_required (critical
 * bypasses) by leaving the event pending — it is re-evaluated each tick and sends once the window ends.
 *
 * Concurrency + at-most-once: a 'sending' message keyed (recipient, "email:<eventId>") is the claim token, so two
 * workers racing the same event send at most once. The send runs OUTSIDE the DB transaction (no tx held across a
 * network call); the stable idempotency key means even a crash-and-repick cannot double-deliver at the provider.
 * A timeout / 5xx is recorded `ambiguous` and never auto-retried.
 */
export interface RouterDeps {
  readonly env?: Record<string, string | undefined>;
  readonly fetcher?: typeof fetch;
  readonly now?: () => Date;
  readonly limit?: number;
}

export interface RouterResult {
  processed: number;
  sent: number;
  deferred: number;
  suppressed: number;
  failed: number;
  ambiguous: number;
}

interface PendingImmediate {
  event_id: string;
  org_id: string;
  project_id: string;
  recipient_user_id: string;
  severity: string;
  title: string;
  body: string;
}

export async function routeDueNotifications(deps: RouterDeps = {}): Promise<RouterResult> {
  const env = deps.env ?? process.env;
  const now = deps.now?.() ?? new Date();
  const limit = deps.limit ?? 50;
  const fetcher = deps.fetcher;
  const res: RouterResult = { processed: 0, sent: 0, deferred: 0, suppressed: 0, failed: 0, ambiguous: 0 };

  const listed = await getDb().execute(
    sql`select * from app.list_pending_immediate_notifications(${now.toISOString()}::timestamptz, ${limit})`,
  );
  const rows = resultRows<PendingImmediate>(listed);

  for (const ev of rows) {
    res.processed += 1;
    const idempotencyKey = `email:${ev.event_id}`;
    const links = [{ orgId: ev.org_id, projectId: ev.project_id, eventId: ev.event_id }];
    try {
      // Phase 1 (tx): decide + (suppress-record OR claim). No network inside the tx.
      const decision = await withUser({ userId: ev.recipient_user_id }, async (tx) => {
        const prefs = await getOrDefaultPreferences(tx, ev.recipient_user_id);
        const common = { recipientUserId: ev.recipient_user_id, kind: 'immediate' as const, idempotencyKey, subject: ev.title, body: ev.body, links };

        if (!prefs.emailEnabled) {
          await insertMessageWithLinks(tx, { ...common, status: 'suppressed', attemptCount: 0, lastAttemptAt: null, resultCode: 'email_disabled', resultDetail: { detail: 'owner disabled email notifications' }, sentAt: null });
          return { kind: 'suppressed' as const };
        }
        if (ev.severity === 'action_required' && inQuietHours(now, prefs.timezone, prefs.quietHoursStartLocal, prefs.quietHoursEndLocal)) {
          return { kind: 'deferred' as const }; // leave pending; re-evaluated next tick (critical would NOT defer)
        }
        const gate = gateChannel(EMAIL_CHANNEL_ID, env, fetcher);
        if (!gate.channel) {
          await insertMessageWithLinks(tx, { ...common, status: 'suppressed', attemptCount: 0, lastAttemptAt: null, resultCode: gate.reason, resultDetail: { detail: `email channel not live: ${gate.reason}` }, sentAt: null });
          return { kind: 'suppressed' as const };
        }
        if (!prefs.emailAddress) {
          await insertMessageWithLinks(tx, { ...common, status: 'suppressed', attemptCount: 0, lastAttemptAt: null, resultCode: 'no_recipient_address', resultDetail: { detail: 'no email address on file' }, sentAt: null });
          return { kind: 'suppressed' as const };
        }
        // Claim: insert a 'sending' message. If another worker already owns the key, do nothing.
        const msgId = await insertMessageWithLinks(tx, { ...common, status: 'sending', attemptCount: 1, lastAttemptAt: now, resultCode: null, resultDetail: {}, sentAt: null });
        if (!msgId) return { kind: 'already_claimed' as const };
        return { kind: 'send' as const, msgId, address: prefs.emailAddress };
      });

      if (decision.kind === 'suppressed') { res.suppressed += 1; continue; }
      if (decision.kind === 'deferred') { res.deferred += 1; continue; }
      if (decision.kind === 'already_claimed') continue;

      // Phase 2 (no tx): send. Re-gate in case the policy changed between claim and send.
      const gate = gateChannel(EMAIL_CHANNEL_ID, env, fetcher);
      let status: ReturnType<typeof outcomeToStatus>;
      let resultCode: string;
      let detail: string;
      let sentAt: Date | null = null;
      if (!gate.channel) {
        status = 'suppressed';
        resultCode = gate.reason;
        detail = `email channel not live at send: ${gate.reason}`;
      } else {
        const out = await gate.channel.send({ recipientAddress: decision.address, subject: ev.title, textBody: ev.body, idempotencyKey });
        status = outcomeToStatus(out.outcome);
        resultCode = out.resultCode;
        detail = out.detail;
        if (out.outcome === 'sent') sentAt = now;
      }

      // Phase 3 (tx): record the terminal outcome.
      await withUser({ userId: ev.recipient_user_id }, (tx) => finalizeMessage(tx, decision.msgId, ev.recipient_user_id, { status, resultCode, detail, sentAt }));
      if (status === 'sent') res.sent += 1;
      else if (status === 'failed') res.failed += 1;
      else if (status === 'ambiguous') res.ambiguous += 1;
      else res.suppressed += 1;
    } catch (err) {
      // One event's failure never stops the tick. A claimed-but-unfinalized 'sending' message stays that way and
      // is NOT re-sent (its message_events link already excludes the event from the pending list).
      log.warn('notification delivery failed (tick continues)', { eventId: ev.event_id, errorClass: err instanceof Error ? err.name : 'unknown' });
    }
  }
  return res;
}
