import 'server-only';
import { and, desc, eq, gt, inArray, isNull, ne, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import {
  DECISION_APPLICABILITY,
  DECISION_SCOPES,
  DECISION_TYPES,
  type ContextManifestEntry,
  type DecisionApplicability,
  type DecisionScope,
  type DecisionStatus,
  type DecisionType,
  type TenantContext,
} from '@/types/domain';
import { AppError, ConflictError, NotFoundError, TenantViolationError, ValidationError } from '@/lib/errors';
import { log } from '@/lib/log';
import { type DbTx } from '@/db/client';
import { auditLogs, decisionInjections, decisions, objectives, profiles, tasks } from '@/db/schema';

// Aliased scope targets, so the selector can read a decision's scope-task / scope-objective status
// and drop guidance whose scope has closed (guidance does not outlive its scope).
const scopeTask = alias(tasks, 'scope_task');
const scopeObjective = alias(objectives, 'scope_objective');
import { type ContextItemForPrompt } from '@/orchestration/prompts';
import { writeAudit } from '@/domain/audit/audit';

/**
 * Decision Memory (O-19): approved operational/creative conclusions the org
 * remembers across tasks. A NEW Level-1 context source, parallel to project
 * state (O-15) and the dependency graph (O-18) — NOT document retrieval and NOT
 * conversation history. Only structured memory is stored; never prompts or
 * transcripts.
 *
 * Lifecycle: proposed → accepted (human approval) → optionally superseded.
 * Only `accepted` decisions are retrieved into context.
 */

const MAX_DECISIONS = 10;

function assertScoped(
  rows: ReadonlyArray<{ orgId: string; projectId: string }>,
  ctx: TenantContext,
  where: string,
): void {
  for (const r of rows) {
    if (r.projectId !== ctx.projectId || r.orgId !== ctx.orgId) {
      log.error(`TENANT VIOLATION in ${where}`, { expected: ctx.projectId, got: r.projectId });
      throw new TenantViolationError(`Decision from project ${r.projectId} for ${ctx.projectId}`);
    }
  }
}

/**
 * Validate + normalize a decision's scope target. Active guidance must name a CONCRETE target that
 * belongs to this workspace: task scope → a real task, objective scope → a real objective, workspace
 * scope → neither. A scope target is never inferred from category. Record-only decisions carry no
 * active-guidance target (any suggested target is cleared here for the human path). Returns the
 * normalized {scopeTaskId, scopeObjectiveId} to persist, or throws ValidationError.
 */
async function assertScopeTargets(
  tx: DbTx,
  ctx: TenantContext,
  input: { applicability: DecisionApplicability; scope: DecisionScope; scopeTaskId: string | null; scopeObjectiveId: string | null },
): Promise<{ scopeTaskId: string | null; scopeObjectiveId: string | null }> {
  if (input.applicability !== 'guidance') return { scopeTaskId: null, scopeObjectiveId: null };

  if (input.scope === 'task') {
    if (!input.scopeTaskId) throw new ValidationError(['Task-scoped guidance must name the task it guides.']);
    const rows = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.id, input.scopeTaskId), eq(tasks.projectId, ctx.projectId), eq(tasks.orgId, ctx.orgId)))
      .limit(1);
    if (rows.length === 0) throw new ValidationError(['That task is not in this workspace.']);
    return { scopeTaskId: input.scopeTaskId, scopeObjectiveId: null };
  }
  if (input.scope === 'objective') {
    if (!input.scopeObjectiveId) throw new ValidationError(['Objective-scoped guidance must name the objective it guides.']);
    const rows = await tx
      .select({ id: objectives.id })
      .from(objectives)
      .where(and(eq(objectives.id, input.scopeObjectiveId), eq(objectives.projectId, ctx.projectId), eq(objectives.orgId, ctx.orgId)))
      .limit(1);
    if (rows.length === 0) throw new ValidationError(['That objective is not in this workspace.']);
    return { scopeTaskId: null, scopeObjectiveId: input.scopeObjectiveId };
  }
  return { scopeTaskId: null, scopeObjectiveId: null }; // workspace scope
}

