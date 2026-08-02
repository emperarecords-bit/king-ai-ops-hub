'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { AppError, toPublicMessage } from '@/lib/errors';
import { log } from '@/lib/log';
import { slugifyMetric } from '@/lib/slug';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import {
  addCriterion,
  addMilestone,
  createObjective,
  removeCriterion,
  setCriterionStatus,
  setMilestoneStatus,
  setObjectiveStatus,
  updateCriterion,
  updateObjectiveDetails,
} from '@/domain/objectives/objectives';
import { listAssignableEmployees } from '@/domain/agents/agents';
import { suggestSuccessCriteria } from '@/domain/objectives/suggest';
import { createSchedule, setScheduleEnabled, updateSchedule } from '@/domain/standing/standing';

export interface ObjectiveFormState {
  error: string | null;
}

/**
 * Criteria arrive as parallel form arrays (label[i], metric[i], target[i],
 * unit[i]); rows with an empty label are treated as blank rows and dropped.
 */
function parseCriteria(formData: FormData) {
  const labels = formData.getAll('criterionLabel').map(String);
  const metrics = formData.getAll('criterionMetric').map(String);
  const targets = formData.getAll('criterionTarget').map(String);
  const units = formData.getAll('criterionUnit').map(String);
  const out: Array<{ label: string; metric: string; target: number; unit: string }> = [];
  for (let i = 0; i < labels.length; i += 1) {
    const label = labels[i]?.trim() ?? '';
    if (!label) continue;
    const target = Number(targets[i] ?? '');
    out.push({
      label,
      // slugifyMetric, not a naive whitespace replace: labels contain slashes
      // and punctuation, and this field is an identifier (O-11).
      metric: slugifyMetric(metrics[i]?.trim() || label),
      target: Number.isFinite(target) ? target : 1,
      unit: units[i]?.trim() ?? '',
    });
  }
  return out;
}

export async function submitObjective(
  _prev: ObjectiveFormState,
  formData: FormData,
): Promise<ObjectiveFormState> {
  const projectKey = String(formData.get('projectKey') ?? '');
  const title = String(formData.get('title') ?? '');
  const description = String(formData.get('description') ?? '');
  const dept = String(formData.get('sponsoringDepartmentId') ?? '');
  const employee = String(formData.get('accountableAgentId') ?? '');

  let objectiveId: string;
  try {
    const ctx = await requireTenant(projectKey);
    objectiveId = await withTenant(ctx, (tx) =>
      createObjective(tx, ctx, {
        title,
        description,
        successCriteria: parseCriteria(formData),
        sponsoringDepartmentId: z.string().uuid().safeParse(dept).success ? dept : null,
        accountableAgentId: z.string().uuid().safeParse(employee).success ? employee : null,
      }),
    );
  } catch (err) {
    if (!(err instanceof AppError)) log.error('createObjective failed', { err });
    return { error: toPublicMessage(err) };
  }
  redirect(`/p/${projectKey}/objectives/${objectiveId}`);
}

export interface SuggestionState {
  suggestions: Array<{ label: string; target: number; unit: string }>;
  error: string | null;
}

/**
 * Proposes success criteria for the objective being drafted. The result is a
 * SUGGESTION rendered into editable fields — nothing is stored until the
 * human submits the form.
 */
export async function suggestCriteria(
  _prev: SuggestionState,
  formData: FormData,
): Promise<SuggestionState> {
  const projectKey = String(formData.get('projectKey') ?? '');
  try {
    const ctx = await requireTenant(projectKey);
    const suggestions = await suggestSuccessCriteria(ctx, {
      title: String(formData.get('title') ?? ''),
      description: String(formData.get('description') ?? ''),
      // Stable per-submission key from the client — a network replay / double-submit of the SAME
      // submission reuses the operation; a fresh submission carries a new key.
      idempotencyKey: String(formData.get('idempotencyKey') ?? '') || undefined,
    });
    if (suggestions.length === 0) {
      return { suggestions: [], error: 'No usable suggestions came back — write them yourself.' };
    }
    return { suggestions, error: null };
  } catch (err) {
    if (!(err instanceof AppError)) log.error('suggestCriteria failed', { err });
    return { suggestions: [], error: toPublicMessage(err) };
  }
}

export interface MutationState {
  error: string | null;
}

