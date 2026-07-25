'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { FLAGSHIP_CATEGORIES } from '@/types/domain';
import { AppError, toPublicMessage, ValidationError } from '@/lib/errors';
import { log } from '@/lib/log';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { listAssignableEmployees } from '@/domain/agents/agents';
import { cancelTask, createTask } from '@/domain/tasks/tasks';
import { claimJobForTask, enqueueRun, runClaimedJob } from '@/domain/jobs/jobs';

export interface TaskFormState {
  error: string | null;
}

const formSchema = z
  .object({
    projectKey: z.string().min(1),
    title: z.string().trim().min(1).max(200),
    input: z.string().trim().min(1).max(32_000),
    /** The employee performing the work (Sprint 5, assignee-first). */
    assigneeAgentId: z.string().uuid(),
    reviewEnabled: z.boolean(),
    flagship: z.boolean(),
    flagshipCategory: z.enum(FLAGSHIP_CATEGORIES).nullable(),
    objectiveId: z.string().uuid().nullable(),
  })
  .refine((v) => !v.flagship || v.flagshipCategory != null, {
    message: 'Flagship runs must declare a category from the reserved list.',
  });

export async function submitTask(_prev: TaskFormState, formData: FormData): Promise<TaskFormState> {
  const rawCategory = formData.get('flagshipCategory');
  const rawObjective = formData.get('objectiveId');
  const parsed = formSchema.safeParse({
    projectKey: formData.get('projectKey'),
    title: formData.get('title'),
    input: formData.get('input'),
    assigneeAgentId: formData.get('assigneeAgentId'),
    reviewEnabled: formData.get('reviewEnabled') === 'on',
    flagship: formData.get('flagship') === 'on',
    flagshipCategory: rawCategory ? String(rawCategory) : null,
    objectiveId: rawObjective ? String(rawObjective) : null,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }

  let taskId: string;
  try {
    // requireTenant resolves the KEY server-side — the client never names ids.
    const ctx = await requireTenant(parsed.data.projectKey);
    taskId = await withTenant(ctx, async (tx) => {
      // The assignee determines the leading vendor; the cross-check partner
      // is derived from it (D-005). The picker is validated server-side.
      const employees = await listAssignableEmployees(tx, ctx);
      const assignee = employees.find((e) => e.id === parsed.data.assigneeAgentId);
      if (!assignee) {
        throw new ValidationError(['Pick who should perform this work.']);
      }
      return createTask(tx, ctx, {
        title: parsed.data.title,
        input: parsed.data.input,
        providerSelection: assignee.provider,
        reviewEnabled: parsed.data.reviewEnabled,
        modelTier: parsed.data.flagship ? 'flagship' : 'standard',
        flagshipCategory: parsed.data.flagship ? parsed.data.flagshipCategory : null,
        objectiveId: parsed.data.objectiveId,
      });
    });
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
    // Durable execution (O-21): enqueue a job, then claim + run it inline so the
    // request still gets a result, while the persisted job makes the run
    // recoverable if this process dies mid-run. If a worker already claimed it,
    // we no-op and the page shows the worker's result.
    await withTenant(ctx, (tx) => enqueueRun(tx, ctx, taskId));
    const job = await claimJobForTask(ctx, taskId);
    if (job) await runClaimedJob(job);
  } catch (err) {
    if (!(err instanceof AppError)) log.error('runTask failed', { err, taskId });
    return { error: toPublicMessage(err) };
  }

  revalidatePath(`/p/${projectKey}/tasks/${taskId}`);
  return { error: null };
}

/**
 * Ends a task the owner no longer wants (LIFECYCLE-AUDIT). Cancelling is not
 * deletion: messages, costs, and audit rows stay, because money may already
 * have been spent and history is append-only.
 */
export async function cancelTaskAction(
  _prev: RunActionState,
  formData: FormData,
): Promise<RunActionState> {
  const projectKey = String(formData.get('projectKey') ?? '');
  const taskId = String(formData.get('taskId') ?? '');
  if (!projectKey || !z.string().uuid().safeParse(taskId).success) {
    return { error: 'Invalid request.' };
  }

  try {
    const ctx = await requireTenant(projectKey);
    await withTenant(ctx, (tx) => cancelTask(tx, ctx, taskId));
  } catch (err) {
    if (!(err instanceof AppError)) log.error('cancelTask failed', { err, taskId });
    return { error: toPublicMessage(err) };
  }

  revalidatePath(`/p/${projectKey}/tasks/${taskId}`);
  revalidatePath(`/p/${projectKey}`);
  return { error: null };
}