export const createDecisionSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200),
  summary: z.string().trim().min(1, 'Summary is required').max(2_000),
  rationale: z.string().trim().max(4_000).default(''),
  decisionType: z.enum(DECISION_TYPES).default('operational'),
  // Record-only vs active guidance, and — for guidance — its scope + concrete target + optional
  // validity. Default narrow: institutional memory defaults to the narrowest scope its evidence
  // supports. A guidance scope MUST name a concrete target (see assertScopeTargets).
  applicability: z.enum(DECISION_APPLICABILITY).default('guidance'),
  scope: z.enum(DECISION_SCOPES).default('workspace'),
  scopeTaskId: z.string().uuid().nullable().default(null),
  scopeObjectiveId: z.string().uuid().nullable().default(null),
  effectiveUntil: z.coerce.date().nullable().default(null),
  originatingTaskId: z.string().uuid().nullable().default(null),
  originatingRunId: z.string().uuid().nullable().default(null),
  supportingRefs: z.array(z.string().trim().max(400)).max(50).default([]),
  /** Supersede a prior accepted decision atomically on acceptance. */
  supersedesId: z.string().uuid().nullable().default(null),
});
export type CreateDecisionInput = z.input<typeof createDecisionSchema>;

/**
 * Records a decision as `proposed` (a candidate awaiting human approval).
 * Deliberately never auto-created — a human identifies and files it.
 */
export async function createDecision(
  tx: DbTx,
  ctx: TenantContext,
  authorLabel: string,
  input: CreateDecisionInput,
): Promise<string> {
  const parsed = createDecisionSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message));

  const targets = await assertScopeTargets(tx, ctx, parsed.data);

  const inserted = await tx
    .insert(decisions)
    .values({
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      title: parsed.data.title,
      summary: parsed.data.summary,
      rationale: parsed.data.rationale,
      decisionType: parsed.data.decisionType,
      applicability: parsed.data.applicability,
      scope: parsed.data.scope,
      scopeTaskId: targets.scopeTaskId,
      scopeObjectiveId: targets.scopeObjectiveId,
      effectiveUntil: parsed.data.effectiveUntil,
      originatingTaskId: parsed.data.originatingTaskId,
      originatingRunId: parsed.data.originatingRunId,
      supportingRefs: parsed.data.supportingRefs,
      authorId: ctx.userId,
      authorLabel,
      status: 'proposed',
    })
    .returning({ id: decisions.id });
  const id = inserted[0]!.id;

  await writeAudit(tx, ctx, {
    action: 'decision.proposed',
    entityType: 'decision',
    entityId: id,
    detail: { title: parsed.data.title, type: parsed.data.decisionType },
  });
  // Remember the intended supersession for when this candidate is accepted.
  if (parsed.data.supersedesId) {
    await tx
      .update(decisions)
      .set({ supportingRefs: [...parsed.data.supportingRefs, `supersedes:${parsed.data.supersedesId}`] })
      .where(and(eq(decisions.id, id), eq(decisions.projectId, ctx.projectId)));
  }
  return id;
}

async function loadDecision(tx: DbTx, ctx: TenantContext, id: string) {
  const rows = await tx
    .select()
    .from(decisions)
    .where(and(eq(decisions.id, id), eq(decisions.projectId, ctx.projectId), eq(decisions.orgId, ctx.orgId)))
    .limit(1);
  assertScoped(rows, ctx, 'loadDecision');
  const d = rows[0];
  if (!d) throw new NotFoundError('Decision');
  return d;
}

/**
 * Approves a proposed decision → `accepted`. If it was filed to supersede a
 * prior decision, that prior is marked `superseded` and pointed at this one,
 * atomically. Only an admin may approve.
 */
export const promoteDecisionSchema = z.object({
  applicability: z.enum(DECISION_APPLICABILITY),
  scope: z.enum(DECISION_SCOPES).default('workspace'),
  scopeTaskId: z.string().uuid().nullable().default(null),
  scopeObjectiveId: z.string().uuid().nullable().default(null),
  effectiveUntil: z.coerce.date().nullable().default(null),
});
export type PromoteDecisionInput = z.input<typeof promoteDecisionSchema>;

/**
 * Approve a proposed decision → `accepted`. Acceptance alone NEVER activates reusable guidance: a
 * proposal keeps its filed applicability (AI candidates are record-only) unless the operator
 * EXPLICITLY promotes it here by passing `promote`, which then requires a concrete scope. Only the
 * operator may activate reuse; AI suggestion confidence carries no authority. If it was filed to
 * supersede a prior decision, that prior is marked `superseded` atomically. Admin only.
 */
