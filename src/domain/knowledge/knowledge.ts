import { and, asc, desc, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import {
  KNOWLEDGE_DISCLOSURES,
  KNOWLEDGE_EPISTEMIC_BASES,
  KNOWLEDGE_KINDS,
  KNOWLEDGE_SCOPE_KINDS,
  KNOWLEDGE_SOURCE_TYPES,
  KNOWLEDGE_TRANSFORMATIONS,
  type KnowledgeKind,
  type KnowledgeSource,
  type KnowledgeStatus,
  type TenantContext,
} from '@/types/domain';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors';
import { type DbTx } from '@/db/client';
import { auditLogs, knowledgeInjections, knowledgeItems, knowledgeSources, knowledgeVerificationEvents, objectives, profiles, tasks } from '@/db/schema';
import { writeAudit } from '@/domain/audit/audit';
import { knowledgeRelevance, significantTerms } from '@/domain/knowledge/relevance';
import { assessProvenance, isProvenanceBroken, resolveKnowledgeSource, type ProvenanceState, type ResolutionOutcome } from '@/domain/knowledge/provenance';
import { assessKnowledge, type FreshnessState, type KnowledgeUseIntent, type UseState } from '@/domain/knowledge/assess';
import { type DisclosureGrantRecord, loadLiveDisclosureGrants, resolveRestrictedDisclosure } from '@/domain/knowledge/disclosure';
import { loadAgentExecutionIdentities } from '@/domain/agents/agents';
import {
  type KnowledgeDisclosure,
  type KnowledgeEpistemicBasis,
  type KnowledgeScopeKind,
  type KnowledgeVerification,
} from '@/types/domain';

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
  verification: string;
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
  verification: knowledgeItems.verification,
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

// ---------------------------------------------------------------------------
// Inspectable provenance (version-specific evidence relationships)
// ---------------------------------------------------------------------------

export const attachKnowledgeSourceSchema = z.object({
  sourceType: z.enum(KNOWLEDGE_SOURCE_TYPES),
  sourceRef: z.string().trim().min(1).max(400),
  sourceLabel: z.string().trim().min(1).max(400),
  sourceVersionHash: z.string().trim().max(200).nullable().default(null),
  sourceDate: z.coerce.date().nullable().default(null),
  transformation: z.enum(KNOWLEDGE_TRANSFORMATIONS),
  locator: z.string().trim().max(2_000).nullable().default(null),
});

/**
 * Attach a source to a Knowledge version. Immutable version boundary: only a DRAFT may have sources
 * attached — once active/applied a change requires a new version. Attaching a source NEVER changes
 * verification (attached ≠ inspected ≠ judged-to-support).
 */
export async function attachKnowledgeSource(
  tx: DbTx,
  ctx: TenantContext,
  itemId: string,
  input: z.input<typeof attachKnowledgeSourceSchema>,
): Promise<string> {
  const parsed = attachKnowledgeSourceSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message));
  const item = await getItem(tx, ctx, itemId);
  if (item.status !== 'draft') {
    throw new ConflictError('Sources can only be attached to a draft — a change to an active record requires a new version.');
  }
  const inserted = await tx
    .insert(knowledgeSources)
    .values({
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      knowledgeItemId: itemId,
      knowledgeVersion: item.version,
      sourceType: parsed.data.sourceType,
      sourceRef: parsed.data.sourceRef,
      sourceLabel: parsed.data.sourceLabel,
      sourceVersionHash: parsed.data.sourceVersionHash,
      sourceDate: parsed.data.sourceDate,
      transformation: parsed.data.transformation,
      locator: parsed.data.locator,
      addedBy: ctx.userId,
    })
    .returning({ id: knowledgeSources.id });
  await writeAudit(tx, ctx, { action: 'knowledge.source_attached', entityType: 'knowledge_item', entityId: itemId, detail: { sourceType: parsed.data.sourceType, sourceRef: parsed.data.sourceRef } });
  return inserted[0]!.id;
}

