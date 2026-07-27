import 'server-only';
import { and, eq } from 'drizzle-orm';
import { type KnowledgeDisclosure, type TenantContext } from '@/types/domain';
import { type DbTx } from '@/db/client';
import { documents, projectMembers } from '@/db/schema';
import { writeAudit } from '@/domain/audit/audit';

/**
 * Documents increment 1, Stage D3/D4 — HUMAN viewer authorization for Document inspection, plus
 * classification-across-time. This is distinct from AI-consumer disclosure grants and NEVER reuses them:
 * a grant lets a specific agent receive restricted content in a prompt; it says nothing about which human
 * may open the source.
 *
 * Present access is decided by the CURRENT logical Document disclosure (the present policy) — the version
 * disclosure snapshot and the dispatch disclosure snapshot are HISTORICAL facts, surfaced for context but
 * never used to authorize present inspection. So a source declassified today becomes inspectable today
 * while its historical dispatch classification stays unchanged; a source restricted today is gated today
 * even for a version that was internal at dispatch.
 */

export type ViewerDenyReason = 'ok' | 'not_a_member' | 'restricted_not_permitted';

export interface ViewerAccessDecision {
  canInspect: boolean;
  /** The CURRENT effective policy the decision was made against (stricter wins in future extensions). */
  effectiveDisclosure: KnowledgeDisclosure;
  reason: ViewerDenyReason;
  /** Whether inspecting this Document is a restricted (audited, privileged) inspection. */
  restricted: boolean;
}

/** Is this viewer a member of the workspace? Membership is proven from the DB, not assumed from ctx. */
async function isProjectMember(tx: DbTx, ctx: TenantContext): Promise<boolean> {
  const m = (
    await tx
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, ctx.projectId), eq(projectMembers.orgId, ctx.orgId), eq(projectMembers.userId, ctx.userId)))
      .limit(1)
  )[0];
  return !!m;
}

/**
 * Conservative v1 restricted-inspection policy: a restricted Document may be inspected by a human only if
 * they are a workspace owner or a project admin (the "explicit restricted-document permission" of the
 * first version). Ordinary members cannot. A finer per-Document human grant is a later extension. Every
 * restricted inspection is audited by the caller via `auditRestrictedInspection`.
 */
function mayViewRestricted(ctx: TenantContext): boolean {
  return ctx.orgRole === 'owner' || ctx.projectRole === 'admin';
}

/** Decide whether this human viewer may inspect a Document's content NOW, by its CURRENT disclosure. */
export async function assessDocumentViewerAccess(tx: DbTx, ctx: TenantContext, documentId: string): Promise<ViewerAccessDecision> {
  const doc = (
    await tx.select({ disclosure: documents.disclosure }).from(documents).where(and(eq(documents.id, documentId), eq(documents.orgId, ctx.orgId), eq(documents.projectId, ctx.projectId))).limit(1)
  )[0];
  // A Document that is not in this workspace is indistinguishable from one that does not exist.
  const currentDisclosure: KnowledgeDisclosure = doc?.disclosure ?? 'workspace_internal';
  const restricted = currentDisclosure === 'restricted';

  if (!doc || !(await isProjectMember(tx, ctx))) {
    return { canInspect: false, effectiveDisclosure: currentDisclosure, reason: 'not_a_member', restricted };
  }
  if (restricted && !mayViewRestricted(ctx)) {
    return { canInspect: false, effectiveDisclosure: currentDisclosure, reason: 'restricted_not_permitted', restricted };
  }
  return { canInspect: true, effectiveDisclosure: currentDisclosure, reason: 'ok', restricted };
}

/** Record a privileged restricted-Document inspection (call after a permitted restricted inspection). */
export async function auditRestrictedInspection(tx: DbTx, ctx: TenantContext, documentId: string, versionId: string | null): Promise<void> {
  await writeAudit(tx, ctx, { action: 'document.restricted_inspected', entityType: 'document', entityId: documentId, detail: { versionId, viewer: ctx.userId } });
}

/**
 * Classification-across-time view for inspecting a specific version. Returns the four DISTINCT facts the
 * spec requires kept apart, and the effective present policy (current logical disclosure). History is
 * never rewritten here — the version + dispatch snapshots are reported as-is.
 */
export interface ClassificationAcrossTime {
  currentLogicalDisclosure: KnowledgeDisclosure;
  versionDisclosureSnapshot: KnowledgeDisclosure;
  dispatchDisclosureSnapshot: KnowledgeDisclosure | null;
  /** What governs present inspection (the current logical policy). */
  effectivePresentDisclosure: KnowledgeDisclosure;
}

export function classificationAcrossTime(args: {
  currentLogicalDisclosure: KnowledgeDisclosure;
  versionDisclosureSnapshot: KnowledgeDisclosure;
  dispatchDisclosureSnapshot?: KnowledgeDisclosure | null;
}): ClassificationAcrossTime {
  return {
    currentLogicalDisclosure: args.currentLogicalDisclosure,
    versionDisclosureSnapshot: args.versionDisclosureSnapshot,
    dispatchDisclosureSnapshot: args.dispatchDisclosureSnapshot ?? null,
    // Present inspection is governed by the CURRENT logical policy; the snapshots are historical context.
    effectivePresentDisclosure: args.currentLogicalDisclosure,
  };
}