export async function acceptDecision(
  tx: DbTx,
  ctx: TenantContext,
  id: string,
  promote?: PromoteDecisionInput,
): Promise<void> {
  if (ctx.projectRole !== 'admin') throw new AppError('forbidden', 'Only admins can approve decisions.');
  const d = await loadDecision(tx, ctx, id);
  if (d.status !== 'proposed') throw new ConflictError(`Only a proposed decision can be accepted (is ${d.status}).`);

  let promotion: { applicability: DecisionApplicability; scope: DecisionScope; scopeTaskId: string | null; scopeObjectiveId: string | null; effectiveUntil: Date | null } | null = null;
  if (promote) {
    const parsed = promoteDecisionSchema.safeParse(promote);
    if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message));
    const targets = await assertScopeTargets(tx, ctx, parsed.data);
    promotion = { applicability: parsed.data.applicability, scope: parsed.data.scope, ...targets, effectiveUntil: parsed.data.effectiveUntil };
  }

  await tx
    .update(decisions)
    .set({
      status: 'accepted',
      reviewedBy: ctx.userId,
      reviewedAt: new Date(),
      updatedAt: new Date(),
      ...(promotion
        ? {
            applicability: promotion.applicability,
            scope: promotion.scope,
            scopeTaskId: promotion.scopeTaskId,
            scopeObjectiveId: promotion.scopeObjectiveId,
            effectiveUntil: promotion.effectiveUntil,
          }
        : {}),
    })
    .where(eq(decisions.id, id));

  const supersedesRef = d.supportingRefs.find((r) => r.startsWith('supersedes:'));
  if (supersedesRef) {
    const priorId = supersedesRef.slice('supersedes:'.length);
    const prior = await loadDecision(tx, ctx, priorId).catch(() => null);
    if (prior && prior.status === 'accepted') {
      await tx
        .update(decisions)
        .set({ status: 'superseded', supersededBy: id, updatedAt: new Date() })
        .where(eq(decisions.id, priorId));
      await writeAudit(tx, ctx, {
        action: 'decision.superseded',
        entityType: 'decision',
        entityId: priorId,
        detail: { by: id, title: prior.title },
      });
    }
  }

  await writeAudit(tx, ctx, {
    action: 'decision.accepted',
    entityType: 'decision',
    entityId: id,
    detail: { title: d.title },
  });
}

export async function rejectDecision(tx: DbTx, ctx: TenantContext, id: string, reason?: string): Promise<void> {
  if (ctx.projectRole !== 'admin') throw new AppError('forbidden', 'Only admins can reject decisions.');
  const d = await loadDecision(tx, ctx, id);
  if (d.status === 'superseded' || d.status === 'rejected' || d.status === 'retired') {
    throw new ConflictError('This decision is already closed.');
  }
  const r = (reason ?? '').trim() || null;
  await tx
    .update(decisions)
    .set({ status: 'rejected', statusReason: r, reviewedBy: ctx.userId, reviewedAt: new Date(), updatedAt: new Date() })
    .where(eq(decisions.id, id));
  await writeAudit(tx, ctx, {
    action: 'decision.rejected',
    entityType: 'decision',
    entityId: id,
    detail: { title: d.title, reason: r },
  });
}

export interface DecisionLifecycleEvent {
  action: string;
  actorName: string | null;
  reason: string | null;
  at: Date;
}

/**
 * Lifecycle provenance for a decision, read from the append-only audit log — who proposed / accepted
 * / rejected / retired / superseded it, when, and (where recorded) why. The Hub surfaces only what it
 * has actually recorded; it never substitutes the author for the acceptor.
 */
export async function getDecisionLifecycle(tx: DbTx, ctx: TenantContext, decisionId: string): Promise<DecisionLifecycleEvent[]> {
  const rows = await tx
    .select({ action: auditLogs.action, actorName: profiles.displayName, detail: auditLogs.detail, at: auditLogs.createdAt })
    .from(auditLogs)
    .leftJoin(profiles, eq(auditLogs.actorId, profiles.id))
    .where(and(eq(auditLogs.orgId, ctx.orgId), eq(auditLogs.entityType, 'decision'), eq(auditLogs.entityId, decisionId)))
    .orderBy(auditLogs.createdAt);
  return rows.map((r) => ({
    action: r.action,
    actorName: r.actorName,
    reason: (r.detail as { reason?: string } | null)?.reason ?? null,
    at: r.at,
  }));
}

