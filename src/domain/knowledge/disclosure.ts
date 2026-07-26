import { and, desc, eq, gt, isNull, lte } from 'drizzle-orm';
import { z } from 'zod';
import { type TenantContext } from '@/types/domain';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors';
import { type DbTx } from '@/db/client';
import { agents, knowledgeDisclosureGrants, knowledgeItems } from '@/db/schema';
import { writeAudit } from '@/domain/audit/audit';
import { KNOWLEDGE_USE_INTENTS, type KnowledgeUseIntent } from '@/domain/knowledge/assess';

/**
 * Enforceable disclosure grants — the ONLY path by which `restricted` Knowledge reaches a prompt.
 *
 * The trust model already refuses restricted Knowledge to every consumer by default. A grant turns
 * that blanket refusal into a real, revocable decision, scoped as tightly as the operator chose:
 * per SPECIFIC agent and per SPECIFIC purpose (intended use), inside an explicit validity window.
 *
 *  - A grant is LIVE only when not revoked AND `grantedAt <= now < expiresAt`.
 *  - A restricted item is permitted for a run only when EVERY agent that will consume the run's
 *    context holds a live grant for that item and that purpose (a run with no consuming agent — e.g.
 *    an objective suggestion — can never receive restricted Knowledge: there is no agent to authorize).
 *  - Revocation is a first-class audited decision, never a delete, so the disclosure history survives.
 *  - A supplied restricted disclosure records the authorizing grant id(s) into its application trust
 *    snapshot, so a past disclosure is always explainable.
 */

const tenant = (ctx: TenantContext) => and(eq(knowledgeDisclosureGrants.orgId, ctx.orgId), eq(knowledgeDisclosureGrants.projectId, ctx.projectId));

export const createDisclosureGrantSchema = z.object({
  knowledgeItemId: z.string().uuid(),
  agentId: z.string().uuid(),
  purpose: z.enum(KNOWLEDGE_USE_INTENTS),
  expiresAt: z.coerce.date(),
  rationale: z.string().trim().max(2000).optional(),
});

/**
 * Grant a specific agent permission to receive a restricted item for a specific purpose until an
 * explicit expiry. Only restricted items need a grant; the subject must exist in-tenant, the agent
 * must belong to this project, and the period must end in the future.
 */
export async function createDisclosureGrant(
  tx: DbTx,
  ctx: TenantContext,
  input: z.input<typeof createDisclosureGrantSchema>,
): Promise<string> {
  const data = createDisclosureGrantSchema.parse(input);

  const item = (
    await tx
      .select({ disclosure: knowledgeItems.disclosure, title: knowledgeItems.title })
      .from(knowledgeItems)
      .where(and(eq(knowledgeItems.id, data.knowledgeItemId), eq(knowledgeItems.orgId, ctx.orgId), eq(knowledgeItems.projectId, ctx.projectId)))
      .limit(1)
  )[0];
  if (!item) throw new NotFoundError('Knowledge item not found.');
  if (item.disclosure !== 'restricted') {
    throw new ValidationError(['Only restricted Knowledge needs a disclosure grant; this item is already disclosable to workspace consumers.']);
  }

  const agent = (
    await tx
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, data.agentId), eq(agents.orgId, ctx.orgId), eq(agents.projectId, ctx.projectId)))
      .limit(1)
  )[0];
  if (!agent) throw new ValidationError(['That agent does not belong to this project.']);

  if (data.expiresAt.getTime() <= Date.now()) throw new ValidationError(['A grant must expire in the future — an expired grant is no grant.']);

  const row = await tx
    .insert(knowledgeDisclosureGrants)
    .values({
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      knowledgeItemId: data.knowledgeItemId,
      agentId: data.agentId,
      purpose: data.purpose,
      rationale: data.rationale ?? null,
      grantedBy: ctx.userId,
      expiresAt: data.expiresAt,
    })
    .returning({ id: knowledgeDisclosureGrants.id });

  await writeAudit(tx, ctx, {
    action: 'knowledge.disclosure_granted',
    entityType: 'knowledge_item',
    entityId: data.knowledgeItemId,
    detail: { grantId: row[0]!.id, agentId: data.agentId, purpose: data.purpose, expiresAt: data.expiresAt.toISOString(), title: item.title },
  });
  return row[0]!.id;
}

