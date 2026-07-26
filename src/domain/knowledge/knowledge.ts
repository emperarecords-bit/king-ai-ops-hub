import { and, asc, desc, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import {
  KNOWLEDGE_DISCLOSURES,
  KNOWLEDGE_EPISTEMIC_BASES,
  KNOWLEDGE_KINDS,
  KNOWLEDGE_SCOPE_KINDS,
  type KnowledgeKind,
  type KnowledgeSource,
  type KnowledgeStatus,
  type TenantContext,
} from '@/types/domain';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors';
import { type DbTx } from '@/db/client';
import { auditLogs, knowledgeInjections, knowledgeItems, objectives, profiles, tasks } from '@/db/schema';
import { writeAudit } from '@/domain/audit/audit';
import { knowledgeRelevance, significantTerms } from '@/domain/knowledge/relevance';
import { assessKnowledge, qualificationLabel, type KnowledgeUseIntent } from '@/domain/knowledge/assess';

const scopeTask = alias(tasks, 'k_scope_task');
const scopeObjective = alias(objectives, 'k_scope_objective');

/**
 * Company Knowledge lifecycle (K1 — KNOWLEDGE-DESIGN.md). The rules this
 * module exists to enforce:
 *
 *  1. Knowledge is versioned, never edited: a change is a NEW row with
 *     `supersedes` lineage. Activating a version archives its predecessor in
 *     the same transaction — two versions of one item can never inject
 *     together.
 *  2. Humans gate the loop: only `active` items reach prompts, and
 *     activation records who approved and when. Model-proposed knowledge
 *     (K2's promotion path) lands as `draft` — the quarantine state.
 *  3. Every transition is audited. Knowledge shapes every future run, so its
 *     history is decision history.
 */

export const createKnowledgeSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200),
  body: z.string().trim().min(1, 'Body is required').max(20_000),
  kind: z.enum(KNOWLEDGE_KINDS).default('fact'),
  // Trust facts. Epistemic basis defaults to human_asserted (a person wrote it). Verification is
  // ALWAYS 'unverified' at creation — activation is not verification. Scope defaults narrowest-safe
  // to workspace (task/objective require a concrete target). Disclosure defaults workspace_internal.
  epistemicBasis: z.enum(KNOWLEDGE_EPISTEMIC_BASES).default('human_asserted'),
  scopeKind: z.enum(KNOWLEDGE_SCOPE_KINDS).default('workspace'),
  scopeTaskId: z.string().uuid().nullable().default(null),
  scopeObjectiveId: z.string().uuid().nullable().default(null),
  disclosure: z.enum(KNOWLEDGE_DISCLOSURES).default('workspace_internal'),
  asOf: z.coerce.date().nullable().default(null),
  reviewAfter: z.coerce.date().nullable().default(null),
  expiresAt: z.coerce.date().nullable().default(null),
  /** Human authors may activate immediately — the author IS the approver (still NOT verification). */
  activate: z.boolean().default(false),
});

/** Validate a knowledge scope target belongs to this workspace; workspace scope carries no target. */
async function assertKnowledgeScope(
  tx: DbTx,
  ctx: TenantContext,
  input: { scopeKind: 'task' | 'objective' | 'workspace'; scopeTaskId: string | null; scopeObjectiveId: string | null },
): Promise<{ scopeTaskId: string | null; scopeObjectiveId: string | null }> {
  if (input.scopeKind === 'task') {
    if (!input.scopeTaskId) throw new ValidationError(['Task-scoped knowledge must name the task it concerns.']);
    const rows = await tx.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.id, input.scopeTaskId), eq(tasks.projectId, ctx.projectId), eq(tasks.orgId, ctx.orgId))).limit(1);
    if (rows.length === 0) throw new ValidationError(['That task is not in this workspace.']);
    return { scopeTaskId: input.scopeTaskId, scopeObjectiveId: null };
  }
  if (input.scopeKind === 'objective') {
    if (!input.scopeObjectiveId) throw new ValidationError(['Objective-scoped knowledge must name the objective it concerns.']);
    const rows = await tx.select({ id: objectives.id }).from(objectives).where(and(eq(objectives.id, input.scopeObjectiveId), eq(objectives.projectId, ctx.projectId), eq(objectives.orgId, ctx.orgId))).limit(1);
    if (rows.length === 0) throw new ValidationError(['That objective is not in this workspace.']);
    return { scopeTaskId: null, scopeObjectiveId: input.scopeObjectiveId };
  }
  return { scopeTaskId: null, scopeObjectiveId: null };
}

