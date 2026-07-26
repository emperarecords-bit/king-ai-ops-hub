'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { AppError, toPublicMessage } from '@/lib/errors';
import { log } from '@/lib/log';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { createWorkItem, updateWorkItem } from '@/domain/work/work-items';

export interface WorkItemState {
  error: string | null;
}

const optionalId = z
  .string()
  .transform((v) => (v.trim() === '' ? null : v))
  .refine((v) => v === null || /^[0-9a-f-]{36}$/i.test(v), 'Invalid selection.');

const createSchema = z.object({
  projectKey: z.string().min(1),
  title: z.string().trim().min(1, 'Title is required').max(200),
  stage: z.string().trim().max(60).optional(),
  notes: z.string().max(8_000).optional(),
  objectiveId: optionalId,
});

const updateSchema = z.object({
  projectKey: z.string().min(1),
  workItemId: z.string().uuid(),
  title: z.string().trim().min(1, 'Title is required').max(200),
  stage: z.string().trim().max(60),
  notes: z.string().max(8_000),
});

/** Create a human work item. Any non-viewer member may create one. */
export async function createWorkItemAction(
  _prev: WorkItemState,
  formData: FormData,
): Promise<WorkItemState> {
  const parsed = createSchema.safeParse({
    projectKey: formData.get('projectKey'),
    title: formData.get('title'),
    stage: formData.get('stage') ?? undefined,
    notes: formData.get('notes') ?? undefined,
    objectiveId: formData.get('objectiveId') ?? '',
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  try {
    const ctx = await requireTenant(parsed.data.projectKey);
    if (ctx.projectRole === 'viewer') return { error: 'Viewers cannot create work items.' };
    await withTenant(ctx, (tx) =>
      createWorkItem(tx, ctx, {
        title: parsed.data.title,
        stage: parsed.data.stage ?? 'New',
        notes: parsed.data.notes ?? '',
        objectiveId: parsed.data.objectiveId,
      }),
    );
  } catch (err) {
    if (!(err instanceof AppError)) log.error('createWorkItem failed', { err });
    return { error: toPublicMessage(err) };
  }
  revalidatePath(`/p/${parsed.data.projectKey}/work`);
  return { error: null };
}

/** Edit a work item's title / stage / notes in place. */
export async function updateWorkItemAction(
  _prev: WorkItemState,
  formData: FormData,
): Promise<WorkItemState> {
  const parsed = updateSchema.safeParse({
    projectKey: formData.get('projectKey'),
    workItemId: formData.get('workItemId'),
    title: formData.get('title'),
    stage: formData.get('stage'),
    notes: formData.get('notes'),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  try {
    const ctx = await requireTenant(parsed.data.projectKey);
    if (ctx.projectRole === 'viewer') return { error: 'Viewers cannot edit work items.' };
    await withTenant(ctx, (tx) =>
      updateWorkItem(tx, ctx, parsed.data.workItemId, {
        title: parsed.data.title,
        stage: parsed.data.stage,
        notes: parsed.data.notes,
      }),
    );
  } catch (err) {
    if (!(err instanceof AppError)) log.error('updateWorkItem failed', { err });
    return { error: toPublicMessage(err) };
  }
  revalidatePath(`/p/${parsed.data.projectKey}/work`);
  return { error: null };
}
