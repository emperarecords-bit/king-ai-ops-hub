import Link from 'next/link';
import { requireUser } from '@/domain/auth/guard';
import { withUser } from '@/db/tenant';
import { getOrDefaultPreferences } from '@/domain/notifications/preferences';
import { gateChannel } from '@/domain/notifications/registry';
import { EMAIL_CHANNEL_ID } from '@/domain/notifications/channels/email-resend';
import { Card, PageHeader } from '@/components/ui';
import { NotificationPrefsForm } from './notification-prefs-form';

const GATE_NOTE: Record<string, string> = {
  live: 'Email delivery is active on the server.',
  kill_switch: 'Email delivery is OFF — the server kill switch is engaged.',
  not_enabled: 'Email delivery is OFF — the server has not enabled the email channel (NOTIFICATIONS_ENABLED).',
  no_adapter: 'Email delivery is OFF — no adapter is registered.',
  not_configured: 'Email delivery is OFF — the server has no email credentials configured yet (EMAIL_API_KEY / EMAIL_FROM).',
};

/**
 * Owner notification preferences. User-scoped: a person edits only their own. The server-side delivery state is
 * shown read-only so the owner knows whether email is actually live — until the server enables + configures the
 * channel, everything is captured in-app but nothing is emailed (fail-closed by default).
 */
export default async function NotificationSettingsPage() {
  const user = await requireUser();
  const prefs = await withUser({ userId: user.id }, (tx) => getOrDefaultPreferences(tx, user.id));
  const gate = gateChannel(EMAIL_CHANNEL_ID);

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <PageHeader title="Notification settings" subtitle="How and when the Hub reaches you." />
      <div className="text-sm">
        <Link href="/inbox" className="underline opacity-70 hover:opacity-100">
          ← Inbox
        </Link>
      </div>

      <Card>
        <p className={`text-sm ${gate.reason === 'live' ? 'text-[var(--success)]' : 'text-[var(--muted)]'}`}>
          {GATE_NOTE[gate.reason] ?? `Email delivery state: ${gate.reason}`}
        </p>
      </Card>

      <Card>
        <NotificationPrefsForm
          initial={{
            emailEnabled: prefs.emailEnabled,
            emailAddress: prefs.emailAddress,
            emailOverride: prefs.emailOverride,
            timezone: prefs.timezone,
            quietHoursStartLocal: prefs.quietHoursStartLocal,
            quietHoursEndLocal: prefs.quietHoursEndLocal,
            digestTimesLocal: [...prefs.digestTimesLocal],
          }}
        />
      </Card>
    </div>
  );
}