export interface KnowledgeSourceRow {
  id: string;
  sourceType: string;
  sourceRef: string;
  sourceLabel: string;
  sourceVersionHash: string | null;
  sourceDate: Date | null;
  transformation: string;
  locator: string | null;
}

export async function listKnowledgeSources(tx: DbTx, ctx: TenantContext, itemId: string, version: number): Promise<KnowledgeSourceRow[]> {
  return tx
    .select({
      id: knowledgeSources.id,
      sourceType: knowledgeSources.sourceType,
      sourceRef: knowledgeSources.sourceRef,
      sourceLabel: knowledgeSources.sourceLabel,
      sourceVersionHash: knowledgeSources.sourceVersionHash,
      sourceDate: knowledgeSources.sourceDate,
      transformation: knowledgeSources.transformation,
      locator: knowledgeSources.locator,
    })
    .from(knowledgeSources)
    .where(and(eq(knowledgeSources.knowledgeItemId, itemId), eq(knowledgeSources.knowledgeVersion, version), eq(knowledgeSources.orgId, ctx.orgId), eq(knowledgeSources.projectId, ctx.projectId)));
}

/**
 * Record a support judgment — the ONLY path to `source_supported`. Preconditions: it must name the
 * relied-upon source relationships, and every one must resolve to its EXACT cited version now. The
 * judgment snapshots the relied ids + their resolution, so a later resolution failure can't rewrite
 * it. An unrelated attached source that is broken does not block a judgment that didn't rely on it.
 */
export async function recordSupportJudgment(
  tx: DbTx,
  ctx: TenantContext,
  itemId: string,
  input: { reliedOnSourceIds: string[]; rationale?: string; limitations?: string },
): Promise<void> {
  const item = await getItem(tx, ctx, itemId);
  const relied = [...new Set(input.reliedOnSourceIds)];
  if (relied.length === 0) throw new ValidationError(['A support judgment must identify the source relationships it relied upon.']);

  const sources = await listKnowledgeSources(tx, ctx, itemId, item.version);
  const byId = new Map(sources.map((s) => [s.id, s]));
  const resolutionSnapshot: Record<string, ResolutionOutcome> = {};
  for (const id of relied) {
    const s = byId.get(id);
    if (!s) throw new ValidationError(['A relied-upon source is not attached to this Knowledge version.']);
    const outcome = await resolveKnowledgeSource(tx, ctx, { id: s.id, sourceType: s.sourceType, sourceRef: s.sourceRef, sourceVersionHash: s.sourceVersionHash });
    resolutionSnapshot[id] = outcome;
    if (outcome !== 'resolved') {
      throw new ConflictError(`source_supported requires the relied-upon source to resolve to its exact cited version (${s.sourceLabel}: ${outcome}).`);
    }
  }

  await tx.insert(knowledgeVerificationEvents).values({
    orgId: ctx.orgId,
    projectId: ctx.projectId,
    knowledgeItemId: itemId,
    knowledgeVersion: item.version,
    judgment: 'source_supported',
    verifier: ctx.userId,
    reliedOnSourceIds: relied,
    resolutionSnapshot,
    rationale: input.rationale?.trim() || null,
    limitations: input.limitations?.trim() || null,
  });
  await tx
    .update(knowledgeItems)
    .set({ verification: 'source_supported', verifiedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(knowledgeItems.id, itemId), scopeWhere(ctx)));
  await writeAudit(tx, ctx, { action: 'knowledge.verification_set', entityType: 'knowledge_item', entityId: itemId, detail: { title: item.title, verification: 'source_supported', reliedOn: relied.length } });
}