/**
 * Retire an accepted decision — it remains a historically valid record but stops guiding future work,
 * with no replacement (distinct from supersession). A record may be permanent; operational authority
 * remains reviewable. Only an admin, only from `accepted`.
 */
export async function retireDecision(tx: DbTx, ctx: TenantContext, id: string, reason?: string): Promise<void> {
  if (ctx.projectRole !== 'admin') throw new AppError('forbidden', 'Only admins can retire decisions.');
  const d = await loadDecision(tx, ctx, id);
  if (d.status !== 'accepted') throw new ConflictError(`Only an accepted decision can be retired (is ${d.status}).`);
  // Retirement means "no longer ACTIVE GUIDANCE." A record-only decision was never active guidance,
  // so retiring it is meaningless — it stays an accepted record.
  if (d.applicability !== 'guidance') {
    throw new ConflictError('Only active guidance can be retired; a record-only decision is already inactive.');
  }
  const r = (reason ?? '').trim() || null;
  await tx
    .update(decisions)
    .set({ status: 'retired', statusReason: r, reviewedBy: ctx.userId, reviewedAt: new Date(), updatedAt: new Date() })
    .where(eq(decisions.id, id));
  await writeAudit(tx, ctx, { action: 'decision.retired', entityType: 'decision', entityId: id, detail: { title: d.title, reason: r } });
}

export interface DecisionRow {
  id: string;
  title: string;
  summary: string;
  rationale: string;
  decisionType: DecisionType;
  status: DecisionStatus;
  applicability: DecisionApplicability;
  scope: DecisionScope;
  scopeTaskId: string | null;
  scopeObjectiveId: string | null;
  effectiveUntil: Date | null;
  statusReason: string | null;
  authorLabel: string;
  suggestedByRunId: string | null;
  /** The AI's RECOMMENDED reuse (evidence for review), separate from the actual applicability/scope above. */
  suggestedApplicability: DecisionApplicability | null;
  suggestedScope: DecisionScope | null;
  suggestionConfidence: string | null;
  suggestionReason: string | null;
  originatingTaskId: string | null;
  originatingTaskTitle: string | null;
  supersededBy: string | null;
  ownerAgentId: string | null;
  createdAt: Date;
}

export async function listDecisions(tx: DbTx, ctx: TenantContext): Promise<DecisionRow[]> {
  const rows = await tx
    .select({
      id: decisions.id,
      title: decisions.title,
      summary: decisions.summary,
      rationale: decisions.rationale,
      decisionType: decisions.decisionType,
      status: decisions.status,
      applicability: decisions.applicability,
      scope: decisions.scope,
      scopeTaskId: decisions.scopeTaskId,
      scopeObjectiveId: decisions.scopeObjectiveId,
      effectiveUntil: decisions.effectiveUntil,
      statusReason: decisions.statusReason,
      authorLabel: decisions.authorLabel,
      suggestedByRunId: decisions.suggestedByRunId,
      suggestedApplicability: decisions.suggestedApplicability,
      suggestedScope: decisions.suggestedScope,
      suggestionConfidence: decisions.suggestionConfidence,
      suggestionReason: decisions.suggestionReason,
      originatingTaskId: decisions.originatingTaskId,
      originatingTaskTitle: tasks.title,
      supersededBy: decisions.supersededBy,
      ownerAgentId: decisions.ownerAgentId,
      createdAt: decisions.createdAt,
      orgId: decisions.orgId,
      projectId: decisions.projectId,
    })
    .from(decisions)
    .leftJoin(tasks, eq(decisions.originatingTaskId, tasks.id))
    .where(and(eq(decisions.projectId, ctx.projectId), eq(decisions.orgId, ctx.orgId)))
    .orderBy(desc(decisions.createdAt));
  assertScoped(rows, ctx, 'listDecisions');
  return rows.map(({ orgId: _o, projectId: _p, ...r }) => r);
}

export interface CandidateRow {
  id: string;
  title: string;
  summary: string;
  rationale: string;
  decisionType: DecisionType;
  confidence: string | null;
  evidence: string | null;
  supersedesId: string | null;
  supersedesTitle: string | null;
  originatingTaskId: string | null;
  suggestedByRunId: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
}

