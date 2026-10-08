'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { AppError, toPublicMessage } from '@/lib/errors';
import { log } from '@/lib/log';
import { requireUser } from '@/domain/auth/guard';
import { withUser } from '@/db/tenant';
import { updatePreferences } from '@/domain/notifications/preferences';

export interface PrefsFormState {
  error: string | null;
  saved: boolean;
}

const schema = z.object({
  emailEnabled: z.boolean(),
  emailOverride: z.string().max(200),
  timezone: z.string().min(1).max(64),
  quietHoursStartLocal: z.string().max(5),
  quietHoursEndLocal: z.string().max(5),
  digestTimesLocal: z.string().max(200),
});

/** Update the signed-in owner's OWN notification preferences. User-scoped (withUser); RLS gates the row. */
export async function saveNotificationPrefs(_prev: PrefsFormState, formData: FormData): Promise<PrefsFormState> {
  const parsed = schema.safeParse({
    emailEnabled: formData.get('emailEnabled') === 'on' || formData.get('emailEnabled') === 'true',
    emailOverride: formData.get('emailOverride') ?? '',
    timezone: formData.get('timezone') ?? 'UTC',
    quietHoursStartLocal: formData.get('quietHoursStartLocal') ?? '',
    quietHoursEndLocal: formData.get('quietHoursEndLocal') ?? '',
    digestTimesLocal: formData.get('digestTimesLocal') ?? '',
  });
  if (!parsed.success) return { error: 'Invalid request.', saved: false };
  const d = parsed.data;
  const startLocal = d.quietHoursStartLocal.trim() === '' ? null : d.quietHoursStartLocal.trim();
  const endLocal = d.quietHoursEndLocal.trim() === '' ? null : d.quietHoursEndLocal.trim();
  const digestTimesLocal = d.digestTimesLocal
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  try {
    const user = await requireUser();
    await withUser({ userId: user.id }, (tx) =>
      updatePreferences(tx, user.id, {
        emailEnabled: d.emailEnabled,
        emailOverride: d.emailOverride.trim() === '' ? null : d.emailOverride.trim(),
        timezone: d.timezone.trim(),
        quietHoursStartLocal: startLocal,
        quietHoursEndLocal: endLocal,
        digestTimesLocal,
      }),
    );
  } catch (err) {
    if (!(err instanceof AppError)) log.error('saveNotificationPrefs failed', { err });
    return { error: toPublicMessage(err), saved: false };
  }
  revalidatePath('/settings/notifications');
  return { error: null, saved: true };
}
