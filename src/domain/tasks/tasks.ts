import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  FLAGSHIP_CATEGORIES,
  MODEL_TIERS,
  type MessageRole,
  type RetrievedDocRef,
  type ReviewDetail,
  type ReviewVerdict,
  type StepKind,
  type TaskStatus,
  type TenantContext,
} from '@/types/domain';
import { PROVIDER_SELECTIONS, type ProviderId, type ProviderSelection } from '@/types/provider';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors';
import { type DbTx } from '@/db/client';
import { messages, runs, runSteps, tasks } from '@/db/schema';
import { writeAudit } from '@/domain/audit/audit';

/**
 * Task CRUD and history reads. Run EXECUTION lives in runner.ts — this module
 * never talks to a provider.
 */

export const createTaskSchema = z
  .object({
    title: z.string().trim().min(1, 'Title is required').max(200),
    input: z.string().trim().min(1, 'Task input is required').max(32_000),
    providerSelection: z.enum(PROVIDER_SELECTIONS),
    reviewEnabled: z.boolean(),
    modelTier: z.enum(MODEL_TIERS).default('standard'),
    flagshipCategory: z.enum(FLAGSHIP_CATEGORIES).nullable().default(null),
    /** Optional attachment into the work hierarchy (D-010). */
    objectiveId: z.string().uuid().nullable().default(null),
    /** Set only by the standing-work tick (Sprint 8); never by forms. */
    scheduleId: z.string().uuid().nullable().default(null),
  })
  .refine((v) => v.modelTier !== 'flagship' || v.flagshipCategory != null, {
    message: 'Flagship runs must declare a category from the reserved list.',
  })
  .refine((v) => v.modelTier === 'flagship' || v.flagshipCategory == null, {
    message: 'A category only applies to flagship runs.',
  });

export type CreateTaskInput = z.input<typeof createTaskSchema>;

export async function createTask(
  tx: DbTx,
  ctx: TenantContext,
  input: CreateTaskInput,
): Promise<string> {
  const parsed = createTaskSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message));
  }

  // `both` without review makes no sense (there would be no second provider) —
  // normalize instead of erroring: both ⇒ review on.
  const reviewEnabled =
    parsed.data.providerSelection === 'both' ? true : parsed.data.reviewEnabled;

  const inserted = await tx
    .insert(tasks)
    .values({
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      title: parsed.data.title,
      input: parsed.data.input,
      providerSelection: parsed.data.providerSelection,
      reviewEnabled,
      modelTier: parsed.data.modelTier,
      flagshipCategory: parsed.data.flagshipCategory,
      objectiveId: parsed.data.objectiveId,
      scheduleId: parsed.data.scheduleId,
      status: 'pending',
      createdBy: ctx.userId,
    })
    .returning({ id: tasks.id });

  const taskId = inserted[0]!.id;

  await writeAudit(tx, ctx, {
    action: 'task.created',
    entityType: 'task',
    entityId: taskId,
    detail: {
      title: parsed.data.title,
      providerSelection: parsed.data.providerSelection,
      reviewEnabled,
      modelTier: parsed.data.modelTier,
      flagshipCategory: parsed.data.flagshipCategory,
      objectiveId: parsed.data.objectiveId,
    },
  });

  return taskId;
}

export interface TaskListRow {
  id: string;
  title: string;
  status: TaskStatus;
  providerSelection: ProviderSelection;
  reviewEnabled: boolean;
  createdAt: Date;
}

export async function listTasks(tx: DbTx, ctx: TenantContext, limit = 50): Promise<TaskListRow[]> {
  return tx
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      providerSelection: tasks.providerSelection,
      reviewEnabled: tasks.reviewEnabled,
      createdAt: tasks.createdAt,
    })
    .from(tasks)
    .where(and(eq(tasks.projectId, ctx.projectId), eq(tasks.orgId, ctx.orgId)))
    .orderBy(desc(tasks.createdAt))
    .limit(limit);
}

export interface TaskDetail {
  id: string;
  title: string;
  input: string;
  status: TaskStatus;
  providerSelection: ProviderSelection;
  reviewEnabled: boolean;
  createdAt: Date;
}

export async function getTask(tx: DbTx, ctx: TenantContext, taskId: string): Promise<TaskDetail> {
  const rows = await tx
    .select({
      id: tasks.id,
      title: tasks.title,
      input: tasks.input,
      status: tasks.status,
      providerSelection: tasks.providerSelection,
      reviewEnabled: tasks.reviewEnabled,
      createdAt: tasks.createdAt,
    })
    .from(tasks)
    .where(
      and(eq(tasks.id, taskId), eq(tasks.projectId, ctx.projectId), eq(tasks.orgId, ctx.orgId)),
    )
    .limit(1);
  const task = rows[0];
  if (!task) throw new NotFoundError('Task');
  return task;
}