export interface KnowledgeProvenanceAssessment {
  state: ProvenanceState;
  resolutions: { sourceId: string; label: string; outcome: ResolutionOutcome; relied: boolean }[];
  hasSupportJudgment: boolean;
  supportJudgmentId: string | null;
  reliedOnSourceIds: string[];
  /** A relied-upon source (per the support judgment) does not currently resolve to its cited version. */
  reliedBroken: boolean;
  /** The signal the selector uses to withhold from CURRENT-operational use. For a source-supported
   *  record this is relied-upon breakage (a broken *supplemental* source does NOT invalidate it); for
   *  a source-dependent record without a judgment, any claimed source breaking is a defect. */
  brokenForCurrentUse: boolean;
}

/**
 * Current provenance for a Knowledge version — assessed independently of the historical judgment. It
 * resolves each cited source NOW, separates the sources the support judgment RELIED upon from merely
 * supplemental attachments, and reports both the overall state and whether *relied-upon* support is
 * currently inspectable. So a record can be verification `source_supported` yet provenance `partial`
 * while its relied-upon support remains intact (a broken supplemental source alone doesn't withhold).
 */
export async function assessKnowledgeProvenance(tx: DbTx, ctx: TenantContext, itemId: string, version: number): Promise<KnowledgeProvenanceAssessment> {
  const sources = await listKnowledgeSources(tx, ctx, itemId, version);
  // The latest support judgment governs which relationships are relied upon.
  const judgments = await tx
    .select({ id: knowledgeVerificationEvents.id, reliedOnSourceIds: knowledgeVerificationEvents.reliedOnSourceIds })
    .from(knowledgeVerificationEvents)
    .where(
      and(
        eq(knowledgeVerificationEvents.knowledgeItemId, itemId),
        eq(knowledgeVerificationEvents.knowledgeVersion, version),
        eq(knowledgeVerificationEvents.orgId, ctx.orgId),
        eq(knowledgeVerificationEvents.projectId, ctx.projectId),
        eq(knowledgeVerificationEvents.judgment, 'source_supported'),
      ),
    )
    .orderBy(desc(knowledgeVerificationEvents.createdAt))
    .limit(1);
  const judgment = judgments[0] ?? null;
  const reliedSet = new Set(judgment?.reliedOnSourceIds ?? []);

  const resolutions = [];
  for (const s of sources) {
    const outcome = await resolveKnowledgeSource(tx, ctx, { id: s.id, sourceType: s.sourceType, sourceRef: s.sourceRef, sourceVersionHash: s.sourceVersionHash });
    resolutions.push({ sourceId: s.id, label: s.sourceLabel, outcome, relied: reliedSet.has(s.id) });
  }

  const hasSupportJudgment = judgment != null;
  const reliedBroken = hasSupportJudgment && resolutions.some((r) => r.relied && r.outcome !== 'resolved');
  const state = assessProvenance(resolutions.map((r) => r.outcome), hasSupportJudgment);
  const brokenForCurrentUse = hasSupportJudgment ? reliedBroken : isProvenanceBroken(state);

  return {
    state,
    resolutions,
    hasSupportJudgment,
    supportJudgmentId: judgment?.id ?? null,
    reliedOnSourceIds: [...reliedSet],
    reliedBroken,
    brokenForCurrentUse,
  };
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

/** Which AI consumers may apply Knowledge — EVERY consumer leaves the same inspectable record. */
export type KnowledgeConsumerType = 'task_run' | 'objective_suggestion';

/**
 * The permitted Knowledge-use purpose is a pure function of the CONSUMER (operation) type — never a
 * value a caller supplies. This is the whole point: a task run cannot relabel itself "historical
 * analysis" to receive stale or disputed Knowledge under looser rules. The server derives the purpose
 * from what the operation actually is.
 */
export const KNOWLEDGE_PURPOSE_BY_CONSUMER: Record<KnowledgeConsumerType, KnowledgeUseIntent> = {
  task_run: 'current_operational_fact',
  objective_suggestion: 'objective_planning',
};

export function knowledgePurposeForConsumer(consumerType: KnowledgeConsumerType): KnowledgeUseIntent {
  const purpose = KNOWLEDGE_PURPOSE_BY_CONSUMER[consumerType];
  if (!purpose) throw new ValidationError([`Unknown Knowledge consumer '${consumerType}' — no permitted use is defined for it.`]);
  return purpose;
}

/**
 * The immutable trust assessment used AT DISPATCH, frozen onto the application record. It lets a past
 * dispatch be explained without recomputing from today's records (sources may have moved, been re-
 * verified, or gone stale since). Source IDs + per-source resolution outcomes are stored; human-
 * readable source labels/locators are NOT — the snapshot is an internal audit fact, and labels can be
 * sensitive. `renderingVersion` pins the rendering-format contract so old snapshots stay interpretable.
 */
export interface KnowledgeTrustSnapshot {
  epistemicBasis: KnowledgeEpistemicBasis;
  verification: KnowledgeVerification;
  freshness: FreshnessState;
  provenanceState: ProvenanceState;
  useState: UseState;
  scopeKind: KnowledgeScopeKind;
  disclosure: KnowledgeDisclosure;
  disclosureDecision: 'permitted' | 'withheld';
  intendedUse: KnowledgeUseIntent;
  reliedOnSourceIds: string[];
  supplementalSourceIds: string[];
  resolutions: { sourceId: string; outcome: ResolutionOutcome; relied: boolean }[];
  supportJudgmentId: string | null;
  /** For a supplied RESTRICTED item, the authorizing grant(s) — one per consuming agent — each carrying
   *  the agent id, the execution fingerprint that received it, the provider/model actually used, and the
   *  grant validity in force at dispatch. Empty for non-restricted items. Makes a past restricted
   *  disclosure fully explainable: the exact execution identity that was authorized to receive it. */
  disclosureGrants: DisclosureGrantRecord[];
  renderingVersion: string;
}

export interface SelectedKnowledge {
  id: string;
  version: number;
  title: string;
  body: string;
  /** Why it was eligible for this run: 'subject' (shared vocabulary) today. */
  reason: string;
  /** The exact text supplied to the AI — snapshotted into the application record. */
  memoryText: string;
  /** Immutable trust facts as assessed at dispatch — frozen onto the application record. */
  trustSnapshot: KnowledgeTrustSnapshot;
}

/** Current rendering-format contract version, pinned into every application snapshot. */
const KNOWLEDGE_RENDERING_VERSION = 'kv1';

/**
 * The provenance phrase added to a supplied record's qualification bracket, plus the source line (if
 * any) rendered beneath it. SENSITIVE-METADATA GUARD: a source's human-readable label is rendered into
 * the prompt ONLY when it currently RESOLVES to its cited version. Broken / missing / mismatched /
 * inaccessible sources contribute a generic phrase but never leak their label, ref, or hash.
 */
function renderProvenance(prov: KnowledgeProvenanceAssessment): { phrase: string; sourceLine: string | null } {
  const resolvedRelied = prov.resolutions.filter((r) => r.relied && r.outcome === 'resolved');
  switch (prov.state) {
    case 'inspectable_support': {
      // All sources resolve AND a support judgment exists — safe to name the relied-upon evidence.
      const labels = resolvedRelied.map((r) => r.label).filter((l): l is string => !!l);
      return { phrase: 'source-supported', sourceLine: labels.length ? `Supported by: ${labels.join(', ')}` : null };
    }
    case 'partial':
      // Some support inspectable, some not: name only what resolves; never the broken source's label.
      return {
        phrase: prov.reliedBroken ? 'relied-upon source version unavailable' : 'some supplemental sources unavailable',
        sourceLine: resolvedRelied.length
          ? `Supported by: ${resolvedRelied.map((r) => r.label).filter((l): l is string => !!l).join(', ')}`
          : null,
      };
    case 'broken':
      return { phrase: 'cited source version unavailable', sourceLine: null };
    case 'unsupported':
      return { phrase: 'cited source type not resolvable', sourceLine: null };
    case 'attached_not_reviewed':
      return { phrase: 'source attached, support not yet reviewed', sourceLine: null };
    case 'no_source':
    default:
      return { phrase: '', sourceLine: null };
  }
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
    /** WHO is consuming — the purpose is DERIVED from this, never supplied by a caller. */
    consumerType: KnowledgeConsumerType;
    currentTaskId?: string | null;
    currentObjectiveId?: string | null;
    /** The agent(s) that will consume this selection's context. A RESTRICTED item is permitted only
     *  when EVERY one of these agents holds a live grant for it + this purpose AND still matches the
     *  execution fingerprint the grant was bound to. Empty (no identified recipient) → never disclosed. */
    consumerAgentIds?: string[];
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
  // Purpose is DERIVED from the consumer type — a caller cannot relabel the operation to loosen rules.
  const intendedUse: KnowledgeUseIntent = knowledgePurposeForConsumer(args.consumerType);
  const consumerAgentIds = args.consumerAgentIds ?? [];
  const queryTerms = significantTerms(args.queryText);
  // Live disclosure grants for THIS derived purpose, plus the consuming agents' CURRENT execution
  // identities — both loaded once. A restricted item is permitted only via a matching, fingerprint-
  // current grant for every consuming agent. Non-restricted items consult neither.
  const liveGrants = await loadLiveDisclosureGrants(tx, ctx, intendedUse, now);
  const consumerIdentities = await loadAgentExecutionIdentities(tx, ctx, consumerAgentIds);
  const consumers = consumerAgentIds.map((id) => consumerIdentities.get(id)).filter((x): x is NonNullable<typeof x> => !!x);

  const scored: { item: SelectedKnowledge; score: number; createdAt: Date }[] = [];
  for (const r of rows) {
    // Order: lifecycle → version(active) → disclosure → scope validity → freshness/verification.
    // Disclosure: a restricted item is permitted only when every consuming agent holds a live grant for
    // it + this purpose; the authorizing grant ids are frozen into the application snapshot.
    const disclosure =
      r.disclosure === 'restricted'
        ? resolveRestrictedDisclosure(liveGrants, r.id, consumers)
        : { permitted: true, grants: [] as DisclosureGrantRecord[] };
    const baseAssessInput = {
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
      disclosurePermitted: disclosure.permitted,
      intendedUse,
      now,
    };
    // First pass WITHOUT provenance — cheap gates (lifecycle/disclosure/scope/freshness/dispute) run
    // before we pay for source resolution, and before relevance scoring.
    if (assessKnowledge(baseAssessInput).useState === 'withheld') continue;

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

    // Only NOW, for a relevant + otherwise-usable candidate, resolve provenance against today's
    // workspace and re-assess with the current-use breakage signal. A source-dependent record whose
    // relied-upon evidence can't be inspected at its cited version is withheld from current fact.
    const prov = await assessKnowledgeProvenance(tx, ctx, r.id, r.version);
    const a = assessKnowledge({ ...baseAssessInput, provenanceBroken: prov.brokenForCurrentUse });
    if (a.useState === 'withheld') continue;

    const provRender = renderProvenance(prov);
    const bracketParts = [...a.qualifications];
    if (provRender.phrase) bracketParts.push(provRender.phrase);
    // A record carries its qualification bracket only when not cleanly usable OR provenance adds a note,
    // so the model uses it responsibly; source labels appear only for currently-resolved evidence.
    const showBracket = a.useState === 'usable_with_qualification' || !!provRender.phrase;
    const bracket = showBracket ? `[${bracketParts.join(' · ')}]` : '';
    const bodyBlock = provRender.sourceLine ? `${r.title}\n${r.body}\n${provRender.sourceLine}` : `${r.title}\n${r.body}`;
    const memoryText = bracket ? `${bracket}\n${bodyBlock}` : bodyBlock;

    const reliedSet = new Set(prov.reliedOnSourceIds);
    const snapshot: KnowledgeTrustSnapshot = {
      epistemicBasis: r.epistemicBasis,
      verification: r.verification,
      freshness: a.freshness,
      provenanceState: prov.state,
      useState: a.useState,
      scopeKind: r.scopeKind,
      disclosure: r.disclosure,
      disclosureDecision: a.disclosureDecision,
      intendedUse,
      reliedOnSourceIds: prov.reliedOnSourceIds,
      supplementalSourceIds: prov.resolutions.map((x) => x.sourceId).filter((id) => !reliedSet.has(id)),
      resolutions: prov.resolutions.map((x) => ({ sourceId: x.sourceId, outcome: x.outcome, relied: x.relied })),
      supportJudgmentId: prov.supportJudgmentId,
      disclosureGrants: disclosure.grants,
      renderingVersion: KNOWLEDGE_RENDERING_VERSION,
    };

    const ageDays = (nowMs - r.createdAt.getTime()) / 86_400_000;
    scored.push({
      item: { id: r.id, version: r.version, title: r.title, body: r.body, reason, memoryText, trustSnapshot: snapshot },
      score: relScore + Math.max(0, 1 - ageDays / 90),
      createdAt: r.createdAt,
    });
  }
  scored.sort((x, y) => y.score - x.score || y.createdAt.getTime() - x.createdAt.getTime());

  return scored.slice(0, MAX_KNOWLEDGE).map((s) => s.item);
}

/**
 * Record that these knowledge items were supplied to an AI consumer — EVERY consumer (task run,
 * objective suggestion, future operations) leaves the same inspectable, immutable record. Idempotent
 * per (consumerType, consumerId, item), so a retried operation can't double-count. `runId`/`taskId`
 * are task-run context; other consumers pass a per-operation `consumerId`.
 */
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
        trustSnapshot: k.trustSnapshot,
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
  /** The immutable trust snapshot recorded AT DISPATCH — never recomputed from today's record. */
  trustSnapshot: KnowledgeTrustSnapshot | null;
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
): Promise<{ memoryText: string | null; trustSnapshot: KnowledgeTrustSnapshot | null }[]> {
  const rows = await tx
    .select({ memoryText: knowledgeInjections.memoryText, trustSnapshot: knowledgeInjections.trustSnapshot })
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
  // The jsonb column is untyped at the DB boundary; the shape is guaranteed by logKnowledgeApplications.
  return rows.map((r) => ({ memoryText: r.memoryText, trustSnapshot: (r.trustSnapshot as KnowledgeTrustSnapshot | null) ?? null }));
}