/** Revoke a grant. A revoked grant is immediately not live; the row and its history are preserved. */
export async function revokeDisclosureGrant(tx: DbTx, ctx: TenantContext, grantId: string, reason?: string): Promise<void> {
  const g = (
    await tx
      .select({ id: knowledgeDisclosureGrants.id, knowledgeItemId: knowledgeDisclosureGrants.knowledgeItemId, revokedAt: knowledgeDisclosureGrants.revokedAt })
      .from(knowledgeDisclosureGrants)
      .where(and(eq(knowledgeDisclosureGrants.id, grantId), tenant(ctx)))
      .limit(1)
  )[0];
  if (!g) throw new NotFoundError('Disclosure grant not found.');
  if (g.revokedAt) throw new ConflictError('This grant is already revoked.');

  await tx
    .update(knowledgeDisclosureGrants)
    .set({ revokedAt: new Date(), revokedBy: ctx.userId, revokeReason: reason?.trim() || null })
    .where(and(eq(knowledgeDisclosureGrants.id, grantId), tenant(ctx)));

  await writeAudit(tx, ctx, {
    action: 'knowledge.disclosure_revoked',
    entityType: 'knowledge_item',
    entityId: g.knowledgeItemId,
    detail: { grantId, reason: reason?.trim() || null },
  });
}

export interface DisclosureGrantRow {
  id: string;
  knowledgeItemId: string;
  agentId: string;
  purpose: string;
  rationale: string | null;
  grantedBy: string | null;
  grantedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokeReason: string | null;
}

/** Inspect grants for a knowledge item (or the whole project), newest first. */
export async function listDisclosureGrants(tx: DbTx, ctx: TenantContext, knowledgeItemId?: string): Promise<DisclosureGrantRow[]> {
  const where = knowledgeItemId
    ? and(tenant(ctx), eq(knowledgeDisclosureGrants.knowledgeItemId, knowledgeItemId))
    : tenant(ctx);
  return tx
    .select({
      id: knowledgeDisclosureGrants.id,
      knowledgeItemId: knowledgeDisclosureGrants.knowledgeItemId,
      agentId: knowledgeDisclosureGrants.agentId,
      purpose: knowledgeDisclosureGrants.purpose,
      rationale: knowledgeDisclosureGrants.rationale,
      grantedBy: knowledgeDisclosureGrants.grantedBy,
      grantedAt: knowledgeDisclosureGrants.grantedAt,
      expiresAt: knowledgeDisclosureGrants.expiresAt,
      revokedAt: knowledgeDisclosureGrants.revokedAt,
      revokeReason: knowledgeDisclosureGrants.revokeReason,
    })
    .from(knowledgeDisclosureGrants)
    .where(where)
    .orderBy(desc(knowledgeDisclosureGrants.grantedAt));
}

/**
 * All LIVE grants for a given purpose, indexed itemId → (agentId → grantId). The selector loads this
 * once per selection and, for each restricted candidate, permits it only when every consuming agent
 * appears in that item's map — recording the authorizing grant ids for the application snapshot.
 */
export async function loadLiveDisclosureGrants(
  tx: DbTx,
  ctx: TenantContext,
  purpose: KnowledgeUseIntent,
  now: Date,
): Promise<Map<string, Map<string, string>>> {
  const rows = await tx
    .select({ id: knowledgeDisclosureGrants.id, knowledgeItemId: knowledgeDisclosureGrants.knowledgeItemId, agentId: knowledgeDisclosureGrants.agentId })
    .from(knowledgeDisclosureGrants)
    .where(
      and(
        tenant(ctx),
        eq(knowledgeDisclosureGrants.purpose, purpose),
        isNull(knowledgeDisclosureGrants.revokedAt),
        lte(knowledgeDisclosureGrants.grantedAt, now),
        gt(knowledgeDisclosureGrants.expiresAt, now),
      ),
    );
  const index = new Map<string, Map<string, string>>();
  for (const r of rows) {
    let perItem = index.get(r.knowledgeItemId);
    if (!perItem) {
      perItem = new Map<string, string>();
      index.set(r.knowledgeItemId, perItem);
    }
    perItem.set(r.agentId, r.id);
  }
  return index;
}

/**
 * Resolve whether a restricted item is disclosable to the run's consuming agents for `purpose`, using
 * a pre-loaded live-grant index. Returns permission + the authorizing grant ids (for the snapshot).
 * Empty consumer set → never permitted (no agent to authorize). Non-restricted items don't call this.
 */
export function resolveRestrictedDisclosure(
  grants: Map<string, Map<string, string>>,
  knowledgeItemId: string,
  consumerAgentIds: string[],
): { permitted: boolean; grantIds: string[] } {
  if (consumerAgentIds.length === 0) return { permitted: false, grantIds: [] };
  const perItem = grants.get(knowledgeItemId);
  if (!perItem) return { permitted: false, grantIds: [] };
  const grantIds: string[] = [];
  for (const agentId of consumerAgentIds) {
    const gid = perItem.get(agentId);
    if (!gid) return { permitted: false, grantIds: [] }; // one un-granted consumer withholds the whole disclosure
    grantIds.push(gid);
  }
  return { permitted: true, grantIds };
}