export async function setTaskStatus(
  tx: DbTx,
  ctx: TenantContext,
  taskId: string,
  status: TaskStatus,
): Promise<void> {
  const updated = await tx
    .update(tasks)
    .set({ status, updatedAt: new Date() })
    .where(
      and(eq(tasks.id, taskId), eq(tasks.projectId, ctx.projectId), eq(tasks.orgId, ctx.orgId)),
    )
    .returning({ id: tasks.id });
  if (updated.length === 0) throw new NotFoundError('Task');
}

/**
 * Cancels a task the owner no longer wants (LIFECYCLE-AUDIT). Cancelling is
 * the *end* of a task's life, not a delete: its messages, costs, and audit
 * rows stay, because money may already have been spent and history is
 * append-only (I6, I7).
 *
 * A `running` task cannot be cancelled here. The engine holds an in-flight
 * provider call with its own deadline, and flipping the row underneath it
 * would leave the run writing steps to a task that claims to be finished.
 * Runs are bounded by RUN_TIMEOUT_MS; waiting is correct.
 */
export async function cancelTask(tx: DbTx, ctx: TenantContext, taskId: string): Promise<void> {
  const task = await getTask(tx, ctx, taskId);
  if (task.status === 'running') {
    throw new ConflictError(
      'This task is running. Wait for it to finish — runs are time-bounded — then cancel it.',
    );
  }
  if (task.status === 'cancelled') {
    throw new ConflictError('This task is already cancelled.');
  }

  await tx
    .update(tasks)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(
      and(eq(tasks.id, taskId), eq(tasks.projectId, ctx.projectId), eq(tasks.orgId, ctx.orgId)),
    );

  await writeAudit(tx, ctx, {
    action: 'task.cancelled',
    entityType: 'task',
    entityId: taskId,
    detail: { title: task.title, from: task.status },
  });
}

export interface MessageRow {
  id: string;
  role: MessageRole;
  provider: ProviderId | null;
  model: string | null;
  content: string;
  createdAt: Date;
}

export async function listMessages(
  tx: DbTx,
  ctx: TenantContext,
  taskId: string,
): Promise<MessageRow[]> {
  return tx
    .select({
      id: messages.id,
      role: messages.role,
      provider: messages.provider,
      model: messages.model,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.taskId, taskId),
        eq(messages.projectId, ctx.projectId),
        eq(messages.orgId, ctx.orgId),
      ),
    )
    .orderBy(messages.createdAt);
}

export interface RunRow {
  id: string;
  status: string;
  consolidatedResult: string | null;
  errorMessage: string | null;
  retrievedDocuments: RetrievedDocRef[] | null;
  startedAt: Date;
  finishedAt: Date | null;
}

export async function listRuns(tx: DbTx, ctx: TenantContext, taskId: string): Promise<RunRow[]> {
  return tx
    .select({
      id: runs.id,
      status: runs.status,
      consolidatedResult: runs.consolidatedResult,
      errorMessage: runs.errorMessage,
      retrievedDocuments: runs.retrievedDocuments,
      startedAt: runs.startedAt,
      finishedAt: runs.finishedAt,
    })
    .from(runs)
    .where(
      and(eq(runs.taskId, taskId), eq(runs.projectId, ctx.projectId), eq(runs.orgId, ctx.orgId)),
    )
    .orderBy(desc(runs.startedAt));
}

export interface RunStepRow {
  id: string;
  stepNumber: number;
  kind: StepKind;
  provider: ProviderId | null;
  model: string | null;
  verdict: ReviewVerdict | null;
  verdictDetail: ReviewDetail | null;
  succeeded: boolean;
  errorMessage: string | null;
  latencyMs: number | null;
}

export async function listRunSteps(tx: DbTx, ctx: TenantContext, runId: string): Promise<RunStepRow[]> {
  return tx
    .select({
      id: runSteps.id,
      stepNumber: runSteps.stepNumber,
      kind: runSteps.kind,
      provider: runSteps.provider,
      model: runSteps.model,
      verdict: runSteps.verdict,
      verdictDetail: runSteps.verdictDetail,
      succeeded: runSteps.succeeded,
      errorMessage: runSteps.errorMessage,
      latencyMs: runSteps.latencyMs,
    })
    .from(runSteps)
    .where(
      and(
        eq(runSteps.runId, runId),
        eq(runSteps.projectId, ctx.projectId),
        eq(runSteps.orgId, ctx.orgId),
      ),
    )
    .orderBy(runSteps.stepNumber);
}
