import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  FLAGSHIP_CATEGORIES,
  MODEL_TIERS,
  type DataClassification,
  type MessageRole,
  type ContextManifestEntry,
  type ObjectiveStatus,
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
import { messages, objectives, runs, runSteps, tasks } from '@/db/schema';
import { writeAudit } from '@/domain/audit/audit';
import { getAssignableAgentById } from '@/domain/agents/agents';
import { withdrawPendingApprovalsForTask } from '@/domain/approvals/approvals';

/**
 * Resolve an objective that a task is being tied to, scoped to this workspace (HUB-003, req #4).
 * The canonical objective↔task association is the single FK `tasks.objective_id`; before persisting
 * one we confirm the objective actually lives in the caller's org+project, so a crafted request can
 * never point a task at a cross-workspace objective. Returns the objective's status for callers that
 * also refuse to tie work to a closed goal. Throws NotFound when it isn't in this workspace.
 */
async function resolveObjectiveInWorkspace(
  tx: DbTx,
  ctx: TenantContext,
  objectiveId: string,
): Promise<{ id: string; title: string; status: string }> {
  const rows = await tx
    .select({ id: objectives.id, title: objectives.title, status: objectives.status })
    .from(objectives)
    .where(
      and(
        eq(objectives.id, objectiveId),
        eq(objectives.projectId, ctx.projectId),
        eq(objectives.orgId, ctx.orgId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw new NotFoundError('Objective');
  return row;
}

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
    /** P1a agent pinning — the EXACT employees this task runs. `primaryAgentId` is required (a task is
     *  always pinned to a specific enabled primary). `reviewerAgentId` is required IFF reviewEnabled, and
     *  must be absent otherwise; it can never equal the primary. Validated against the workspace in
     *  createTask (a tampered/stale id ⇒ ValidationError). */
    primaryAgentId: z.string().uuid(),
    reviewerAgentId: z.string().uuid().nullable().default(null),
  })
  .refine((v) => v.modelTier !== 'flagship' || v.flagshipCategory != null, {
    message: 'Flagship runs must declare a category from the reserved list.',
  })
  .refine((v) => v.modelTier === 'flagship' || v.flagshipCategory == null, {
    message: 'A category only applies to flagship runs.',
  })
  .refine((v) => !v.reviewEnabled || v.reviewerAgentId != null, {
    message: 'A cross-check requires an assigned reviewer employee.',
  })
  .refine((v) => v.reviewEnabled || v.reviewerAgentId == null, {
    message: 'A reviewer can only be assigned when cross-check is enabled.',
  })
  .refine((v) => v.reviewerAgentId == null || v.reviewerAgentId !== v.primaryAgentId, {
    message: 'The reviewer must be a different employee than the primary.',
  });

export type CreateTaskInput = z.input<typeof createTaskSchema>;

/**
 * Shared preflight for both task-creation paths (interactive `createTask` and standing-work
 * `createScheduledOccurrenceTask`): validate the input, resolve the objective in-workspace, validate the P1a
 * pinned employees fail-closed, derive the provider from the pinned primary, and assemble the insert values +
 * the audit detail payloads. It performs NO write — the caller owns the exact INSERT (plain vs.
 * occurrence-idempotent) so the two paths differ only in conflict handling, never in validation.
 */
async function prepareTaskInsert(
  tx: DbTx,
  ctx: TenantContext,
  input: CreateTaskInput,
): Promise<{
  values: typeof tasks.$inferInsert;
  createdDetail: Record<string, unknown>;
  assignmentDetail: Record<string, unknown>;
}> {
  const parsed = createTaskSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message));
  }

  const reviewEnabled = parsed.data.reviewEnabled;

  // The canonical objective link is persisted here — so it is validated here (HUB-003, req #4).
  // A task may only be tied to an objective in its own workspace; the FK alone would accept any uuid.
  if (parsed.data.objectiveId) {
    await resolveObjectiveInWorkspace(tx, ctx, parsed.data.objectiveId);
  }

  // P1a agent pinning — validate the pinned employees against THIS workspace, fail closed. The primary
  // must be an enabled primary-role agent here; a tampered, stale, disabled, wrong-role, or cross-workspace
  // id resolves to null and is rejected (never silently substituted). The composite FK is a second net.
  const primaryAgent = await getAssignableAgentById(tx, ctx, parsed.data.primaryAgentId, 'primary');
  if (!primaryAgent) {
    throw new ValidationError(['Selected primary employee is not an enabled primary agent in this workspace.']);
  }

  let reviewerAgent = null;
  if (reviewEnabled) {
    // reviewerAgentId is guaranteed non-null here by the schema refinement, but re-check for safety.
    if (!parsed.data.reviewerAgentId) {
      throw new ValidationError(['A cross-check requires an assigned reviewer employee.']);
    }
    reviewerAgent = await getAssignableAgentById(tx, ctx, parsed.data.reviewerAgentId, 'reviewer');
    if (!reviewerAgent) {
      throw new ValidationError(['Selected reviewer employee is not an enabled reviewer agent in this workspace.']);
    }
    if (reviewerAgent.id === primaryAgent.id) {
      throw new ValidationError(['The reviewer must be a different employee than the primary.']);
    }
  }

  // Provider routing is DERIVED from the pinned primary — never 'both', never a passed value. This keeps
  // downstream provider selection consistent with the employee that actually executes (the runner reads
  // the pinned agents, not providerSelection, but other surfaces still read this column).
  const providerSelection = primaryAgent.provider;
  const assignedReviewerAgentId = reviewEnabled ? reviewerAgent!.id : null;

  return {
    values: {
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      title: parsed.data.title,
      input: parsed.data.input,
      providerSelection,
      reviewEnabled,
      modelTier: parsed.data.modelTier,
      flagshipCategory: parsed.data.flagshipCategory,
      objectiveId: parsed.data.objectiveId,
      scheduleId: parsed.data.scheduleId,
      assignedPrimaryAgentId: primaryAgent.id,
      assignedReviewerAgentId,
      status: 'pending',
      createdBy: ctx.userId,
    },
    createdDetail: {
      title: parsed.data.title,
      providerSelection,
      reviewEnabled,
      modelTier: parsed.data.modelTier,
      flagshipCategory: parsed.data.flagshipCategory,
      objectiveId: parsed.data.objectiveId,
    },
    // P1a — the exact pinning decision (identity only: ids / names / provider / model). NO systemPrompt,
    // NO secrets. The durable "who was pinned, and to what execution profile" record.
    assignmentDetail: {
      requestedPrimaryAgentId: primaryAgent.id,
      primaryAgentName: primaryAgent.name,
      primaryProvider: primaryAgent.provider,
      primaryModel: primaryAgent.model,
      requestedReviewerAgentId: reviewerAgent?.id ?? null,
      reviewerName: reviewerAgent?.name ?? null,
      reviewerProvider: reviewerAgent?.provider ?? null,
    },
  };
}

