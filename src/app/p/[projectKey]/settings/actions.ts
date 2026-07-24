'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { AppError, toPublicMessage } from '@/lib/errors';
import { log } from '@/lib/log';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { setWorkspaceArchived, updateWorkspaceSettings } from '@/domain/projects/settings';

export interface SettingsFormState {
  error: string | null;
  saved: boolean;
}

const settingsSchema = z.object({
  projectKey: z.string().min(1),
  name: z.string().min(1).max(100),
  description: z.string().max(1_000),
  monthlyBudgetUsd: z.coerce.number().finite(),
});

export async function saveWorkspaceSettings(
  _prev: SettingsFormState,
  formData: FormData,
): Promise<SettingsFormState> {
  const parsed = settingsSchema.safeParse({
    projectKey: formData.get('projectKey'),
    name: formData.get('name'),
    description: formData.get('description') ?? '',
    monthlyBudgetUsd: formData.get('monthlyBudgetUsd'),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid input.', saved: false };
  }

  try {
    const ctx = await requireTenant(parsed.data.projectKey);
    await withTenant(ctx, (tx) =>
      updateWorkspaceSettings(tx, ctx, {
        name: parsed.data.name,
        description: parsed.data.description,
        monthlyBudgetUsd: parsed.data.monthlyBudgetUsd,
      }),
    );
  } catch (err) {
    if (!(err instanceof AppError)) log.error('saveWorkspaceSettings failed', { err });
    return { error: toPublicMessage(err), saved: false };
  }

  // The name shows in the header, the briefing, and the workspace picker.
  revalidatePath(`/p/${parsed.data.projectKey}`, 'layout');
  revalidatePath('/projects');
  return { error: null, saved: true };
}

export async function archiveWorkspace(
  _prev: SettingsFormState,
  formData: FormData,
): Promise<SettingsFormState> {
  const projectKey = String(formData.get('projectKey') ?? '');
  const archived = formData.get('archived') === 'true';
  if (!projectKey) return { error: 'Invalid request.', saved: false };

  try {
    const ctx = await requireTenant(projectKey);
    await withTenant(ctx, (tx) => setWorkspaceArchived(tx, ctx, archived));
  } catch (err) {
    if (!(err instanceof AppError)) log.error('archiveWorkspace failed', { err });
    return { error: toPublicMessage(err), saved: false };
  }

  revalidatePath('/projects');
  // Archiving removes it from the picker; staying on its settings page would
  // be a dead end. Restoring keeps you where you are.
  if (archived) redirect('/projects');
  revalidatePath(`/p/${projectKey}/settings`);
  return { error: null, saved: true };
}