/** AI-suggested candidates (proposed, suggested_by_run_id set) for a task. */
export async function listCandidatesForTask(
  tx: DbTx,
  ctx: TenantContext,
  taskId: string,
): Promise<CandidateRow[]> {
  const rows = await tx
    .select()
    .from(decisions)
    .where(
      and(
        eq(decisions.projectId, ctx.projectId),
        eq(decisions.orgId, ctx.orgId),
        eq(decisions.originatingTaskId, taskId),
        eq(decisions.status, 'proposed'),
      ),
    )
    .orderBy(desc(decisions.createdAt));
  assertScoped(rows, ctx, 'listCandidatesForTask');
  const aiCandidates = rows.filter((r) => r.suggestedByRunId != null);

  // Resolve supersession target titles for display.
  const supersedesIds = aiCandidates
    .map((r) => r.supportingRefs.find((x) => x.startsWith('supersedes:'))?.slice('supersedes:'.length))
    .filter((x): x is string => !!x);
  const titles = supersedesIds.length
    ? await tx
        .select({ id: decisions.id, title: decisions.title, orgId: decisions.orgId, projectId: decisions.projectId })
        .from(decisions)
        .where(and(eq(decisions.projectId, ctx.projectId), eq(decisions.orgId, ctx.orgId), inArray(decisions.id, supersedesIds)))
    : [];
  const titleById = new Map(titles.map((t) => [t.id, t.title]));

  return aiCandidates.map((r) => {
    const sid = r.supportingRefs.find((x) => x.startsWith('supersedes:'))?.slice('supersedes:'.length) ?? null;
    return {
      id: r.id,
      title: r.title,
      summary: r.summary,
      rationale: r.rationale,
      decisionType: r.decisionType,
      confidence: r.suggestionConfidence,
      evidence: r.suggestionReason,
      supersedesId: sid,
      supersedesTitle: sid ? (titleById.get(sid) ?? null) : null,
      originatingTaskId: r.originatingTaskId,
      suggestedByRunId: r.suggestedByRunId,
      reviewedAt: r.reviewedAt,
      createdAt: r.createdAt,
    };
  });
}

export const editCandidateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(2_000),
  rationale: z.string().trim().max(4_000).default(''),
});

/** Edit a proposed candidate's content before accepting (human correction). */
export async function editCandidate(
  tx: DbTx,
  ctx: TenantContext,
  id: string,
  input: z.input<typeof editCandidateSchema>,
): Promise<void> {
  if (ctx.projectRole !== 'admin') throw new AppError('forbidden', 'Only admins can edit candidates.');
  const parsed = editCandidateSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message));
  const d = await loadDecision(tx, ctx, id);
  if (d.status !== 'proposed') throw new ConflictError('Only a proposed candidate can be edited.');
  await tx
    .update(decisions)
    .set({ title: parsed.data.title, summary: parsed.data.summary, rationale: parsed.data.rationale, updatedAt: new Date() })
    .where(eq(decisions.id, id));
  await writeAudit(tx, ctx, { action: 'decision.candidate_edited', entityType: 'decision', entityId: id, detail: { title: parsed.data.title } });
}

/** Defer a candidate: mark reviewed, leave it proposed (out of the active queue,
 *  still NOT injected into Decision Memory — only accepted decisions are). */
export async function deferCandidate(tx: DbTx, ctx: TenantContext, id: string): Promise<void> {
  if (ctx.projectRole !== 'admin') throw new AppError('forbidden', 'Only admins can defer candidates.');
  const d = await loadDecision(tx, ctx, id);
  if (d.status !== 'proposed') throw new ConflictError('Only a proposed candidate can be deferred.');
  await tx
    .update(decisions)
    .set({ reviewedBy: ctx.userId, reviewedAt: new Date(), updatedAt: new Date() })
    .where(eq(decisions.id, id));
  await writeAudit(tx, ctx, { action: 'decision.candidate_deferred', entityType: 'decision', entityId: id, detail: { title: d.title } });
}

// ---------------------------------------------------------------------------
// Context selector (Level-1 Decision memory)
// ---------------------------------------------------------------------------

interface ScoredDecision extends DecisionRow {
  score: number;
  /** Why this decision was eligible for the run: 'task' | 'objective' | 'reference'. */
  reason: string;
  supersedes: { title: string }[];
}

/**
 * Retrieves up to MAX_DECISIONS ACCEPTED decisions relevant to the run, ranked
 * deterministically by (1) same originating task, (2) same objective's tasks,
 * (3) shared document reference, (4) recency. Superseded decisions are never
 * retrieved, so they can never outrank their replacement. Tenant-scoped.
 */