/** Write the two P1a task-creation audits (task.created + task.assignment_created). Shared so both creation
 *  paths record identical provenance. */
async function writeTaskCreationAudits(
  tx: DbTx,
  ctx: TenantContext,
  taskId: string,
  prep: { createdDetail: Record<string, unknown>; assignmentDetail: Record<string, unknown> },
): Promise<void> {
  await writeAudit(tx, ctx, {
    action: 'task.created',
    entityType: 'task',
    entityId: taskId,
    detail: prep.createdDetail,
  });
  // A DISTINCT event records the pinning decision; run.assignment_confirmed later proves the run executed it.
  await writeAudit(tx, ctx, {
    action: 'task.assignment_created',
    entityType: 'task',
    entityId: taskId,
    detail: prep.assignmentDetail,
  });
}

export async function createTask(
  tx: DbTx,
  ctx: TenantContext,
  input: CreateTaskInput,
): Promise<string> {
  const prep = await prepareTaskInsert(tx, ctx, input);
  const inserted = await tx.insert(tasks).values(prep.values).returning({ id: tasks.id });
  const taskId = inserted[0]!.id;
  await writeTaskCreationAudits(tx, ctx, taskId, prep);
  return taskId;
}

/**
 * Hub P1d — create the task for one standing-work OCCURRENCE, idempotently. Identical validation and audit to
 * `createTask`, but the INSERT carries the deterministic occurrence identity (`scheduleId` +
 * `scheduleOccurrenceAt`) and uses `onConflictDoNothing`, so two concurrent scheduler ticks for the same due
 * instant collapse to a single task: the loser's insert conflicts on `tasks_schedule_occurrence_uq` and this
 * returns `null` (no task row, no audit). Returns the new task id when THIS call won the occurrence.
 *
 * `scheduleId` is passed explicitly (not read from `input.scheduleId`) so the occurrence identity always
 * matches the row the caller advances.
 */