async function objectiveMutation(
  formData: FormData,
  fn: (ctx: Awaited<ReturnType<typeof requireTenant>>, objectiveId: string) => Promise<void>,
): Promise<MutationState> {
  const projectKey = String(formData.get('projectKey') ?? '');
  const objectiveId = String(formData.get('objectiveId') ?? '');
  if (!projectKey || !z.string().uuid().safeParse(objectiveId).success) {
    return { error: 'Invalid request.' };
  }
  try {
    const ctx = await requireTenant(projectKey);
    await fn(ctx, objectiveId);
  } catch (err) {
    if (!(err instanceof AppError)) log.error('objective mutation failed', { err, objectiveId });
    return { error: toPublicMessage(err) };
  }
  revalidatePath(`/p/${projectKey}/objectives/${objectiveId}`);
  revalidatePath(`/p/${projectKey}/objectives`);
  return { error: null };
}

export async function changeObjectiveStatus(
  _prev: MutationState,
  formData: FormData,
): Promise<MutationState> {
  const next = String(formData.get('next') ?? '');
  const parsed = z.enum(['active', 'completed', 'cancelled']).safeParse(next);
  if (!parsed.success) return { error: 'Invalid status.' };
  const reason = String(formData.get('reason') ?? '');
  return objectiveMutation(formData, (ctx, objectiveId) =>
    withTenant(ctx, (tx) => setObjectiveStatus(tx, ctx, objectiveId, parsed.data, reason)),
  );
}

export async function changeCriterionStatus(
  _prev: MutationState,
  formData: FormData,
): Promise<MutationState> {
  const index = Number(formData.get('index'));
  const status = String(formData.get('status') ?? '');
  const parsedStatus = z.enum(['met', 'waived', 'unmet']).safeParse(status);
  if (!Number.isInteger(index) || index < 0 || !parsedStatus.success) {
    return { error: 'Invalid request.' };
  }
  return objectiveMutation(formData, (ctx, objectiveId) =>
    withTenant(ctx, (tx) => setCriterionStatus(tx, ctx, objectiveId, index, parsedStatus.data)),
  );
}

export async function submitMilestone(
  _prev: MutationState,
  formData: FormData,
): Promise<MutationState> {
  const title = String(formData.get('title') ?? '');
  return objectiveMutation(formData, (ctx, objectiveId) =>
    withTenant(ctx, async (tx) => {
      await addMilestone(tx, ctx, objectiveId, { title });
    }),
  );
}

export async function submitSchedule(
  _prev: MutationState,
  formData: FormData,
): Promise<MutationState> {
  const assigneeId = String(formData.get('assigneeAgentId') ?? '');
  if (!z.string().uuid().safeParse(assigneeId).success) {
    return { error: 'Pick who should perform the standing work.' };
  }
  const weekdayRaw = formData.get('weekday');
  const monthdayRaw = formData.get('monthday');
  const reviewEnabled = formData.get('reviewEnabled') === 'on';
  const rawReviewer = formData.get('reviewerAgentId');
  return objectiveMutation(formData, (ctx, objectiveId) =>
    withTenant(ctx, async (tx) => {
      const employees = await listAssignableEmployees(tx, ctx);
      const assignee = employees.find((e) => e.id === assigneeId);
      if (!assignee) throw new Error('Assignee is not an active employee here.');
      await createSchedule(tx, ctx, {
        title: String(formData.get('title') ?? ''),
        input: String(formData.get('input') ?? ''),
        objectiveId,
        providerSelection: assignee.provider,
        reviewEnabled,
        // P1a agent pinning — pin the exact employees (createSchedule re-validates them in-workspace).
        assignedPrimaryAgentId: assigneeId,
        assignedReviewerAgentId: reviewEnabled && rawReviewer ? String(rawReviewer) : null,
        cadence: String(formData.get('cadence') ?? 'weekly') as 'daily' | 'weekly' | 'monthly',
        atHour: Number(formData.get('atHour') ?? 6),
        weekday: weekdayRaw != null && weekdayRaw !== '' ? Number(weekdayRaw) : null,
        monthday: monthdayRaw != null && monthdayRaw !== '' ? Number(monthdayRaw) : null,
      });
    }),
  );
}

export async function toggleSchedule(
  _prev: MutationState,
  formData: FormData,
): Promise<MutationState> {
  const scheduleId = String(formData.get('scheduleId') ?? '');
  const enabled = String(formData.get('enabled') ?? '') === 'true';
  if (!z.string().uuid().safeParse(scheduleId).success) return { error: 'Invalid request.' };
  return objectiveMutation(formData, (ctx) =>
    withTenant(ctx, (tx) => setScheduleEnabled(tx, ctx, scheduleId, enabled)),
  );
}

