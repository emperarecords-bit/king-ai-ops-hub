'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { FLAGSHIP_CATEGORIES } from '@/types/domain';
import { PROVIDER_SELECTIONS } from '@/types/provider';
import { AppError, toPublicMessage } from '@/lib/errors';
import { log } from '@/lib/log';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { createTask } from '@/domain/tasks/tasks';
import { startRun } from '@/domain/tasks/runner';

export interface TaskFormState {
  error: string | null;
}

const formSchema = z
  .object({
    projectKey: z.string().min(1),
    title: z.string().trim().min(1).max(200),
    input: z.string().trim().min(1).max(32_000),
    providerSelection: z.enum(PROVIDER_SELECTIONS),
    reviewEnabled: z.boolean(),
    flagship: z.boolean(),
    flagshipCategory: z.enum(FLAGSHIP_CATEGORIES).nullable(),
  })
  .refine((v) => !v.flagship || v.flagshipCategory != null, {
    message: 'Flagship runs must declare a category from the reserved list.',
  });

export async function submitTask(_prev: TaskFormState, formData: FormData): Promise<TaskFormState> {
  const rawCategory = formData.get('flagshipCategory');
  const parsed = formSchema.safeParse({
    projectKey: formData.get('projectKey'),
    title: formData.get('title'),
    input: formData.get('input'),
    providerSelection: formData.get('providerSelection'),
    reviewEnabled: formData.get('reviewEnabled') === 'on',
    flagship: formData.get('flagship') === 'on',
    flagshipCategory: rawCategory ? String(rawCategory) : null,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }

  let taskId: string;
  try {
    // requireTenant resolves the KEY server-side — the client never names ids.
    const ctx = await requireTenant(parsed.data.projectKey);
    taskId = await withTenant(ctx, (tx) =>
      createTask(tx, ctx, {
        title: parsed.data.title,
        input: parsed.data.input,
        providerSelection: parsed.data.providerSelection,
        reviewEnabled: parsed.data.reviewEnabled,
        modelTier: parsed.data.flagship ? 'flagship' : 'standard',
        flagshipCategory: parsed.data.flagship ? parsed.data.flagshipCategory : null,
      }),
    );
  } catch (err) {
    if (!(err instanceof AppError)) log.error('createTask failed', { err });
    return { error: toPublicMessage(err) };
  }

  redirect(`/p/${parsed.data.projectKey}/tasks/${taskId}?autorun=1`);
}

export interface RunActionState {
  error: string | null;
}

export async function runTask(_prev: RunActionState, formData: FormData): Promise<RunActionState> {
  const projectKey = String(formData.get('projectKey') ?? '');
  const taskId = String(formData.get('taskId') ?? '');
  if (!projectKey || !z.string().uuid().safeParse(taskId).success) {
    return { error: 'Invalid request.' };
  }

  try {
    const ctx = await requireTenant(projectKey);
    await startRun(ctx, taskId);
  } catch (err) {
    if (!(err instanceof AppError)) log.error('startRun failed', { err, taskId });
    return { error: toPublicMessage(err) };
  }

  revalidatePath(`/p/${projectKey}/tasks/${taskId}`);
  return { error: null };
}