export async function selectRelevantDecisions(
  tx: DbTx,
  ctx: TenantContext,
  args: {
    currentTaskId: string;
    currentObjectiveId: string | null;
    objectiveTaskIds: readonly string[];
    docPaths: ReadonlySet<string>;
  },
): Promise<ScoredDecision[]> {
  const now = new Date();
  const rows = await tx
    .select({
      id: decisions.id,
      title: decisions.title,
      summary: decisions.summary,
      rationale: decisions.rationale,
      decisionType: decisions.decisionType,
      status: decisions.status,
      applicability: decisions.applicability,
      scope: decisions.scope,
      scopeTaskId: decisions.scopeTaskId,
      scopeObjectiveId: decisions.scopeObjectiveId,
      scopeTaskStatus: scopeTask.status,
      scopeObjectiveStatus: scopeObjective.status,
      effectiveUntil: decisions.effectiveUntil,
      authorLabel: decisions.authorLabel,
      originatingTaskId: decisions.originatingTaskId,
      supportingRefs: decisions.supportingRefs,
      createdAt: decisions.createdAt,
      orgId: decisions.orgId,
      projectId: decisions.projectId,
    })
    .from(decisions)
    .leftJoin(scopeTask, eq(decisions.scopeTaskId, scopeTask.id))
    .leftJoin(scopeObjective, eq(decisions.scopeObjectiveId, scopeObjective.id))
    .where(
      and(
        eq(decisions.projectId, ctx.projectId),
        eq(decisions.orgId, ctx.orgId),
        eq(decisions.status, 'accepted'),
        // Only ACTIVE GUIDANCE is ever injected: record-only conclusions are never applied, and a
        // time-bounded decision past its validity is historical, not active.
        eq(decisions.applicability, 'guidance'),
        or(isNull(decisions.effectiveUntil), gt(decisions.effectiveUntil, now)),
      ),
    )
    .orderBy(desc(decisions.createdAt));
  assertScoped(rows, ctx, 'selectRelevantDecisions');
  if (rows.length === 0) return [];

  const objTasks = new Set(args.objectiveTaskIds);
  const nowMs = now.getTime();
  const TERMINAL_TASK = new Set(['completed', 'cancelled']);
  const CLOSED_OBJECTIVE = new Set(['completed', 'cancelled']);

  // Two distinct stages. ELIGIBILITY: a decision may be considered ONLY within its SCOPE and while
  // that scope is a live operating context — guidance does not outlive the task/objective that gave
  // it meaning. Task-scoped: its concrete task, and only while non-terminal. Objective-scoped: its
  // concrete objective, and only while open. Workspace-scoped: any run it is RELEVANT to (scope is a
  // boundary, not inject-everywhere). No match → omit. `reason` records WHY (for the injection trail).
  // RANKING: recency only orders already-eligible decisions — it can never make one relevant.
  const eligible = rows
    .map((r) => {
      let relationship = 0;
      let reason = '';
      if (r.scope === 'task') {
        if (r.scopeTaskId === args.currentTaskId && !(r.scopeTaskStatus && TERMINAL_TASK.has(r.scopeTaskStatus))) {
          relationship = 1000;
          reason = 'task';
        }
      } else if (r.scope === 'objective') {
        if (
          r.scopeObjectiveId != null &&
          r.scopeObjectiveId === args.currentObjectiveId &&
          !(r.scopeObjectiveStatus && CLOSED_OBJECTIVE.has(r.scopeObjectiveStatus))
        ) {
          relationship = 100;
          reason = 'objective';
        }
      } else {
        // workspace: may guide anywhere it is relevant (by provenance task, sibling objective task, or doc)
        if (r.originatingTaskId === args.currentTaskId) {
          relationship = 1000;
          reason = 'task';
        } else if (r.originatingTaskId != null && objTasks.has(r.originatingTaskId)) {
          relationship = 100;
          reason = 'objective';
        } else if (r.supportingRefs.some((ref) => args.docPaths.has(ref))) {
          relationship = 10;
          reason = 'reference';
        }
      }
      return { r, relationship, reason };
    })
    .filter((s) => s.relationship > 0);
  if (eligible.length === 0) return [];

  const scored = eligible.map(({ r, relationship, reason }) => {
    // Recency boost stays strictly below the smallest relationship tier, so it only breaks ties
    // among eligible decisions — never lifts an ineligible one into range.
    const ageDays = (nowMs - r.createdAt.getTime()) / 86_400_000;
    return { r, reason, score: relationship + Math.max(0, 5 - ageDays / 30) };
  });
  scored.sort((a, b) => b.score - a.score || b.r.createdAt.getTime() - a.r.createdAt.getTime());
  const chosen = scored.slice(0, MAX_DECISIONS);
  const reasonById = new Map(chosen.map((c) => [c.r.id, c.reason]));
  const top = chosen.map((s) => s.r);

  // For each retained decision, find what it superseded (historical lineage) so
  // the prompt can acknowledge the old one without letting it outrank the new.
  const topIds = top.map((t) => t.id);
  const superseded = topIds.length
    ? await tx
        .select({ title: decisions.title, supersededBy: decisions.supersededBy, orgId: decisions.orgId, projectId: decisions.projectId })
        .from(decisions)
        .where(
          and(
            eq(decisions.projectId, ctx.projectId),
            eq(decisions.orgId, ctx.orgId),
            eq(decisions.status, 'superseded'),
            inArray(decisions.supersededBy, topIds),
          ),
        )
    : [];
  assertScoped(superseded, ctx, 'selectRelevantDecisions.superseded');
  const supersededByNew = new Map<string, { title: string }[]>();
  for (const s of superseded) {
    if (!s.supersededBy) continue;
    const arr = supersededByNew.get(s.supersededBy) ?? [];
    arr.push({ title: s.title });
    supersededByNew.set(s.supersededBy, arr);
  }

  return top.map((t) => ({
    id: t.id,
    title: t.title,
    summary: t.summary,
    rationale: t.rationale,
    decisionType: t.decisionType,
    status: t.status,
    applicability: t.applicability,
    scope: t.scope,
    scopeTaskId: t.scopeTaskId,
    scopeObjectiveId: t.scopeObjectiveId,
    effectiveUntil: t.effectiveUntil,
    statusReason: null,
    authorLabel: t.authorLabel,
    suggestedByRunId: null,
    suggestedApplicability: null,
    suggestedScope: null,
    suggestionConfidence: null,
    suggestionReason: null,
    originatingTaskId: t.originatingTaskId,
    originatingTaskTitle: null,
    supersededBy: null,
    ownerAgentId: null,
    createdAt: t.createdAt,
    score: 0,
    reason: reasonById.get(t.id) ?? '',
    supersedes: supersededByNew.get(t.id) ?? [],
  }));
}

