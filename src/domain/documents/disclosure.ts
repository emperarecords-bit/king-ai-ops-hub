import 'server-only';
import { and, desc, eq, gt, isNull, lte } from 'drizzle-orm';
import { z } from 'zod';
import { type TenantContext } from '@/types/domain';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors';
import { type DbTx } from '@/db/client';
import { agents, documentDisclosureGrants, documents } from '@/db/schema';
import { writeAudit } from '@/domain/audit/audit';
import { agentExecutionFingerprint, loadAgentExecutionIdentities } from '@/domain/agents/agents';
import { KNOWLEDGE_USE_INTENTS, type KnowledgeUseIntent } from '@/domain/knowledge/assess';
import { type DisclosureGrantRecord, type LiveGrant, resolveRestrictedDisclosure } from '@/domain/knowledge/disclosure';

/**
 * Enforceable disclosure grants for restricted DOCUMENTS (Stage C2) — the document analogue of Knowledge
 * grants. A restricted Document's content reaches an AI consumer's prompt ONLY when every consuming agent
 * holds a LIVE grant for the operation's server-derived purpose AND still matches the execution
 * fingerprint the grant was bound to. Without that, restricted content is WITHHELD inside retrieval — it
 * never crosses the retrieval boundary. Reuses the generic grant-resolution primitive from Knowledge so
 * the two subsystems enforce identically.
 */

/** The operation (consumer) type. The permitted purpose is derived from THIS — never caller-supplied. */
export type DocumentConsumerType = 'task_run' | 'objective_suggestion';
const DOCUMENT_PURPOSE_BY_CONSUMER: Record<DocumentConsumerType, KnowledgeUseIntent> = {
  task_run: 'current_operational_fact',
  objective_suggestion: 'objective_planning',
};
export function documentPurposeForConsumer(consumerType: DocumentConsumerType): KnowledgeUseIntent {
  const purpose = DOCUMENT_PURPOSE_BY_CONSUMER[consumerType];
  if (!purpose) throw new ValidationError([`Unknown Document consumer '${consumerType}' — no permitted use is defined for it.`]);
  return purpose;
}

const tenant = (ctx: TenantContext) => and(eq(documentDisclosureGrants.orgId, ctx.orgId), eq(documentDisclosureGrants.projectId, ctx.projectId));

export const createDocumentDisclosureGrantSchema = z.object({
  documentId: z.string().uuid(),
  agentId: z.string().uuid(),
  purpose: z.enum(KNOWLEDGE_USE_INTENTS),
  expiresAt: z.coerce.date(),
  rationale: z.string().trim().max(2000).optional(),
});

/** Grant a specific agent permission to receive a restricted Document for a specific purpose until an
 *  explicit expiry. Only restricted Documents need a grant; subject + agent must be in-tenant. */
export async function createDocumentDisclosureGrant(tx: DbTx, ctx: TenantContext, input: z.input<typeof createDocumentDisclosureGrantSchema>): Promise<string> {
  const data = createDocumentDisclosureGrantSchema.parse(input);
  const doc = (
    await tx.select({ disclosure: documents.disclosure, relativePath: documents.relativePath }).from(documents).where(and(eq(documents.id, data.documentId), eq(documents.orgId, ctx.orgId), eq(documents.projectId, ctx.projectId))).limit(1)
  )[0];
  if (!doc) throw new NotFoundError('Document not found.');
  if (doc.disclosure !== 'restricted') {
    throw new ValidationError(['Only a restricted Document needs a disclosure grant; this Document is already disclosable to workspace consumers.']);
  }
  const agent = (
    await tx
      .select({ id: agents.id, provider: agents.provider, model: agents.model, systemPrompt: agents.systemPrompt, temperatureMilli: agents.temperatureMilli, maxOutputTokens: agents.maxOutputTokens, role: agents.role })
      .from(agents)
      .where(and(eq(agents.id, data.agentId), eq(agents.orgId, ctx.orgId), eq(agents.projectId, ctx.projectId)))
      .limit(1)
  )[0];
  if (!agent) throw new ValidationError(['That agent does not belong to this project.']);
  if (data.expiresAt.getTime() <= Date.now()) throw new ValidationError(['A grant must expire in the future — an expired grant is no grant.']);
  const fingerprint = agentExecutionFingerprint(agent);

  const row = await tx
    .insert(documentDisclosureGrants)
    .values({ orgId: ctx.orgId, projectId: ctx.projectId, documentId: data.documentId, agentId: data.agentId, agentExecutionFingerprint: fingerprint, purpose: data.purpose, rationale: data.rationale ?? null, grantedBy: ctx.userId, expiresAt: data.expiresAt })
    .returning({ id: documentDisclosureGrants.id });

  await writeAudit(tx, ctx, {
    action: 'document.disclosure_granted',
    entityType: 'document',
    entityId: data.documentId,
    detail: { grantId: row[0]!.id, agentId: data.agentId, agentExecutionFingerprint: fingerprint, purpose: data.purpose, expiresAt: data.expiresAt.toISOString(), relativePath: doc.relativePath },
  });
  return row[0]!.id;
}

/** Revoke a grant — immediately not live; row + history preserved. */
export async function revokeDocumentDisclosureGrant(tx: DbTx, ctx: TenantContext, grantId: string, reason?: string): Promise<void> {
  const g = (
    await tx.select({ id: documentDisclosureGrants.id, documentId: documentDisclosureGrants.documentId, revokedAt: documentDisclosureGrants.revokedAt }).from(documentDisclosureGrants).where(and(eq(documentDisclosureGrants.id, grantId), tenant(ctx))).limit(1)
  )[0];
  if (!g) throw new NotFoundError('Disclosure grant not found.');
  if (g.revokedAt) throw new ConflictError('This grant is already revoked.');
  await tx.update(documentDisclosureGrants).set({ revokedAt: new Date(), revokedBy: ctx.userId, revokeReason: reason?.trim() || null }).where(and(eq(documentDisclosureGrants.id, grantId), tenant(ctx)));
  await writeAudit(tx, ctx, { action: 'document.disclosure_revoked', entityType: 'document', entityId: g.documentId, detail: { grantId, reason: reason?.trim() || null } });
}