/** The reverse trail for one knowledge item: the AI operations it was supplied to, newest first. Each
 *  row carries the FROZEN trust snapshot recorded at dispatch — the Detail shows dispatch-time truth
 *  alongside current truth, never reconstructing the past from today's record. */
export async function listInjectionsForKnowledge(tx: DbTx, ctx: TenantContext, itemId: string): Promise<KnowledgeInjectionRow[]> {
  const rows = await tx
    .select({
      consumerType: knowledgeInjections.consumerType,
      consumerId: knowledgeInjections.consumerId,
      runId: knowledgeInjections.runId,
      taskId: knowledgeInjections.taskId,
      taskTitle: tasks.title,
      version: knowledgeInjections.version,
      reason: knowledgeInjections.reason,
      memoryText: knowledgeInjections.memoryText,
      trustSnapshot: knowledgeInjections.trustSnapshot,
      injectedAt: knowledgeInjections.injectedAt,
    })
    .from(knowledgeInjections)
    .leftJoin(tasks, eq(knowledgeInjections.taskId, tasks.id))
    .where(and(eq(knowledgeInjections.knowledgeItemId, itemId), eq(knowledgeInjections.orgId, ctx.orgId), eq(knowledgeInjections.projectId, ctx.projectId)))
    .orderBy(desc(knowledgeInjections.injectedAt));
  return rows.map((r) => ({ ...r, trustSnapshot: (r.trustSnapshot as KnowledgeTrustSnapshot | null) ?? null }));
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
