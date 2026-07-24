import { and, asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  KNOWLEDGE_KINDS,
  type KnowledgeKind,
  type KnowledgeSource,
  type KnowledgeStatus,
  type TenantContext,
} from '@/types/domain';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors';
import { type DbTx } from '@/db/client';
import { knowledgeItems } from '@/db/schema';
import { writeAudit } from '@/domain/audit/audit';

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
  /** Human authors may activate immediately — the author IS the approver. */
  activate: z.boolean().default(false),
});

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