export interface KnowledgeRow {
  id: string;
  kind: KnowledgeKind;
  title: string;
  body: string;
  version: number;
  supersedes: string | null;
  status: KnowledgeStatus;
  source: KnowledgeSource;
  approvedAt: Date | null;
  createdAt: Date;
}

const rowSelection = {
  id: knowledgeItems.id,
  kind: knowledgeItems.kind,
  title: knowledgeItems.title,
  body: knowledgeItems.body,
  version: knowledgeItems.version,
  supersedes: knowledgeItems.supersedes,
  status: knowledgeItems.status,
  source: knowledgeItems.source,
  approvedAt: knowledgeItems.approvedAt,
  createdAt: knowledgeItems.createdAt,
};

function scopeWhere(ctx: TenantContext) {
  return and(
    eq(knowledgeItems.projectId, ctx.projectId),
    eq(knowledgeItems.orgId, ctx.orgId),
    eq(knowledgeItems.scope, 'project'),
  );
}

export async function listKnowledge(
  tx: DbTx,
  ctx: TenantContext,
  status?: KnowledgeStatus,
): Promise<KnowledgeRow[]> {
  const base = scopeWhere(ctx);
  return tx
    .select(rowSelection)
    .from(knowledgeItems)
    .where(status ? and(base, eq(knowledgeItems.status, status)) : base)
    .orderBy(asc(knowledgeItems.kind), asc(knowledgeItems.title), desc(knowledgeItems.version));
}

async function getItem(tx: DbTx, ctx: TenantContext, itemId: string) {
  const rows = await tx
    .select(rowSelection)
    .from(knowledgeItems)
    .where(and(eq(knowledgeItems.id, itemId), scopeWhere(ctx)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new NotFoundError('Knowledge item');
  return row;
}

export async function createKnowledge(
  tx: DbTx,
  ctx: TenantContext,
  input: z.input<typeof createKnowledgeSchema>,
): Promise<string> {
  const parsed = createKnowledgeSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message));

  const targets = await assertKnowledgeScope(tx, ctx, parsed.data);
  const now = new Date();
  const inserted = await tx
    .insert(knowledgeItems)
    .values({
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      scope: 'project',
      kind: parsed.data.kind,
      title: parsed.data.title,
      body: parsed.data.body,
      status: parsed.data.activate ? 'active' : 'draft',
      source: 'manual',
      // Epistemic basis is set at creation; verification is ALWAYS unverified here (activation ≠
      // verification). Scope/disclosure/temporal facts carry through.
      epistemicBasis: parsed.data.epistemicBasis,
      verification: 'unverified',
      scopeKind: parsed.data.scopeKind,
      scopeTaskId: targets.scopeTaskId,
      scopeObjectiveId: targets.scopeObjectiveId,
      disclosure: parsed.data.disclosure,
      asOf: parsed.data.asOf,
      reviewAfter: parsed.data.reviewAfter,
      expiresAt: parsed.data.expiresAt,
      createdBy: ctx.userId,
      approvedBy: parsed.data.activate ? ctx.userId : null,
      approvedAt: parsed.data.activate ? now : null,
    })
    .returning({ id: knowledgeItems.id });
  const itemId = inserted[0]!.id;

  await writeAudit(tx, ctx, {
    action: parsed.data.activate ? 'knowledge.created_active' : 'knowledge.created_draft',
    entityType: 'knowledge_item',
    entityId: itemId,
    detail: { title: parsed.data.title, kind: parsed.data.kind },
  });
  return itemId;
}

