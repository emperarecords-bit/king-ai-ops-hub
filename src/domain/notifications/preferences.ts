import 'server-only';
import { eq } from 'drizzle-orm';
import { notificationPreferences, profiles } from '@/db/schema';
import { type DbTx } from '@/db/client';
import { ValidationError } from '@/lib/errors';
import { parseLocalTime, nextDigestAt } from './schedule';

/** The effective preferences the router/digest act on. `emailAddress` is RESOLVED at read time (override, else the
 *  live profile email) — the override is never a copy of the profile email. */
export interface EffectiveNotificationPrefs {
  readonly userId: string;
  readonly emailEnabled: boolean;
  readonly emailAddress: string | null;
  readonly emailOverride: string | null;
  readonly timezone: string;
  readonly quietHoursStartLocal: string | null;
  readonly quietHoursEndLocal: string | null;
  readonly digestTimesLocal: readonly string[];
  readonly lastDigestAt: Date | null;
  readonly nextDigestAt: Date | null;
}

export async function getOrDefaultPreferences(tx: DbTx, userId: string): Promise<EffectiveNotificationPrefs> {
  const prof = (await tx.select({ email: profiles.email }).from(profiles).where(eq(profiles.id, userId)).limit(1))[0];
  const row = (await tx.select().from(notificationPreferences).where(eq(notificationPreferences.userId, userId)).limit(1))[0];
  const override = row?.emailOverride ?? null;
  return {
    userId,
    emailEnabled: row?.emailEnabled ?? true,
    emailAddress: override ?? prof?.email ?? null,
    emailOverride: override,
    timezone: row?.timezone ?? 'UTC',
    quietHoursStartLocal: row?.quietHoursStartLocal ?? null,
    quietHoursEndLocal: row?.quietHoursEndLocal ?? null,
    digestTimesLocal: row?.digestTimesLocal ?? [],
    lastDigestAt: row?.lastDigestAt ?? null,
    nextDigestAt: row?.nextDigestAt ?? null,
  };
}

export interface NotificationPrefsPatch {
  readonly emailEnabled?: boolean;
  readonly emailOverride?: string | null;
  readonly timezone?: string;
  readonly quietHoursStartLocal?: string | null;
  readonly quietHoursEndLocal?: string | null;
  readonly digestTimesLocal?: readonly string[];
}

function assertTimezone(tz: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new ValidationError([`Unknown timezone: ${tz}`]);
  }
}

/**
 * Upsert the caller's OWN preferences. RLS gates the row to `app.current_user_id()`, so a user can only ever write
 * their own. Validates timezone + "HH:MM" formats + quiet-hours pairing, and recomputes `nextDigestAt` from the
 * (possibly new) digest times + timezone so the worker's cursor stays consistent.
 */
export async function updatePreferences(
  tx: DbTx,
  userId: string,
  patch: NotificationPrefsPatch,
  now: Date = new Date(),
): Promise<void> {
  const current = await getOrDefaultPreferences(tx, userId);
  const timezone = patch.timezone ?? current.timezone;
  assertTimezone(timezone);

  const startLocal = patch.quietHoursStartLocal !== undefined ? patch.quietHoursStartLocal : current.quietHoursStartLocal;
  const endLocal = patch.quietHoursEndLocal !== undefined ? patch.quietHoursEndLocal : current.quietHoursEndLocal;
  if ((startLocal === null) !== (endLocal === null)) {
    throw new ValidationError(['Quiet hours need both a start and an end, or neither.']);
  }
  for (const t of [startLocal, endLocal]) {
    if (t !== null && parseLocalTime(t) === null) throw new ValidationError([`Quiet-hours time must be HH:MM, got "${t}".`]);
  }

  const digestTimesLocal = (patch.digestTimesLocal ?? current.digestTimesLocal).slice();
  for (const t of digestTimesLocal) {
    if (parseLocalTime(t) === null) throw new ValidationError([`Digest time must be HH:MM, got "${t}".`]);
  }
  if (digestTimesLocal.length > 6) throw new ValidationError(['At most 6 digest times.']);

  const emailOverride = patch.emailOverride !== undefined ? patch.emailOverride : current.emailOverride;
  if (emailOverride !== null && emailOverride !== undefined) {
    const v = emailOverride.trim();
    if (v.length === 0 || v.length > 200 || !v.includes('@')) throw new ValidationError(['Email override must be a valid address or empty.']);
  }

  const computedNextDigest = nextDigestAt(now, timezone, digestTimesLocal);

  await tx
    .insert(notificationPreferences)
    .values({
      userId,
      emailEnabled: patch.emailEnabled ?? current.emailEnabled,
      emailOverride: emailOverride && emailOverride.trim() !== '' ? emailOverride.trim() : null,
      timezone,
      quietHoursStartLocal: startLocal,
      quietHoursEndLocal: endLocal,
      digestTimesLocal,
      nextDigestAt: computedNextDigest,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: notificationPreferences.userId,
      set: {
        emailEnabled: patch.emailEnabled ?? current.emailEnabled,
        emailOverride: emailOverride && emailOverride.trim() !== '' ? emailOverride.trim() : null,
        timezone,
        quietHoursStartLocal: startLocal,
        quietHoursEndLocal: endLocal,
        digestTimesLocal,
        nextDigestAt: computedNextDigest,
        updatedAt: now,
      },
    });
}