export async function createScheduledOccurrenceTask(
  tx: DbTx,
  ctx: TenantContext,
  input: CreateTaskInput,
  occurrence: { scheduleId: string; scheduleOccurrenceAt: Date },
): Promise<string | null> {
  const prep = await prepareTaskInsert(tx, ctx, {
    ...input,
    scheduleId: occurrence.scheduleId,
  });
  const inserted = await tx
    .insert(tasks)
    .values({ ...prep.values, scheduleOccurrenceAt: occurrence.scheduleOccurrenceAt })
    // No conflict target: the only unique key a fresh (random-id) standing task can violate is the partial
    // occurrence index, so a bare DO NOTHING is precise and simplest. An empty returning ⇒ the occurrence
    // was already claimed by a concurrent tick ⇒ suppress.
    .onConflictDoNothing()
    .returning({ id: tasks.id });
  if (inserted.length === 0) return null;
  const taskId = inserted[0]!.id;
  await writeTaskCreationAudits(tx, ctx, taskId, prep);
  return taskId;
}

export interface TaskListRow {
  id: string;
  title: string;
  status: TaskStatus;
  /** Carried so surfaces can read a task in the shared execution language (assessTask). */
  ownerAgentId: string | null;
  providerSelection: ProviderSelection;
  reviewEnabled: boolean;
  createdAt: Date;
  /** HUB-009 — the task's own stored classification (effective class resolved by the caller vs. project). */
  classification: DataClassification;
}

/**
 * HUB-009 — the selectable dependency/supersede candidates for a task. Pure so the page's picker logic is
 * unit-testable. A live task's picker only offers LIVE candidates (demo/seed are never selectable, even with
 * `?includeNonLive=1`); the server-side `addDependency`/supersede guards enforce this regardless of the UI.
 */
export function selectableTaskCandidates<T extends { id: string; classification: DataClassification }>(
  all: readonly T[],
  opts: { excludeId: string; excludeIds?: ReadonlySet<string> },
): T[] {
  return all.filter((t) => t.id !== opts.excludeId && !opts.excludeIds?.has(t.id) && t.classification === 'live');
}

