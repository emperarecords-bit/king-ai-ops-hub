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
import { cancelTask, createTask, supersedeTask } from '@/domain/tasks/tasks';
import { manuallyReconcileTask } from '@/domain/approvals/approvals';
import {
  attachTaskToObjective,
  detachTaskFromObjective,
  moveTaskToObjective,
} from '@/domain/objectives/task-link';
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
  const reason = String(formData.get('reason') ?? '');
  if (!projectKey || !z.string().uuid().safeParse(taskId).success) {
    return { error: 'Invalid request.' };
  }

  try {
    const ctx = await requireTenant(projectKey);
    await withTenant(ctx, (tx) => cancelTask(tx, ctx, taskId, reason));
  } catch (err) {
    if (!(err instanceof AppError)) log.error('cancelTask failed', { err, taskId });
    return { error: toPublicMessage(err) };
  }

  revalidatePath(`/p/${projectKey}/tasks/${taskId}`);
  revalidatePath(`/p/${projectKey}`);
  return { error: null };
}

// ---------------------------------------------------------------------------
// HUB-002 — recovery controls for stale / obsolete / unexecutable tasks.
//
// These are admin-only, reason-required paths that reuse audited domain
// functions. They deliberately do NOT reimplement state transitions in the UI;
// each delegates to a single domain call that owns the guard rails and audit.
// ---------------------------------------------------------------------------

const recoverSchema = z.object({
  projectKey: z.string().min(1),
  taskId: z.string().uuid(),
  reason: z.string().trim().min(1, 'A reason is required.').max(1000),
});

/**
 * Cancel a stale task as a recovery action — stops it without deleting history.
 * Unlike the quick cancel on the run panel, recovery requires a written reason
 * (admin authority is enforced downstream). Reuses the same audited cancelTask.
 */
