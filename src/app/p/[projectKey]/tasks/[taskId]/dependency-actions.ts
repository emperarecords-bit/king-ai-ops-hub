'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { AppError, toPublicMessage } from '@/lib/errors';
import { log } from '@/lib/log';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { addDependency, removeDependency } from '@/domain/dependencies/dependencies';

export interface DependencyState {
  error: string | null;
}

const uuid = z.string().uuid();

/** "This task is blocked by <prerequisite>" — records prerequisite → this task. */
export async function addDependencyAction(
  _prev: DependencyState,
  formData: FormData,
): Promise<DependencyState> {
  const projectKey = String(formData.get('projectKey') ?? '');
  const dependentTaskId = String(formData.get('taskId') ?? '');
  const prerequisiteTaskId = String(formData.get('prerequisiteTaskId') ?? '');
  const kind = String(formData.get('kind') ?? 'prerequisite');
  if (!uuid.safeParse(dependentTaskId).success || !uuid.safeParse(prerequisiteTaskId).success) {
    return { error: 'Pick a prerequisite task.' };
  }
  try {
    const ctx = await requireTenant(projectKey);
    await withTenant(ctx, (tx) =>
      addDependency(tx, ctx, {
        dependentTaskId,
        prerequisiteTaskId,
        kind: kind === 'blocks' ? 'blocks' : 'prerequisite',
      }),
    );
  } catch (err) {
    if (!(err instanceof AppError)) log.error('addDependency failed', { err });
    return { error: toPublicMessage(err) };
  }
  revalidatePath(`/p/${projectKey}/tasks/${dependentTaskId}`);
  return { error: null };
}

export async function removeDependencyAction(
  _prev: DependencyState,
  formData: FormData,
): Promise<DependencyState> {
  const projectKey = String(formData.get('projectKey') ?? '');
  const dependentTaskId = String(formData.get('taskId') ?? '');
  const prerequisiteTaskId = String(formData.get('prerequisiteTaskId') ?? '');
  if (!uuid.safeParse(dependentTaskId).success || !uuid.safeParse(prerequisiteTaskId).success) {
    return { error: 'Invalid request.' };
  }
  try {
    const ctx = await requireTenant(projectKey);
    await withTenant(ctx, (tx) => removeDependency(tx, ctx, { dependentTaskId, prerequisiteTaskId }));
  } catch (err) {
    if (!(err instanceof AppError)) log.error('removeDependency failed', { err });
    return { error: toPublicMessage(err) };
  }
  revalidatePath(`/p/${projectKey}/tasks/${dependentTaskId}`);
  return { error: null };
}