export interface DocumentDisclosureGrantRow {
  id: string;
  documentId: string;
  agentId: string;
  purpose: string;
  rationale: string | null;
  grantedBy: string | null;
  grantedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokeReason: string | null;
}

export async function listDocumentDisclosureGrants(tx: DbTx, ctx: TenantContext, documentId?: string): Promise<DocumentDisclosureGrantRow[]> {
  const where = documentId ? and(tenant(ctx), eq(documentDisclosureGrants.documentId, documentId)) : tenant(ctx);
  return tx
    .select({ id: documentDisclosureGrants.id, documentId: documentDisclosureGrants.documentId, agentId: documentDisclosureGrants.agentId, purpose: documentDisclosureGrants.purpose, rationale: documentDisclosureGrants.rationale, grantedBy: documentDisclosureGrants.grantedBy, grantedAt: documentDisclosureGrants.grantedAt, expiresAt: documentDisclosureGrants.expiresAt, revokedAt: documentDisclosureGrants.revokedAt, revokeReason: documentDisclosureGrants.revokeReason })
    .from(documentDisclosureGrants)
    .where(where)
    .orderBy(desc(documentDisclosureGrants.grantedAt));
}

/** All LIVE document grants for a purpose, indexed docId → (agentId → LiveGrant). */
export async function loadLiveDocumentGrants(tx: DbTx, ctx: TenantContext, purpose: KnowledgeUseIntent, now: Date): Promise<Map<string, Map<string, LiveGrant>>> {
  const rows = await tx
    .select({ id: documentDisclosureGrants.id, documentId: documentDisclosureGrants.documentId, agentId: documentDisclosureGrants.agentId, agentExecutionFingerprint: documentDisclosureGrants.agentExecutionFingerprint, expiresAt: documentDisclosureGrants.expiresAt })
    .from(documentDisclosureGrants)
    .where(and(tenant(ctx), eq(documentDisclosureGrants.purpose, purpose), isNull(documentDisclosureGrants.revokedAt), lte(documentDisclosureGrants.grantedAt, now), gt(documentDisclosureGrants.expiresAt, now)));
  const index = new Map<string, Map<string, LiveGrant>>();
  for (const r of rows) {
    let perDoc = index.get(r.documentId);
    if (!perDoc) {
      perDoc = new Map<string, LiveGrant>();
      index.set(r.documentId, perDoc);
    }
    perDoc.set(r.agentId, { grantId: r.id, agentExecutionFingerprint: r.agentExecutionFingerprint, expiresAt: r.expiresAt });
  }
  return index;
}

/** Server-derived consumer context — the facts that decide disclosure. NEVER forgeable by the caller:
 *  the runner derives the consumer type from the operation and the agents from the run's own agent rows. */
export interface DocumentConsumerContext {
  consumerType: DocumentConsumerType;
  /** The agents that will consume this run's context (primary + reviewer). Empty ⇒ no restricted. */
  consumerAgentIds: string[];
}

/** The materialized access decision passed into versioned retrieval: which restricted Documents this exact
 *  consumer set is authorized to receive, plus the grant records that authorized each (for snapshotting). */
export interface DocumentAccessDecision {
  purpose: KnowledgeUseIntent;
  authorizedRestrictedIds: ReadonlySet<string>;
  grantsByDocument: Map<string, DisclosureGrantRecord[]>;
}

/** No-authorization decision: every restricted Document is withheld. The safe default when no consumer
 *  context is supplied (e.g. a shadow comparison, or an operation with no consuming agent). */
export function noRestrictedAccess(purpose: KnowledgeUseIntent = 'current_operational_fact'): DocumentAccessDecision {
  return { purpose, authorizedRestrictedIds: new Set(), grantsByDocument: new Map() };
}

/**
 * Resolve which restricted Documents this consumer set may receive. For each restricted Document that has
 * live grants for the derived purpose, permit it ONLY when every consuming agent holds a live grant that
 * still matches its current execution fingerprint (one un-granted / reconfigured / other-purpose /
 * other-fingerprint / expired / revoked consumer withholds the whole Document). An empty consumer set
 * authorizes nothing.
 */
export async function resolveDocumentAccess(tx: DbTx, ctx: TenantContext, consumer: DocumentConsumerContext, now: Date = new Date()): Promise<DocumentAccessDecision> {
  const purpose = documentPurposeForConsumer(consumer.consumerType);
  const grants = await loadLiveDocumentGrants(tx, ctx, purpose, now);
  const identities = await loadAgentExecutionIdentities(tx, ctx, consumer.consumerAgentIds);
  const consumers = consumer.consumerAgentIds.map((id) => identities.get(id)).filter((x): x is NonNullable<typeof x> => !!x);

  const authorizedRestrictedIds = new Set<string>();
  const grantsByDocument = new Map<string, DisclosureGrantRecord[]>();
  for (const documentId of grants.keys()) {
    const decision = resolveRestrictedDisclosure(grants, documentId, consumers);
    if (decision.permitted) {
      authorizedRestrictedIds.add(documentId);
      grantsByDocument.set(documentId, decision.grants);
    }
  }
  return { purpose, authorizedRestrictedIds, grantsByDocument };
}