export async function listTasks(tx: DbTx, ctx: TenantContext, limit = 50): Promise<TaskListRow[]> {
  return tx
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      ownerAgentId: tasks.ownerAgentId,
      providerSelection: tasks.providerSelection,
      reviewEnabled: tasks.reviewEnabled,
      createdAt: tasks.createdAt,
      classification: tasks.classification,
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
  ownerAgentId: string | null;
  cancelReason: string | null;
  /** The canonical objective association (HUB-003) — read by EVERY surface, including this task's own
   *  header. Null when the task is not tied to an objective. Title/status are joined for display so a
   *  cancelled goal reads truthfully rather than silently. */
  objectiveId: string | null;
  objectiveTitle: string | null;
  objectiveStatus: ObjectiveStatus | null;
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
      ownerAgentId: tasks.ownerAgentId,
      cancelReason: tasks.cancelReason,
      objectiveId: tasks.objectiveId,
      objectiveTitle: objectives.title,
      objectiveStatus: objectives.status,
      createdAt: tasks.createdAt,
    })
    .from(tasks)
    // Same direct FK every other surface reads (getApprovalDetail, listExecution, getObjective) — the
    // task header must not be the one place that ignores it (the HUB-003 root cause).
    .leftJoin(objectives, eq(tasks.objectiveId, objectives.id))
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
export async function cancelTask(
  tx: DbTx,
  ctx: TenantContext,
  taskId: string,
  reason?: string,
): Promise<void> {
  const task = await getTask(tx, ctx, taskId);
  if (task.status === 'running') {
    throw new ConflictError(
      'This task is running. Wait for it to finish — runs are time-bounded — then cancel it.',
    );
  }
  if (task.status === 'cancelled') {
    throw new ConflictError('This task is already cancelled.');
  }

  const r = (reason ?? '').trim() || null;
  await tx
    .update(tasks)
    .set({ status: 'cancelled', cancelReason: r, updatedAt: new Date() })
    .where(
      and(eq(tasks.id, taskId), eq(tasks.projectId, ctx.projectId), eq(tasks.orgId, ctx.orgId)),
    );

  // Any actions this task proposed are no longer valid to authorize — the work they'd act on is
  // being cancelled. Withdraw them (distinct from reject/expire) so they leave the pending queue
  // and can't be approved for cancelled work.
  await withdrawPendingApprovalsForTask(
    tx,
    ctx,
    taskId,
    r ? `Task cancelled: ${r}` : 'Task cancelled.',
  );

  await writeAudit(tx, ctx, {
    action: 'task.cancelled',
    entityType: 'task',
    entityId: taskId,
    detail: { title: task.title, from: task.status, reason: r },
  });
}

/**
 * Hub P1d — cooperative cancellation across the run lifecycle. `cancelTask` (the hard cancel) still refuses
 * a running task; this is the cooperative path the runner honors at each provider-dispatch boundary:
 *   - QUEUED (pending) / already-failed work → hard-cancel now (zero provider calls): task → cancelled and
 *     its pending approvals withdrawn. Any queued job drains to `done` with NO provider call when a worker
 *     next claims it.
 *   - RUNNING work → set the cancel-request MARKER (`cancelReason`) WITHOUT changing status, so resume
 *     detection stays intact. The runner sees the marker at the next provider-dispatch boundary and stops
 *     with zero further provider calls; a CHECKPOINTED completed result is finalized, never discarded.
 *   - COMPLETED / awaiting-approval / cancelled → refused: a late cancel can never discard a finished
 *     (checkpointed) result — only one terminal outcome wins.
 */
export async function requestCancellation(
  tx: DbTx,
  ctx: TenantContext,
  taskId: string,
  reason?: string,
): Promise<'cancelled_queued' | 'cancel_requested'> {
  const task = await getTask(tx, ctx, taskId);
  if (task.status === 'pending' || task.status === 'failed') {
    await cancelTask(tx, ctx, taskId, reason);
    return 'cancelled_queued';
  }
  if (task.status === 'running') {
    const r = (reason ?? '').trim() || 'Cancellation requested.';
    await tx
      .update(tasks)
      .set({ cancelReason: r, updatedAt: new Date() })
      .where(and(eq(tasks.id, taskId), eq(tasks.projectId, ctx.projectId), eq(tasks.orgId, ctx.orgId)));
    await writeAudit(tx, ctx, {
      action: 'task.cancellation_requested',
      entityType: 'task',
      entityId: taskId,
      detail: { reason: r },
    });
    return 'cancel_requested';
  }
  // completed / awaiting_approval / cancelled
  throw new ConflictError('This task has already finished; its result cannot be cancelled.');
}