export interface DecisionMemoryContext {
  contextItem: ContextItemForPrompt | null;
  manifest: ContextManifestEntry[];
  /** The decisions actually included in this run's context, with why each was eligible and the EXACT
   *  rendered line supplied — the honest reverse trail records these as INJECTED (not "influenced"). */
  injected: { decisionId: string; reason: string; memoryText: string }[];
}

/** Assembles the Level-1 Decision memory block + manifest entries. */
export async function assembleDecisionMemory(
  tx: DbTx,
  ctx: TenantContext,
  args: {
    currentTaskId: string;
    currentObjectiveId: string | null;
    objectiveTaskIds: readonly string[];
    docPaths: ReadonlySet<string>;
  },
): Promise<DecisionMemoryContext> {
  const chosen = await selectRelevantDecisions(tx, ctx, args);
  if (chosen.length === 0) return { contextItem: null, manifest: [], injected: [] };

  const lines: string[] = [
    'DECISION MEMORY (accepted organizational decisions — structured memory, not documents or conversation):',
    'These are settled conclusions. When proposing work, do not contradict an accepted decision; if a proposal would overturn one, say so explicitly and name the decision.',
    '',
  ];
  const lineByDecision = new Map<string, string>();
  for (const d of chosen) {
    const line =
      `- [${d.decisionType}] "${d.title}" — ${d.summary}` +
      (d.rationale ? ` (rationale: ${d.rationale})` : '') +
      ` — decided by ${d.authorLabel} on ${d.createdAt.toISOString().slice(0, 10)}.` +
      (d.supersedes.length > 0
        ? ` This supersedes, and replaces as current: ${d.supersedes.map((s) => `"${s.title}"`).join(', ')} (now historical — do not apply).`
        : '');
    lines.push(line);
    lineByDecision.set(d.id, line);
  }

  const manifest: ContextManifestEntry[] = chosen.map((d) => ({
    source: 'decision_memory' as const,
    label: d.title,
    detail:
      `${d.status} · ${d.decisionType}` +
      (d.originatingTaskId ? ` · from task ${d.originatingTaskId.slice(0, 8)}` : '') +
      ` · ${d.createdAt.toISOString().slice(0, 10)}`,
  }));

  return {
    contextItem: { title: 'Decision memory', content: lines.join('\n') },
    manifest,
    injected: chosen.map((d) => ({ decisionId: d.id, reason: d.reason, memoryText: lineByDecision.get(d.id) ?? '' })),
  };
}