/** Reads the label/target/unit trio that criterion edit and add both submit. */
function criterionFields(formData: FormData) {
  const targetRaw = formData.get('target');
  return {
    label: String(formData.get('label') ?? ''),
    target: Number(targetRaw ?? 0),
    unit: String(formData.get('unit') ?? ''),
  };
}

export async function editCriterion(
  _prev: MutationState,
  formData: FormData,
): Promise<MutationState> {
  const index = Number(formData.get('index'));
  if (!Number.isInteger(index) || index < 0) return { error: 'Invalid request.' };
  const fields = criterionFields(formData);
  if (!Number.isFinite(fields.target)) return { error: 'Target must be a number.' };
  return objectiveMutation(formData, (ctx, objectiveId) =>
    withTenant(ctx, (tx) => updateCriterion(tx, ctx, objectiveId, index, fields)),
  );
}

export async function submitCriterion(
  _prev: MutationState,
  formData: FormData,
): Promise<MutationState> {
  const fields = criterionFields(formData);
  if (!Number.isFinite(fields.target)) return { error: 'Target must be a number.' };
  return objectiveMutation(formData, (ctx, objectiveId) =>
    withTenant(ctx, (tx) => addCriterion(tx, ctx, objectiveId, fields)),
  );
}

export async function deleteCriterion(
  _prev: MutationState,
  formData: FormData,
): Promise<MutationState> {
  const index = Number(formData.get('index'));
  if (!Number.isInteger(index) || index < 0) return { error: 'Invalid request.' };
  return objectiveMutation(formData, (ctx, objectiveId) =>
    withTenant(ctx, (tx) => removeCriterion(tx, ctx, objectiveId, index)),
  );
}

export async function editObjectiveDetails(
  _prev: MutationState,
  formData: FormData,
): Promise<MutationState> {
  return objectiveMutation(formData, (ctx, objectiveId) =>
    withTenant(ctx, (tx) =>
      updateObjectiveDetails(tx, ctx, objectiveId, {
        title: String(formData.get('title') ?? ''),
        description: String(formData.get('description') ?? ''),
      }),
    ),
  );
}

export async function editSchedule(
  _prev: MutationState,
  formData: FormData,
): Promise<MutationState> {
  const scheduleId = String(formData.get('scheduleId') ?? '');
  const assigneeId = String(formData.get('assigneeAgentId') ?? '');
  if (!z.string().uuid().safeParse(scheduleId).success) return { error: 'Invalid request.' };
  if (!z.string().uuid().safeParse(assigneeId).success) {
    return { error: 'Pick who should perform the standing work.' };
  }
  const weekdayRaw = formData.get('weekday');
  const monthdayRaw = formData.get('monthday');
  const reviewEnabled = formData.get('reviewEnabled') === 'on';
  const rawReviewer = formData.get('reviewerAgentId');
  return objectiveMutation(formData, (ctx, objectiveId) =>
    withTenant(ctx, async (tx) => {
      const employees = await listAssignableEmployees(tx, ctx);
      const assignee = employees.find((e) => e.id === assigneeId);
      if (!assignee) throw new Error('Assignee is not an active employee here.');
      await updateSchedule(tx, ctx, scheduleId, {
        title: String(formData.get('title') ?? ''),
        input: String(formData.get('input') ?? ''),
        objectiveId,
        providerSelection: assignee.provider,
        reviewEnabled,
        assignedPrimaryAgentId: assigneeId,
        assignedReviewerAgentId: reviewEnabled && rawReviewer ? String(rawReviewer) : null,
        cadence: String(formData.get('cadence') ?? 'weekly') as 'daily' | 'weekly' | 'monthly',
        atHour: Number(formData.get('atHour') ?? 6),
        weekday: weekdayRaw != null && weekdayRaw !== '' ? Number(weekdayRaw) : null,
        monthday: monthdayRaw != null && monthdayRaw !== '' ? Number(monthdayRaw) : null,
      });
    }),
  );
}

export async function changeMilestoneStatus(
  _prev: MutationState,
  formData: FormData,
): Promise<MutationState> {
  const milestoneId = String(formData.get('milestoneId') ?? '');
  const status = String(formData.get('status') ?? '');
  const parsedStatus = z.enum(['planned', 'active', 'completed', 'cancelled']).safeParse(status);
  if (!z.string().uuid().safeParse(milestoneId).success || !parsedStatus.success) {
    return { error: 'Invalid request.' };
  }
  return objectiveMutation(formData, (ctx) =>
    withTenant(ctx, (tx) => setMilestoneStatus(tx, ctx, milestoneId, parsedStatus.data)),
  );
}