/**
 * Draft → active. If this version supersedes another item, the predecessor is
 * archived HERE, atomically — rule 1's enforcement point.
 */
export async function activateKnowledge(
  tx: DbTx,
  ctx: TenantContext,
  itemId: string,
): Promise<void> {
  const item = await getItem(tx, ctx, itemId);
  if (item.status !== 'draft') {
    throw new ConflictError(`Only drafts can be activated; this item is ${item.status}.`);
  }

  if (item.supersedes) {
    await tx
      .update(knowledgeItems)
      .set({ status: 'archived', updatedAt: new Date() })
      .where(and(eq(knowledgeItems.id, item.supersedes), scopeWhere(ctx)));
  }

  await tx
    .update(knowledgeItems)
    .set({ status: 'active', approvedBy: ctx.userId, approvedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(knowledgeItems.id, itemId), scopeWhere(ctx)));

  await writeAudit(tx, ctx, {
    action: 'knowledge.activated',
    entityType: 'knowledge_item',
    entityId: itemId,
    detail: { title: item.title, version: item.version, superseded: item.supersedes },
  });
}

/**
 * Set a record's VERIFICATION state — an evidenced, audited lifecycle event, never a free label.
 * Preconditions are enforced: `human_confirmed` is an explicit human affirmation (actor + timestamp
 * recorded); `disputed` requires a rationale; `source_supported` requires at least one RESOLVED
 * supporting source and `system_verified` a recorded deterministic check — neither exists until the
 * provenance increment, so both are rejected here rather than allowing an unsupported label. Who/when/
 * why live in the append-only audit event. A record-wide numeric confidence is intentionally NOT
 * modeled — one body may hold many claims with different support.
 */
export async function setKnowledgeVerification(
  tx: DbTx,
  ctx: TenantContext,
  itemId: string,
  verification: 'unverified' | 'human_confirmed' | 'source_supported' | 'system_verified' | 'disputed',
  reason?: string,
): Promise<void> {
  const item = await getItem(tx, ctx, itemId);
  const r = (reason ?? '').trim() || null;

  if (verification === 'source_supported') {
    throw new ConflictError('source_supported requires at least one resolvable supporting source — attach and resolve a source first (provenance increment).');
  }
  if (verification === 'system_verified') {
    throw new ConflictError('system_verified requires a recorded deterministic check and verifier identity, which is not yet available.');
  }
  if (verification === 'disputed' && !r) {
    throw new ValidationError(['A rationale is required to mark a record disputed — the reason is operational memory.']);
  }

  // `human_confirmed` is a positive verification event → stamp verifiedAt; others clear it.
  const verifiedAt = verification === 'human_confirmed' ? new Date() : null;
  await tx
    .update(knowledgeItems)
    .set({ verification, verifiedAt, updatedAt: new Date() })
    .where(and(eq(knowledgeItems.id, itemId), scopeWhere(ctx)));
  await writeAudit(tx, ctx, {
    action: 'knowledge.verification_set',
    entityType: 'knowledge_item',
    entityId: itemId,
    detail: { title: item.title, verification, reason: r },
  });
}

export interface KnowledgeVerificationEvent {
  verification: string | null;
  reason: string | null;
  actorName: string | null;
  at: Date;
}

/** Verification history from the append-only audit log — who set each state, when, and why. */
export async function getKnowledgeVerificationHistory(tx: DbTx, ctx: TenantContext, itemId: string): Promise<KnowledgeVerificationEvent[]> {
  const rows = await tx
    .select({ detail: auditLogs.detail, actorName: profiles.displayName, at: auditLogs.createdAt })
    .from(auditLogs)
    .leftJoin(profiles, eq(auditLogs.actorId, profiles.id))
    .where(and(eq(auditLogs.orgId, ctx.orgId), eq(auditLogs.entityType, 'knowledge_item'), eq(auditLogs.entityId, itemId), eq(auditLogs.action, 'knowledge.verification_set')))
    .orderBy(auditLogs.createdAt);
  return rows.map((x) => {
    const d = x.detail as { verification?: string; reason?: string } | null;
    return { verification: d?.verification ?? null, reason: d?.reason ?? null, actorName: x.actorName, at: x.at };
  });
}

