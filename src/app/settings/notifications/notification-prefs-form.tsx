'use client';

import { useActionState } from 'react';
import { saveNotificationPrefs, type PrefsFormState } from './actions';

const INITIAL: PrefsFormState = { error: null, saved: false };

export interface PrefsInitial {
  emailEnabled: boolean;
  emailAddress: string | null;
  emailOverride: string | null;
  timezone: string;
  quietHoursStartLocal: string | null;
  quietHoursEndLocal: string | null;
  digestTimesLocal: string[];
}

const field = 'w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm';
const labelCls = 'block text-xs font-semibold uppercase tracking-wide text-[var(--muted)]';

export function NotificationPrefsForm({ initial }: { initial: PrefsInitial }) {
  const [state, formAction, pending] = useActionState(saveNotificationPrefs, INITIAL);
  return (
    <form action={formAction} className="space-y-4">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="emailEnabled" defaultChecked={initial.emailEnabled} />
        Email me notifications
      </label>

      <div className="space-y-1">
        <label className={labelCls} htmlFor="emailOverride">
          Email address override
        </label>
        <input id="emailOverride" name="emailOverride" type="email" defaultValue={initial.emailOverride ?? ''} placeholder={initial.emailAddress ?? 'your@email.com'} className={field} />
        <p className="text-xs text-[var(--muted)]">Leave blank to use your account email ({initial.emailAddress ?? 'none on file'}).</p>
      </div>

      <div className="space-y-1">
        <label className={labelCls} htmlFor="timezone">
          Timezone (IANA)
        </label>
        <input id="timezone" name="timezone" type="text" defaultValue={initial.timezone} placeholder="America/New_York" className={field} />
        <p className="text-xs text-[var(--muted)]">Quiet hours and digest times are in this local wall-clock, so they don&apos;t shift with daylight saving.</p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className={labelCls} htmlFor="quietHoursStartLocal">Quiet hours start</label>
          <input id="quietHoursStartLocal" name="quietHoursStartLocal" type="text" defaultValue={initial.quietHoursStartLocal ?? ''} placeholder="22:00" className={field} />
        </div>
        <div className="space-y-1">
          <label className={labelCls} htmlFor="quietHoursEndLocal">Quiet hours end</label>
          <input id="quietHoursEndLocal" name="quietHoursEndLocal" type="text" defaultValue={initial.quietHoursEndLocal ?? ''} placeholder="07:00" className={field} />
        </div>
      </div>
      <p className="-mt-2 text-xs text-[var(--muted)]">Non-critical alerts wait until quiet hours end. Critical alerts (a run failed) always come through.</p>

      <div className="space-y-1">
        <label className={labelCls} htmlFor="digestTimesLocal">Digest times (local HH:MM, comma-separated)</label>
        <input id="digestTimesLocal" name="digestTimesLocal" type="text" defaultValue={initial.digestTimesLocal.join(', ')} placeholder="08:00, 18:00" className={field} />
        <p className="text-xs text-[var(--muted)]">Lower-priority updates are batched into these summaries instead of individual emails. Blank = no digest.</p>
      </div>

      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className="rounded bg-[var(--accent)] px-3 py-1.5 text-sm font-semibold text-[#0b0e14] disabled:opacity-60">
          {pending ? 'Saving…' : 'Save preferences'}
        </button>
        {state.saved ? <span className="text-sm text-[var(--success)]">Saved.</span> : null}
        {state.error ? <span className="text-sm text-[var(--danger)]">{state.error}</span> : null}
      </div>
    </form>
  );
}