/**
 * Supersede a task with a newer one (HUB-002 recovery). Like cancel, this ENDS the old task's life
 * without deleting anything — but it also records the replacement, preserving the relationship. The old
 * task becomes terminal (`cancelled`) with `superseded_by_task_id` pointing at the replacement; its
 * still-pending proposals are withdrawn (the work they'd act on is being replaced). Never touches the
 * replacement task's own state. A running task must finish first; an already-terminal task cannot be
 * superseded. A non-empty reason is required and preserved.
 */
export async function supersedeTask(
  tx: DbTx,
  ctx: TenantContext,
  taskId: string,
  replacementTaskId: string,
  reason: string,
): Promise<void> {
  const r = (reason ?? '').trim();
  if (!r) throw new ValidationError(['A reason is required to supersede a task.']);
  if (taskId === replacementTaskId) throw new ValidationError(['A task cannot supersede itself.']);

  const task = await getTask(tx, ctx, taskId); // NotFound if outside this workspace
  if (task.status === 'running') {
    throw new ConflictError('This task is running. Wait for the run to finish, then supersede it.');
  }
  if (task.status === 'cancelled') throw new ConflictError('This task is already cancelled or superseded.');

  const replacement = await getTask(tx, ctx, replacementTaskId); // NotFound → clear cross-workspace/absent error

  await tx
    .update(tasks)
    .set({
      status: 'cancelled',
      supersededByTaskId: replacementTaskId,
      cancelReason: `Superseded by "${replacement.title}": ${r}`,
      updatedAt: new Date(),
    })
    .where(and(eq(tasks.id, taskId), eq(tasks.projectId, ctx.projectId), eq(tasks.orgId, ctx.orgId)));

  // The old task's proposals are no longer valid — the work is being replaced. Withdraw the pending ones.
  await withdrawPendingApprovalsForTask(tx, ctx, taskId, `Task superseded: ${r}`);

  await writeAudit(tx, ctx, {
    action: 'task.superseded',
    entityType: 'task',
    entityId: taskId,
    detail: { title: task.title, from: task.status, supersededBy: replacementTaskId, replacementTitle: replacement.title, reason: r },
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
  contextManifest: ContextManifestEntry[] | null;
  startedAt: Date;
  finishedAt: Date | null;
  // HUB-008 reproducibility identity (nullable for runs predating the feature). These are HASHES and a
  // content manifest only — never the private system-prompt text.
  primaryPromptHash: string | null;
  reviewerPromptHash: string | null;
  primaryConfigHash: string | null;
  reviewerConfigHash: string | null;
  primaryEffectivePromptHash: string | null;
  reviewerEffectivePromptHash: string | null;
  assemblerVersion: string | null;
  sourceManifest: { kind: string; id?: string | null; scope?: string | null; hash: string }[] | null;
}

export async function listRuns(tx: DbTx, ctx: TenantContext, taskId: string): Promise<RunRow[]> {
  return tx
    .select({
      id: runs.id,
      status: runs.status,
      consolidatedResult: runs.consolidatedResult,
      errorMessage: runs.errorMessage,
      retrievedDocuments: runs.retrievedDocuments,
      contextManifest: runs.contextManifest,
      startedAt: runs.startedAt,
      finishedAt: runs.finishedAt,
      primaryPromptHash: runs.primaryPromptHash,
      reviewerPromptHash: runs.reviewerPromptHash,
      primaryConfigHash: runs.primaryConfigHash,
      reviewerConfigHash: runs.reviewerConfigHash,
      primaryEffectivePromptHash: runs.primaryEffectivePromptHash,
      reviewerEffectivePromptHash: runs.reviewerEffectivePromptHash,
      assemblerVersion: runs.assemblerVersion,
      sourceManifest: runs.sourceManifest,
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
  /** HUB-008 — per-step effective-prompt hash (null for consolidate + pre-feature steps). */
  effectivePromptHash: string | null;
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
      effectivePromptHash: runSteps.effectivePromptHash,
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