export async function cancelTaskRecoveryAction(
  _prev: RunActionState,
  formData: FormData,
): Promise<RunActionState> {
  const parsed = recoverSchema.safeParse({
    projectKey: formData.get('projectKey'),
    taskId: formData.get('taskId'),
    reason: formData.get('reason'),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid request.' };

  try {
    const ctx = await requireTenant(parsed.data.projectKey);
    if (ctx.projectRole !== 'admin') {
      throw new AppError('forbidden', 'Only an admin can run recovery actions.');
    }
    await withTenant(ctx, (tx) => cancelTask(tx, ctx, parsed.data.taskId, parsed.data.reason));
  } catch (err) {
    if (!(err instanceof AppError)) log.error('cancelTaskRecovery failed', { err });
    return { error: toPublicMessage(err) };
  }

  revalidatePath(`/p/${parsed.data.projectKey}/tasks/${parsed.data.taskId}`);
  revalidatePath(`/p/${parsed.data.projectKey}`);
  return { error: null };
}

// ---------------------------------------------------------------------------
// HUB-003 — the canonical objective↔task relationship. These change the single
// FK through audited domain functions (never a raw UI update), enforcing
// workspace + admin authority and a reason when re-attributing completed work.
// ---------------------------------------------------------------------------

/** Revalidate every surface that reads the objective relationship, so it can never go stale (req #7). */
function revalidateObjectiveSurfaces(projectKey: string, taskId: string, objectiveId?: string | null): void {
  revalidatePath(`/p/${projectKey}/tasks/${taskId}`);
  revalidatePath(`/p/${projectKey}/work`);
  revalidatePath(`/p/${projectKey}/objectives`);
  revalidatePath(`/p/${projectKey}`);
  if (objectiveId) revalidatePath(`/p/${projectKey}/objectives/${objectiveId}`);
}

const attachSchema = z.object({
  projectKey: z.string().min(1),
  taskId: z.string().uuid(),
  objectiveId: z.string().uuid(),
  reason: z.string().trim().max(1000).optional(),
});

export async function attachTaskObjectiveAction(
  _prev: RunActionState,
  formData: FormData,
): Promise<RunActionState> {
  const parsed = attachSchema.safeParse({
    projectKey: formData.get('projectKey'),
    taskId: formData.get('taskId'),
    objectiveId: formData.get('objectiveId'),
    reason: formData.get('reason') || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid request.' };

  try {
    const ctx = await requireTenant(parsed.data.projectKey);
    await withTenant(ctx, (tx) =>
      attachTaskToObjective(tx, ctx, parsed.data.taskId, parsed.data.objectiveId, parsed.data.reason),
    );
  } catch (err) {
    if (!(err instanceof AppError)) log.error('attachTaskObjective failed', { err });
    return { error: toPublicMessage(err) };
  }

  revalidateObjectiveSurfaces(parsed.data.projectKey, parsed.data.taskId, parsed.data.objectiveId);
  return { error: null };
}

const moveSchema = z.object({
  projectKey: z.string().min(1),
  taskId: z.string().uuid(),
  objectiveId: z.string().uuid(),
  reason: z.string().trim().max(1000).optional(),
});

export async function moveTaskObjectiveAction(
  _prev: RunActionState,
  formData: FormData,
): Promise<RunActionState> {
  const parsed = moveSchema.safeParse({
    projectKey: formData.get('projectKey'),
    taskId: formData.get('taskId'),
    objectiveId: formData.get('objectiveId'),
    reason: formData.get('reason') || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid request.' };

  try {
    const ctx = await requireTenant(parsed.data.projectKey);
    await withTenant(ctx, (tx) =>
      moveTaskToObjective(tx, ctx, parsed.data.taskId, parsed.data.objectiveId, parsed.data.reason ?? ''),
    );
  } catch (err) {
    if (!(err instanceof AppError)) log.error('moveTaskObjective failed', { err });
    return { error: toPublicMessage(err) };
  }

  revalidateObjectiveSurfaces(parsed.data.projectKey, parsed.data.taskId, parsed.data.objectiveId);
  return { error: null };
}

const detachSchema = z.object({
  projectKey: z.string().min(1),
  taskId: z.string().uuid(),
  reason: z.string().trim().max(1000).optional(),
});

export async function detachTaskObjectiveAction(
  _prev: RunActionState,
  formData: FormData,
): Promise<RunActionState> {
  const parsed = detachSchema.safeParse({
    projectKey: formData.get('projectKey'),
    taskId: formData.get('taskId'),
    reason: formData.get('reason') || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid request.' };

  try {
    const ctx = await requireTenant(parsed.data.projectKey);
    await withTenant(ctx, (tx) =>
      detachTaskFromObjective(tx, ctx, parsed.data.taskId, parsed.data.reason ?? ''),
    );
  } catch (err) {
    if (!(err instanceof AppError)) log.error('detachTaskObjective failed', { err });
    return { error: toPublicMessage(err) };
  }

  revalidateObjectiveSurfaces(parsed.data.projectKey, parsed.data.taskId);
  return { error: null };
}

const supersedeSchema = recoverSchema.extend({
  replacementTaskId: z.string().uuid(),
});

/**
 * Supersede a task with an existing replacement — cancels the old task while
 * recording the link to the newer one, so the relationship survives (HUB-002).
 * Never represented as execution.
 */
export async function supersedeTaskAction(
  _prev: RunActionState,
  formData: FormData,
): Promise<RunActionState> {
  const parsed = supersedeSchema.safeParse({
    projectKey: formData.get('projectKey'),
    taskId: formData.get('taskId'),
    replacementTaskId: formData.get('replacementTaskId'),
    reason: formData.get('reason'),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid request.' };

  try {
    const ctx = await requireTenant(parsed.data.projectKey);
    if (ctx.projectRole !== 'admin') {
      throw new AppError('forbidden', 'Only an admin can run recovery actions.');
    }
    await withTenant(ctx, (tx) =>
      supersedeTask(tx, ctx, parsed.data.taskId, parsed.data.replacementTaskId, parsed.data.reason),
    );
  } catch (err) {
    if (!(err instanceof AppError)) log.error('supersedeTask failed', { err });
    return { error: toPublicMessage(err) };
  }

  revalidatePath(`/p/${parsed.data.projectKey}/tasks/${parsed.data.taskId}`);
  revalidatePath(`/p/${parsed.data.projectKey}`);
  return { error: null };
}

/**
 * Manually reconcile a task's derived authorization state from the authoritative
 * approval records (HUB-002, admin-only). Repairs tasks whose status drifted out
 * of step with their approvals; the domain function is idempotent.
 */
export async function reconcileTaskAction(
  _prev: RunActionState,
  formData: FormData,
): Promise<RunActionState> {
  const parsed = recoverSchema.safeParse({
    projectKey: formData.get('projectKey'),
    taskId: formData.get('taskId'),
    reason: formData.get('reason'),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid request.' };

  try {
    const ctx = await requireTenant(parsed.data.projectKey);
    // manuallyReconcileTask enforces admin authority + non-empty reason itself.
    await withTenant(ctx, (tx) =>
      manuallyReconcileTask(tx, ctx, parsed.data.taskId, parsed.data.reason),
    );
  } catch (err) {
    if (!(err instanceof AppError)) log.error('reconcileTask failed', { err });
    return { error: toPublicMessage(err) };
  }

  revalidatePath(`/p/${parsed.data.projectKey}/tasks/${parsed.data.taskId}`);
  revalidatePath(`/p/${parsed.data.projectKey}`);
  return { error: null };
}