export async function archiveKnowledge(
  tx: DbTx,
  ctx: TenantContext,
  itemId: string,
): Promise<void> {
  const item = await getItem(tx, ctx, itemId);
  if (item.status === 'archived') {
    throw new ConflictError('This item is already archived.');
  }
  await tx
    .update(knowledgeItems)
    .set({ status: 'archived', updatedAt: new Date() })
    .where(and(eq(knowledgeItems.id, itemId), scopeWhere(ctx)));

  await writeAudit(tx, ctx, {
    action: 'knowledge.archived',
    entityType: 'knowledge_item',
    entityId: itemId,
    detail: { title: item.title, version: item.version },
  });
}

// ---------------------------------------------------------------------------
// Relevance-gated retrieval + application records (evidence, not wholesale charter)
// ---------------------------------------------------------------------------

const MAX_KNOWLEDGE = 12;

export interface SelectedKnowledge {
  id: string;
  version: number;
  title: string;
  body: string;
  /** Why it was eligible for this run: 'subject' (shared vocabulary) today. */
  reason: string;
  /** The exact text supplied to the AI — snapshotted into the application record. */
  memoryText: string;
}

/**
 * Two-stage selection replacing wholesale injection. ELIGIBILITY: an active item may be considered
 * only when it has a defensible relationship to the run — today, shared subject vocabulary with the
 * run's query (workspace membership alone is never enough). RANKING: shared-term strength, then
 * recency (recency ranks, never creates relevance). No relationship → omitted. Bounded to
 * MAX_KNOWLEDGE. Only ACTIVE items are eligible; a superseded predecessor is archived, so two
 * versions of one item can never both be supplied.
 */
