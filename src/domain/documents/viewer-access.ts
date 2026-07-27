import 'server-only';
import { and, eq } from 'drizzle-orm';
import { type KnowledgeDisclosure, type TenantContext } from '@/types/domain';
import { type DbTx } from '@/db/client';
import { documents, projectMembers } from '@/db/schema';
import { writeAudit } from '@/domain/audit/audit';
import { type ObjectStore } from './object-store';
import { type ExactVersionRef, type HistoricalInspection, inspectResolvedVersion, resolveExactVersion } from './historical';

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

export type InspectionAccessType = 'preview' | 'raw_bytes' | 'download' | 'chunks' | 'knowledge_provenance' | 'run_source';

/** Record the ACTUAL release of restricted content to a human (call only when content is released, never
 *  for a mere permission check). Records who/where/what/how/why + the policy — never the content itself. */
export async function auditRestrictedInspection(tx: DbTx, ctx: TenantContext, documentId: string, versionId: string | null, accessType: InspectionAccessType, purpose: string): Promise<void> {
  await writeAudit(tx, ctx, {
    action: 'document.restricted_inspected',
    entityType: 'document',
    entityId: documentId,
    detail: { versionId, viewer: ctx.userId, projectId: ctx.projectId, accessType, purpose, policy: 'owner_or_admin_v1' },
  });
}

const DENIAL_MESSAGE = 'This source is not available to your account.';

export type GatedInspectionState = 'released' | 'denied' | 'unavailable' | 'missing' | 'version_mismatch' | 'unsupported' | 'integrity_failure';
export interface GatedInspection {
  state: GatedInspectionState;
  /** A bounded, existence-neutral message on denial — carries no title/path/content/metadata. */
  message?: string;
  /** Present only when content is RELEASED to an authorized viewer. */
  inspection?: HistoricalInspection;
}

/**
 * THE shared gated loader for human Document inspection — every direct path (preview, raw bytes, download,
 * chunk inspection, Knowledge-provenance link, run-source link) must go through this so a direct URL can
 * never bypass authorization or auditing. It: (1) denies a non-member with a bounded message WITHOUT
 * revealing whether the source exists; (2) resolves the exact version; (3) gates on the CURRENT viewer
 * access decision (role-based — never an AI grant); (4) inspects at fidelity; (5) audits ONLY when
 * restricted content is actually released. A permission check alone produces no access audit.
 */
export async function loadInspectableVersion(
  tx: DbTx,
  ctx: TenantContext,
  store: ObjectStore,
  ref: ExactVersionRef,
  opts: { accessType: InspectionAccessType; purpose: string },
): Promise<GatedInspection> {
  // Non-members are denied before anything is resolved — the response never reveals existence.
  if (!(await isProjectMember(tx, ctx))) return { state: 'denied', message: DENIAL_MESSAGE };

  const resolved = await resolveExactVersion(tx, ctx, ref);
  if (resolved.state !== 'found' || !resolved.version) {
    return { state: resolved.state as Exclude<typeof resolved.state, 'found'> };
  }
  const v = resolved.version;
  const access = await assessDocumentViewerAccess(tx, ctx, v.documentId);
  if (!access.canInspect) return { state: 'denied', message: DENIAL_MESSAGE };

  const inspection = await inspectResolvedVersion(tx, store, v, { authorized: true, revealHash: true });
  // Audit ONLY the actual release of restricted content (resolved with content). Never on denial, on a
  // permission check, or on an unavailable/inaccessible result.
  if (access.restricted && inspection.state === 'resolved') {
    await auditRestrictedInspection(tx, ctx, v.documentId, v.id, opts.accessType, opts.purpose);
  }
  return { state: inspection.state === 'resolved' ? 'released' : (inspection.state as GatedInspectionState), inspection };
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
