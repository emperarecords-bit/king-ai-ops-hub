'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { AppError, toPublicMessage } from '@/lib/errors';
import { log } from '@/lib/log';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { deleteSecret, upsertSecret } from '@/domain/integrations/secrets';

export interface SecretFormState {
  error: string | null;
  saved: boolean;
}

const upsertSchema = z.object({
  projectKey: z.string().min(1),
  name: z.string().min(2).max(64),
  value: z.string().min(4).max(4096),
});

export async function saveSecret(_prev: SecretFormState, formData: FormData): Promise<SecretFormState> {
  const parsed = upsertSchema.safeParse({
    projectKey: formData.get('projectKey'),
    name: formData.get('name'),
    value: formData.get('value'),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid input.', saved: false };
  }

  try {
    const ctx = await requireTenant(parsed.data.projectKey);
    await withTenant(ctx, (tx) =>
      upsertSecret(tx, ctx, { name: parsed.data.name, value: parsed.data.value }),
    );
  } catch (err) {
    if (!(err instanceof AppError)) log.error('upsertSecret failed', { err });
    return { error: toPublicMessage(err), saved: false };
  }

  revalidatePath(`/p/${parsed.data.projectKey}/providers`);
  return { error: null, saved: true };
}

const deleteSchema = z.object({
  projectKey: z.string().min(1),
  secretId: z.string().uuid(),
});

export async function removeSecret(_prev: SecretFormState, formData: FormData): Promise<SecretFormState> {
  const parsed = deleteSchema.safeParse({
    projectKey: formData.get('projectKey'),
    secretId: formData.get('secretId'),
  });
  if (!parsed.success) return { error: 'Invalid request.', saved: false };

  try {
    const ctx = await requireTenant(parsed.data.projectKey);
    await withTenant(ctx, (tx) => deleteSecret(tx, ctx, parsed.data.secretId));
  } catch (err) {
    if (!(err instanceof AppError)) log.error('deleteSecret failed', { err });
    return { error: toPublicMessage(err), saved: false };
  }

  revalidatePath(`/p/${parsed.data.projectKey}/providers`);
  return { error: null, saved: true };
}