/**
 * Record that these decisions were INJECTED into a run — the honest reverse trail. Called after the
 * run row exists. Not "influence": it states only that the memory was supplied. No-op on empty.
 */
export async function logDecisionInjections(
  tx: DbTx,
  ctx: TenantContext,
  args: { runId: string; taskId: string; injected: { decisionId: string; reason: string; memoryText: string }[] },
): Promise<void> {
  if (args.injected.length === 0) return;
  await tx
    .insert(decisionInjections)
    .values(
      args.injected.map((i) => ({
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        decisionId: i.decisionId,
        runId: args.runId,
        taskId: args.taskId,
        reason: i.reason || 'unspecified',
        memoryText: i.memoryText,
      })),
    )
    // Idempotent: a runner retry must not double-count a (run, decision) application.
    .onConflictDoNothing({ target: [decisionInjections.runId, decisionInjections.decisionId] });
}

export interface InjectionRow {
  runId: string | null;
  taskId: string | null;
  taskTitle: string | null;
  reason: string;
  memoryText: string | null;
  injectedAt: Date;
}

/** The reverse trail for one decision: the runs it was injected into, newest first. */
export async function listInjectionsForDecision(
  tx: DbTx,
  ctx: TenantContext,
  decisionId: string,
): Promise<InjectionRow[]> {
  return tx
    .select({
      runId: decisionInjections.runId,
      taskId: decisionInjections.taskId,
      taskTitle: tasks.title,
      reason: decisionInjections.reason,
      memoryText: decisionInjections.memoryText,
      injectedAt: decisionInjections.injectedAt,
    })
    .from(decisionInjections)
    .leftJoin(tasks, eq(decisionInjections.taskId, tasks.id))
    .where(
      and(
        eq(decisionInjections.decisionId, decisionId),
        eq(decisionInjections.orgId, ctx.orgId),
        eq(decisionInjections.projectId, ctx.projectId),
      ),
    )
    .orderBy(desc(decisionInjections.injectedAt));
}

/**
 * Observe where multiple active-guidance decisions APPLY to the same objective. This is a neutral
 * OVERLAP IN APPLICABILITY, not evidence of conflict: three decisions can govern one objective in
 * perfect harmony (e.g. flat-fee framing + plain language + no external contact sharing). Shared
 * applicability is not evidence of conflict — a conflict assessment needs an additional basis
 * (operator flag, opposition/supersession, incompatible directives), which is future work. So this
 * only reports the observed overlap for the operator to notice; it must not be elevated as a problem.
 */
export function detectSharedApplicability(rows: DecisionRow[]): { objectiveId: string; decisions: DecisionRow[] }[] {
  const active = rows.filter((d) => d.status === 'accepted' && d.applicability === 'guidance' && d.scope === 'objective' && d.scopeObjectiveId);
  const byObjective = new Map<string, DecisionRow[]>();
  for (const d of active) {
    const arr = byObjective.get(d.scopeObjectiveId!) ?? [];
    arr.push(d);
    byObjective.set(d.scopeObjectiveId!, arr);
  }
  return [...byObjective.entries()]
    .filter(([, ds]) => ds.length > 1)
    .map(([objectiveId, decisions]) => ({ objectiveId, decisions }));
}

/** Tasks attached to an objective, for the objective-relationship rank. */
export async function objectiveTaskIds(
  tx: DbTx,
  ctx: TenantContext,
  objectiveId: string | null,
): Promise<string[]> {
  if (!objectiveId) return [];
  const rows = await tx
    .select({ id: tasks.id, orgId: tasks.orgId, projectId: tasks.projectId })
    .from(tasks)
    .where(
      and(
        eq(tasks.objectiveId, objectiveId),
        eq(tasks.projectId, ctx.projectId),
        eq(tasks.orgId, ctx.orgId),
        ne(tasks.id, '00000000-0000-0000-0000-000000000000'),
      ),
    );
  assertScoped(rows, ctx, 'objectiveTaskIds');
  return rows.map((r) => r.id);
}