export async function selectRelevantKnowledge(
  tx: DbTx,
  ctx: TenantContext,
  args: {
    queryText: string;
    currentTaskId?: string | null;
    currentObjectiveId?: string | null;
    /** How the consumer intends to use the records (default: current operational fact). */
    intendedUse?: KnowledgeUseIntent;
  },
): Promise<SelectedKnowledge[]> {
  const rows = await tx
    .select({
      id: knowledgeItems.id,
      title: knowledgeItems.title,
      body: knowledgeItems.body,
      version: knowledgeItems.version,
      createdAt: knowledgeItems.createdAt,
      status: knowledgeItems.status,
      epistemicBasis: knowledgeItems.epistemicBasis,
      verification: knowledgeItems.verification,
      asOf: knowledgeItems.asOf,
      verifiedAt: knowledgeItems.verifiedAt,
      reviewAfter: knowledgeItems.reviewAfter,
      expiresAt: knowledgeItems.expiresAt,
      scopeKind: knowledgeItems.scopeKind,
      scopeTaskId: knowledgeItems.scopeTaskId,
      scopeObjectiveId: knowledgeItems.scopeObjectiveId,
      scopeTaskStatus: scopeTask.status,
      scopeObjectiveStatus: scopeObjective.status,
      disclosure: knowledgeItems.disclosure,
    })
    .from(knowledgeItems)
    .leftJoin(scopeTask, eq(knowledgeItems.scopeTaskId, scopeTask.id))
    .leftJoin(scopeObjective, eq(knowledgeItems.scopeObjectiveId, scopeObjective.id))
    .where(and(eq(knowledgeItems.projectId, ctx.projectId), eq(knowledgeItems.orgId, ctx.orgId), eq(knowledgeItems.scope, 'project'), eq(knowledgeItems.status, 'active')));
  if (rows.length === 0) return [];

  const now = new Date();
  const nowMs = now.getTime();
  const intendedUse: KnowledgeUseIntent = args.intendedUse ?? 'current_operational_fact';
  const queryTerms = significantTerms(args.queryText);

  const scored: { r: (typeof rows)[number]; reason: string; qualification: string; score: number }[] = [];
  for (const r of rows) {
    // Order: lifecycle → version(active) → disclosure → scope validity → freshness/verification.
    // v1 disclosure: `restricted` has no grant path yet, so it is not permitted for any consumer.
    const a = assessKnowledge({
      status: r.status,
      epistemicBasis: r.epistemicBasis,
      verification: r.verification,
      asOf: r.asOf,
      verifiedAt: r.verifiedAt,
      reviewAfter: r.reviewAfter,
      expiresAt: r.expiresAt,
      scopeKind: r.scopeKind,
      scopeTaskId: r.scopeTaskId,
      scopeObjectiveId: r.scopeObjectiveId,
      scopeTaskStatus: r.scopeTaskStatus,
      scopeObjectiveStatus: r.scopeObjectiveStatus,
      disclosure: r.disclosure,
      disclosurePermitted: r.disclosure !== 'restricted',
      intendedUse,
      now,
    });
    if (a.useState === 'withheld') continue; // failed a hard gate before relevance — no scoring, no text

    // Scope RELEVANCE: a record failing scope is not rescued by lexical overlap.
    let relScore = 0;
    let reason = '';
    if (r.scopeKind === 'task') {
      if (r.scopeTaskId && r.scopeTaskId === args.currentTaskId) { relScore = 1000; reason = 'task'; }
    } else if (r.scopeKind === 'objective') {
      if (r.scopeObjectiveId && r.scopeObjectiveId === args.currentObjectiveId) { relScore = 100; reason = 'objective'; }
    } else {
      const rel = knowledgeRelevance(`${r.title} ${r.body}`, queryTerms);
      if (rel.eligible) { relScore = rel.score; reason = `subject: ${rel.sharedTerms.join(', ')}`; }
    }
    if (relScore === 0) continue;

    const ageDays = (nowMs - r.createdAt.getTime()) / 86_400_000;
    const qualification = a.useState === 'usable_with_qualification' ? qualificationLabel(a) : '';
    scored.push({ r, reason, qualification, score: relScore + Math.max(0, 1 - ageDays / 90) });
  }
  scored.sort((x, y) => y.score - x.score || y.r.createdAt.getTime() - x.r.createdAt.getTime());

  return scored.slice(0, MAX_KNOWLEDGE).map(({ r, reason, qualification }) => ({
    id: r.id,
    version: r.version,
    title: r.title,
    body: r.body,
    reason,
    // Qualified rendering: a qualified record carries its bracket label so the model uses it responsibly.
    memoryText: qualification ? `${qualification}\n${r.title}\n${r.body}` : `${r.title}\n${r.body}`,
  }));
}

/**
 * Record that these knowledge items were supplied to an AI consumer — EVERY consumer (task run,
 * objective suggestion, future operations) leaves the same inspectable, immutable record. Idempotent
 * per (consumerType, consumerId, item), so a retried operation can't double-count. `runId`/`taskId`
 * are task-run context; other consumers pass a per-operation `consumerId`.
 */
export type KnowledgeConsumerType = 'task_run' | 'objective_suggestion';

export async function logKnowledgeApplications(
  tx: DbTx,
  ctx: TenantContext,
  args: {
    consumerType: KnowledgeConsumerType;
    consumerId: string;
    runId?: string | null;
    taskId?: string | null;
    injected: SelectedKnowledge[];
  },
): Promise<void> {
  if (args.injected.length === 0) return;
  await tx
    .insert(knowledgeInjections)
    .values(
      args.injected.map((k) => ({
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        knowledgeItemId: k.id,
        version: k.version,
        consumerType: args.consumerType,
        consumerId: args.consumerId,
        runId: args.runId ?? null,
        taskId: args.taskId ?? null,
        reason: k.reason,
        memoryText: k.memoryText,
      })),
    )
    .onConflictDoNothing({
      target: [knowledgeInjections.consumerType, knowledgeInjections.consumerId, knowledgeInjections.knowledgeItemId],
    });
}

