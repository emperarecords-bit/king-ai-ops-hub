import 'server-only';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { z } from 'zod';
import {
  DECISION_TYPES,
  type ContextManifestEntry,
  type DecisionStatus,
  type DecisionType,
  type TenantContext,
} from '@/types/domain';
import { AppError, ConflictError, NotFoundError, TenantViolationError, ValidationError } from '@/lib/errors';
import { log } from '@/lib/log';
import { type DbTx } from '@/db/client';
import { decisions, tasks } from '@/db/schema';
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

export const createDecisionSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200),
  summary: z.string().trim().min(1, 'Summary is required').max(2_000),
  rationale: z.string().trim().max(4_000).default(''),
  decisionType: z.enum(DECISION_TYPES).default('operational'),
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

  const inserted = await tx
    .insert(decisions)
    .values({
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      title: parsed.data.title,
      summary: parsed.data.summary,
      rationale: parsed.data.rationale,
      decisionType: parsed.data.decisionType,
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
export async function acceptDecision(tx: DbTx, ctx: TenantContext, id: string): Promise<void> {
  if (ctx.projectRole !== 'admin') throw new AppError('forbidden', 'Only admins can approve decisions.');
  const d = await loadDecision(tx, ctx, id);
  if (d.status !== 'proposed') throw new ConflictError(`Only a proposed decision can be accepted (is ${d.status}).`);

  await tx
    .update(decisions)
    .set({ status: 'accepted', reviewedBy: ctx.userId, reviewedAt: new Date(), updatedAt: new Date() })
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

export async function rejectDecision(tx: DbTx, ctx: TenantContext, id: string): Promise<void> {
  if (ctx.projectRole !== 'admin') throw new AppError('forbidden', 'Only admins can reject decisions.');
  const d = await loadDecision(tx, ctx, id);
  if (d.status === 'superseded' || d.status === 'rejected') {
    throw new ConflictError('This decision is already closed.');
  }
  await tx
    .update(decisions)
    .set({ status: 'rejected', reviewedBy: ctx.userId, reviewedAt: new Date(), updatedAt: new Date() })
    .where(eq(decisions.id, id));
  await writeAudit(tx, ctx, {
    action: 'decision.rejected',
    entityType: 'decision',
    entityId: id,
    detail: { title: d.title },
  });
}

export interface DecisionRow {
  id: string;
  title: string;
  summary: string;
  rationale: string;
  decisionType: DecisionType;
  status: DecisionStatus;
  authorLabel: string;
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
      authorLabel: decisions.authorLabel,
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
  args: { currentTaskId: string; objectiveTaskIds: readonly string[]; docPaths: ReadonlySet<string> },
): Promise<ScoredDecision[]> {
  const rows = await tx
    .select({
      id: decisions.id,
      title: decisions.title,
      summary: decisions.summary,
      rationale: decisions.rationale,
      decisionType: decisions.decisionType,
      status: decisions.status,
      authorLabel: decisions.authorLabel,
      originatingTaskId: decisions.originatingTaskId,
      supportingRefs: decisions.supportingRefs,
      createdAt: decisions.createdAt,
      orgId: decisions.orgId,
      projectId: decisions.projectId,
    })
    .from(decisions)
    .where(
      and(
        eq(decisions.projectId, ctx.projectId),
        eq(decisions.orgId, ctx.orgId),
        eq(decisions.status, 'accepted'),
      ),
    )
    .orderBy(desc(decisions.createdAt));
  assertScoped(rows, ctx, 'selectRelevantDecisions');
  if (rows.length === 0) return [];

  const objTasks = new Set(args.objectiveTaskIds);
  const now = Date.now();

  // Two distinct stages. ELIGIBILITY: a decision may be considered ONLY when a structural
  // relationship to this run establishes relevance (same task · same objective's tasks · shared
  // supporting reference). Until explicit scope exists, no relationship → omit it: silently applying
  // unrelated guidance is worse than reduced recall. RANKING: recency (and, later, precedence) only
  // orders decisions already found eligible — it can never make an irrelevant memory relevant.
  const eligible = rows
    .map((r) => {
      let relationship = 0;
      if (r.originatingTaskId === args.currentTaskId) relationship += 1000;
      if (r.originatingTaskId && objTasks.has(r.originatingTaskId)) relationship += 100;
      if (r.supportingRefs.some((ref) => args.docPaths.has(ref))) relationship += 10;
      return { r, relationship };
    })
    .filter((s) => s.relationship > 0);
  if (eligible.length === 0) return [];

  const scored = eligible.map(({ r, relationship }) => {
    // Recency boost stays strictly below the smallest relationship tier, so it only breaks ties
    // among eligible decisions — never lifts an ineligible one into range.
    const ageDays = (now - r.createdAt.getTime()) / 86_400_000;
    return { r, score: relationship + Math.max(0, 5 - ageDays / 30) };
  });
  scored.sort((a, b) => b.score - a.score || b.r.createdAt.getTime() - a.r.createdAt.getTime());
  const top = scored.slice(0, MAX_DECISIONS).map((s) => s.r);

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
    authorLabel: t.authorLabel,
    originatingTaskId: t.originatingTaskId,
    originatingTaskTitle: null,
    supersededBy: null,
    ownerAgentId: null,
    createdAt: t.createdAt,
    score: 0,
    supersedes: supersededByNew.get(t.id) ?? [],
  }));
}

export interface DecisionMemoryContext {
  contextItem: ContextItemForPrompt | null;
  manifest: ContextManifestEntry[];
}

/** Assembles the Level-1 Decision memory block + manifest entries. */
export async function assembleDecisionMemory(
  tx: DbTx,
  ctx: TenantContext,
  args: { currentTaskId: string; objectiveTaskIds: readonly string[]; docPaths: ReadonlySet<string> },
): Promise<DecisionMemoryContext> {
  const chosen = await selectRelevantDecisions(tx, ctx, args);
  if (chosen.length === 0) return { contextItem: null, manifest: [] };

  const lines: string[] = [
    'DECISION MEMORY (accepted organizational decisions — structured memory, not documents or conversation):',
    'These are settled conclusions. When proposing work, do not contradict an accepted decision; if a proposal would overturn one, say so explicitly and name the decision.',
    '',
  ];
  for (const d of chosen) {
    lines.push(
      `- [${d.decisionType}] "${d.title}" — ${d.summary}` +
        (d.rationale ? ` (rationale: ${d.rationale})` : '') +
        ` — decided by ${d.authorLabel} on ${d.createdAt.toISOString().slice(0, 10)}.` +
        (d.supersedes.length > 0
          ? ` This supersedes, and replaces as current: ${d.supersedes.map((s) => `"${s.title}"`).join(', ')} (now historical — do not apply).`
          : ''),
    );
  }

  const manifest: ContextManifestEntry[] = chosen.map((d) => ({
    source: 'decision_memory' as const,
    label: d.title,
    detail:
      `${d.status} · ${d.decisionType}` +
      (d.originatingTaskId ? ` · from task ${d.originatingTaskId.slice(0, 8)}` : '') +
      ` · ${d.createdAt.toISOString().slice(0, 10)}`,
  }));

  return { contextItem: { title: 'Decision memory', content: lines.join('\n') }, manifest };
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
