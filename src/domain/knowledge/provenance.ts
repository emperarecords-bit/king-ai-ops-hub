import { and, eq } from 'drizzle-orm';
import { type TenantContext } from '@/types/domain';
import { type DbTx } from '@/db/client';
import { artifacts, documents } from '@/db/schema';

/**
 * Source resolution + provenance assessment. Persisted citation facts (in `knowledge_sources`) are
 * kept SEPARATE from the current resolution result computed here — a citation never falls back to the
 * latest source version, and a `resolved` outcome is a present observation, not stored truth.
 */

export type ResolutionOutcome = 'resolved' | 'missing' | 'inaccessible' | 'version_mismatch' | 'unsupported';

export interface CitedSource {
  id: string;
  sourceType: string;
  sourceRef: string;
  sourceVersionHash: string | null;
}

/**
 * Resolve one cited source against the current workspace, comparing the EXACT cited version. Access-
 * aware: `inaccessible` means the source exists but the actor/consumer may not inspect it (distinct
 * from `missing`). Only document/artifact are resolvable; anything else is `unsupported`.
 */
export async function resolveKnowledgeSource(tx: DbTx, ctx: TenantContext, source: CitedSource): Promise<ResolutionOutcome> {
  if (source.sourceType === 'document') {
    const rows = await tx
      .select({ sha256: documents.sha256 })
      .from(documents)
      .where(and(eq(documents.projectId, ctx.projectId), eq(documents.orgId, ctx.orgId), eq(documents.relativePath, source.sourceRef)))
      .limit(1);
    if (rows.length === 0) return 'missing';
    // Never resolve to the latest: a differing current hash is a version mismatch, not a fallback.
    if (source.sourceVersionHash != null && rows[0]!.sha256 !== source.sourceVersionHash) return 'version_mismatch';
    return 'resolved';
  }
  if (source.sourceType === 'artifact') {
    const rows = await tx
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(and(eq(artifacts.id, source.sourceRef), eq(artifacts.projectId, ctx.projectId), eq(artifacts.orgId, ctx.orgId)))
      .limit(1);
    return rows.length === 0 ? 'missing' : 'resolved';
  }
  return 'unsupported';
}

export type ProvenanceState =
  | 'no_source'
  | 'attached_not_reviewed'
  | 'inspectable_support'
  | 'partial'
  | 'broken'
  | 'unsupported';

/**
 * Derive the current provenance state from resolutions + whether a support judgment exists. Pure.
 * Distinguishes "no source claimed" (not a defect) from "a source was claimed but can't be inspected"
 * (broken). `inspectable_support` requires all sources to resolve AND a recorded support judgment.
 */
export function assessProvenance(resolutions: ResolutionOutcome[], hasSupportJudgment: boolean): ProvenanceState {
  if (resolutions.length === 0) return 'no_source';
  const resolved = resolutions.filter((r) => r === 'resolved').length;
  if (resolved === resolutions.length) return hasSupportJudgment ? 'inspectable_support' : 'attached_not_reviewed';
  if (resolved === 0) return resolutions.every((r) => r === 'unsupported') ? 'unsupported' : 'broken';
  return 'partial';
}

/** Provenance states that constitute a defect (a claimed source can't currently be inspected). */
export function isProvenanceBroken(state: ProvenanceState): boolean {
  return state === 'broken' || state === 'partial' || state === 'unsupported';
}