export interface KnowledgeInjectionRow {
  consumerType: string;
  consumerId: string | null;
  runId: string | null;
  taskId: string | null;
  taskTitle: string | null;
  version: number;
  reason: string;
  memoryText: string | null;
  injectedAt: Date;
}

/**
 * The FROZEN knowledge a consumer already received — the exact rendered snapshots recorded at first
 * dispatch. A retry of the same operation repeats these instead of re-selecting, so a failed retry
 * never silently receives a different Knowledge set because records changed between attempts.
 */
export async function listConsumerKnowledgeApplications(
  tx: DbTx,
  ctx: TenantContext,
  consumerType: string,
  consumerId: string,
): Promise<{ memoryText: string | null }[]> {
  return tx
    .select({ memoryText: knowledgeInjections.memoryText })
    .from(knowledgeInjections)
    .where(
      and(
        eq(knowledgeInjections.consumerType, consumerType),
        eq(knowledgeInjections.consumerId, consumerId),
        eq(knowledgeInjections.orgId, ctx.orgId),
        eq(knowledgeInjections.projectId, ctx.projectId),
      ),
    )
    .orderBy(desc(knowledgeInjections.injectedAt));
}

/** The reverse trail for one knowledge item: the AI operations it was supplied to, newest first. */
export async function listInjectionsForKnowledge(tx: DbTx, ctx: TenantContext, itemId: string): Promise<KnowledgeInjectionRow[]> {
  return tx
    .select({
      consumerType: knowledgeInjections.consumerType,
      consumerId: knowledgeInjections.consumerId,
      runId: knowledgeInjections.runId,
      taskId: knowledgeInjections.taskId,
      taskTitle: tasks.title,
      version: knowledgeInjections.version,
      reason: knowledgeInjections.reason,
      memoryText: knowledgeInjections.memoryText,
      injectedAt: knowledgeInjections.injectedAt,
    })
    .from(knowledgeInjections)
    .leftJoin(tasks, eq(knowledgeInjections.taskId, tasks.id))
    .where(and(eq(knowledgeInjections.knowledgeItemId, itemId), eq(knowledgeInjections.orgId, ctx.orgId), eq(knowledgeInjections.projectId, ctx.projectId)))
    .orderBy(desc(knowledgeInjections.injectedAt));
}

export const reviseKnowledgeSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  body: z.string().trim().min(1, 'Body is required').max(20_000),
  activate: z.boolean().default(false),
});

/**
 * A change is a new version. Revising an ACTIVE item creates version n+1
 * (draft or immediately active — activating archives the predecessor).
 */
export async function reviseKnowledge(
  tx: DbTx,
  ctx: TenantContext,
  itemId: string,
  input: z.input<typeof reviseKnowledgeSchema>,
): Promise<string> {
  const parsed = reviseKnowledgeSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message));

  const item = await getItem(tx, ctx, itemId);
  if (item.status !== 'active') {
    throw new ConflictError(`Only active knowledge can be revised; this item is ${item.status}.`);
  }

  const now = new Date();
  const activate = parsed.data.activate;
  const inserted = await tx
    .insert(knowledgeItems)
    .values({
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      scope: 'project',
      kind: item.kind,
      title: parsed.data.title ?? item.title,
      body: parsed.data.body,
      version: item.version + 1,
      supersedes: item.id,
      status: activate ? 'active' : 'draft',
      source: 'manual',
      createdBy: ctx.userId,
      approvedBy: activate ? ctx.userId : null,
      approvedAt: activate ? now : null,
    })
    .returning({ id: knowledgeItems.id });
  const newId = inserted[0]!.id;

  if (activate) {
    await tx
      .update(knowledgeItems)
      .set({ status: 'archived', updatedAt: now })
      .where(and(eq(knowledgeItems.id, item.id), scopeWhere(ctx)));
  }

  await writeAudit(tx, ctx, {
    action: 'knowledge.version_created',
    entityType: 'knowledge_item',
    entityId: newId,
    detail: {
      title: parsed.data.title ?? item.title,
      version: item.version + 1,
      supersedes: item.id,
      activated: activate,
    },
  });
  return newId;
}
