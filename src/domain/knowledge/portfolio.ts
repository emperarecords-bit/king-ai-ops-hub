import { and, eq, gt, inArray, isNull, lte } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { type KnowledgeDisclosure, type TenantContext } from '@/types/domain';
import { type DbTx } from '@/db/client';
import { knowledgeDisclosureGrants, knowledgeInjections, knowledgeItems, knowledgeProposals, knowledgeVerificationEvents, objectives, tasks } from '@/db/schema';
import { assessKnowledge } from '@/domain/knowledge/assess';
import { assessKnowledgeProvenance } from '@/domain/knowledge/knowledge';
import {
  describeKnowledgeForConversation,
  type KnowledgeConversationDescriptor,
} from '@/domain/knowledge/conversation';

/**
 * The Portfolio + Detail AGGREGATOR. Both surfaces render from THIS — the one place that turns records
 * into conversation descriptors — so a record cannot be classified one way in the Portfolio and another
 * in the Detail (or by the selector). It reuses the shared assessment / provenance / disclosure /
 * conversation layers and introduces NO new trust classification.
 *
 * Canonical groups are mutually exclusive by lifecycle + current usability; Needs-Review is a
 * cross-cutting LENS that references canonical records rather than duplicating them.
 */

export type KnowledgePortfolioGroup = 'awaiting_review' | 'available' | 'use_with_qualification' | 'needs_review' | 'historical';

export type NeedsReviewConcern =
  | 'review_due'
  | 'relied_source_unavailable'
  | 'supplemental_partial'
  | 'invalid_or_closed_scope'
  | 'disputed'
  | 'possibly_multiple_claims'
  | 'restricted_no_disclosure_path';

export interface KnowledgePortfolioReference {
  id: string;
  version: number;
  kind: string;
  group: KnowledgePortfolioGroup;
  descriptor: KnowledgeConversationDescriptor;
  /** Cross-cutting evidence-backed concerns (the Needs-Review lens); empty for a clean record. */
  concerns: NeedsReviewConcern[];
  proposalId: string | null;
  proposalReviewStatus: string | null;
  /** For a restricted record: whether a live institutional disclosure grant exists (not derived from
   *  the operator page lacking a consuming agent). Null when the record is not restricted. */
  restrictedGrantState: 'granted' | 'ungranted' | null;
  /** For a Historical record: its specific institutional reason (expired / rejected / split / …). */
  historicalReason: string | null;
  /** For an Awaiting-Review proposal: whether its originating task is closed (affects suggested scope,
   *  not the proposal's own liveness). */
  originatingTaskClosed: boolean;
}

const scopeTask = alias(tasks, 'pf_scope_task');
const scopeObjective = alias(objectives, 'pf_scope_objective');

/**
 * Portfolio disclosure view reports the INSTITUTIONAL grant state, NOT the accident that the operator
 * page has no consuming AI agent. A restricted record with a live grant is properly configured (a
 * particular operation's Detail explains whether ITS execution identities were authorized); a restricted
 * record with no live grant is the real concern.
 */
function portfolioDisclosure(disclosure: string, hasLiveGrant: boolean): { permitted: boolean; reason: string | null } {
  if (disclosure !== 'restricted') return { permitted: true, reason: null };
  return hasLiveGrant
    ? { permitted: true, reason: 'active disclosure grant exists for a bounded agent and purpose' }
    : { permitted: false, reason: 'no currently usable disclosure grant is recorded' };
}

const CLOSED_TASK_STATUSES = new Set(['completed', 'cancelled']);

/**
 * Whether the authenticated VIEWER may inspect restricted Knowledge content. Derived from their
 * workspace role (deny-by-default): only a project admin or an org owner/admin. A member/viewer receives
 * the redacted, bounded descriptor for a restricted record. This runs on the loader's authenticated
 * `ctx`, so access is resolved from the request — never caller-supplied or hardcoded.
 */
export function viewerMaySeeRestricted(ctx: TenantContext): boolean {
  return ctx.projectRole === 'admin' || ctx.orgRole === 'owner' || ctx.orgRole === 'admin';
}

async function assembleReference(
  tx: DbTx,
  ctx: TenantContext,
  row: PortfolioRow,
  successorOf: Set<string>,
  grantedRestricted: Set<string>,
  now: Date,
): Promise<KnowledgePortfolioReference> {
  const restricted = row.disclosure === 'restricted';
  const hasLiveGrant = restricted && grantedRestricted.has(row.id);
  const baseInput = {
    status: row.status,
    epistemicBasis: row.epistemicBasis,
    verification: row.verification,
    asOf: row.asOf,
    verifiedAt: row.verifiedAt,
    reviewAfter: row.reviewAfter,
    expiresAt: row.expiresAt,
    scopeKind: row.scopeKind,
    scopeTaskId: row.scopeTaskId,
    scopeObjectiveId: row.scopeObjectiveId,
    scopeTaskStatus: row.scopeTaskStatus,
    scopeObjectiveStatus: row.scopeObjectiveStatus,
    disclosure: row.disclosure,
    // Institutional disclosure: a restricted record is permitted at the workspace level when a live
    // grant exists — never withheld merely because this operator page has no consuming agent.
    disclosurePermitted: !restricted || hasLiveGrant,
    now,
  } as const;

  const provenance = await assessKnowledgeProvenance(tx, ctx, row.id, row.version);
  const currentAssessment = assessKnowledge({ ...baseInput, provenanceBroken: provenance.brokenForCurrentUse, intendedUse: 'current_operational_fact' });
  const historicalAssessment = assessKnowledge({ ...baseInput, provenanceBroken: provenance.brokenForCurrentUse, intendedUse: 'historical_analysis' });

  const applications = await tx
    .select({ id: knowledgeInjections.id })
    .from(knowledgeInjections)
    .where(and(eq(knowledgeInjections.knowledgeItemId, row.id), eq(knowledgeInjections.orgId, ctx.orgId), eq(knowledgeInjections.projectId, ctx.projectId)));
  const verificationEvents = await tx
    .select({ id: knowledgeVerificationEvents.id })
    .from(knowledgeVerificationEvents)
    .where(and(eq(knowledgeVerificationEvents.knowledgeItemId, row.id), eq(knowledgeVerificationEvents.orgId, ctx.orgId), eq(knowledgeVerificationEvents.projectId, ctx.projectId)));

  const descriptor = describeKnowledgeForConversation({
    item: { title: row.title, body: row.body, epistemicBasis: row.epistemicBasis, verification: row.verification, scopeKind: row.scopeKind, disclosure: row.disclosure, status: row.status },
    currentAssessment,
    historicalAssessment,
    provenance,
    verificationEventCount: verificationEvents.length,
    disclosureDecision: portfolioDisclosure(row.disclosure, hasLiveGrant),
    operatorAccess: viewerMaySeeRestricted(ctx), // resolved from the authenticated viewer's role
    applicationCount: applications.length,
    supersededBy: successorOf.has(row.id) ? { version: row.version + 1 } : null,
    proposal: row.proposalReviewStatus === 'pending' ? { reviewStatus: 'pending', confidence: row.proposalConfidence ?? 'low' } : null,
    asOf: row.asOf,
    claimIsBounded: row.source === 'promoted_context', // extraction guarantees one bounded claim
  });

  const concerns: NeedsReviewConcern[] = [];
  if (descriptor.freshness.state === 'review_due') concerns.push('review_due');
  // Distinguish a broken RELIED-upon source (evidence for the claim is unavailable) from a merely
  // supplemental gap (relied-upon support is intact).
  if (provenance.reliedBroken || descriptor.provenance.state === 'broken' || descriptor.provenance.state === 'unsupported') concerns.push('relied_source_unavailable');
  else if (descriptor.provenance.state === 'partial') concerns.push('supplemental_partial');
  if (!descriptor.scope.valid) concerns.push('invalid_or_closed_scope');
  if (row.verification === 'disputed') concerns.push('disputed');
  if (descriptor.claimGranularity === 'possibly_multiple') concerns.push('possibly_multiple_claims');
  if (restricted && !hasLiveGrant) concerns.push('restricted_no_disclosure_path');

  const group = groupOf(row, descriptor);
  const wasSuperseded = successorOf.has(row.id);
  const originatingTaskClosed = row.scopeKind === 'task' && row.scopeTaskStatus != null && CLOSED_TASK_STATUSES.has(row.scopeTaskStatus);

  return {
    id: row.id,
    version: row.version,
    kind: row.kind,
    group,
    descriptor,
    concerns,
    proposalId: row.proposalId,
    proposalReviewStatus: row.proposalReviewStatus,
    restrictedGrantState: restricted ? (hasLiveGrant ? 'granted' : 'ungranted') : null,
    historicalReason: group === 'historical' ? historicalReasonOf(row, descriptor, wasSuperseded) : null,
    originatingTaskClosed,
  };
}

/** The specific institutional reason a record is Historical — never flattened to just "historical". */
function historicalReasonOf(row: PortfolioRow, d: KnowledgeConversationDescriptor, wasSuperseded: boolean): string {
  if (row.proposalReviewStatus === 'rejected') return 'Rejected';
  if (row.proposalReviewStatus === 'split') return 'Split into replacement proposals';
  if (wasSuperseded) return 'Superseded by a newer version';
  if (d.freshness.state === 'stale') return 'Expired for current use';
  if (d.freshness.state === 'historical') return 'Inactive — originating scope closed';
  if (row.status === 'archived') return 'Archived';
  return 'Historical';
}

function groupOf(row: PortfolioRow, d: KnowledgeConversationDescriptor): KnowledgePortfolioGroup {
  // Archived is terminal and authoritative — an archived record is Historical even if a stale proposal
  // row still reads "pending" (a proposal is normally rejected/split, which archives it, so this only
  // guards against inconsistent lifecycle states).
  if (row.status === 'archived') return 'historical';
  if (row.status === 'draft' || row.proposalReviewStatus === 'pending') return 'awaiting_review';
  // Active: freshness that removes it from current use reads as historical; otherwise usability decides.
  if (d.freshness.state === 'stale' || d.freshness.state === 'historical') return 'historical';
  if (d.currentUseVerdict.state === 'usable') return 'available';
  if (d.currentUseVerdict.state === 'usable_with_qualification') return 'use_with_qualification';
  return 'needs_review'; // active but withheld for a non-freshness reason (disputed / broken / ungranted-restricted)
}

interface PortfolioRow {
  id: string;
  title: string;
  body: string;
  kind: string;
  version: number;
  status: 'draft' | 'active' | 'archived';
  source: string;
  epistemicBasis: PortfolioRaw['epistemicBasis'];
  verification: PortfolioRaw['verification'];
  asOf: Date | null;
  verifiedAt: Date | null;
  reviewAfter: Date | null;
  expiresAt: Date | null;
  scopeKind: PortfolioRaw['scopeKind'];
  scopeTaskId: string | null;
  scopeObjectiveId: string | null;
  scopeTaskStatus: string | null;
  scopeObjectiveStatus: string | null;
  disclosure: KnowledgeDisclosure;
  supersedes: string | null;
  proposalId: string | null;
  proposalReviewStatus: string | null;
  proposalConfidence: string | null;
}

type PortfolioRaw = {
  epistemicBasis: Parameters<typeof assessKnowledge>[0]['epistemicBasis'];
  verification: Parameters<typeof assessKnowledge>[0]['verification'];
  scopeKind: Parameters<typeof assessKnowledge>[0]['scopeKind'];
};

async function loadRows(tx: DbTx, ctx: TenantContext): Promise<PortfolioRow[]> {
  const rows = await tx
    .select({
      id: knowledgeItems.id,
      title: knowledgeItems.title,
      body: knowledgeItems.body,
      kind: knowledgeItems.kind,
      version: knowledgeItems.version,
      status: knowledgeItems.status,
      source: knowledgeItems.source,
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
      supersedes: knowledgeItems.supersedes,
      proposalId: knowledgeProposals.id,
      proposalReviewStatus: knowledgeProposals.reviewStatus,
      proposalConfidence: knowledgeProposals.confidence,
    })
    .from(knowledgeItems)
    .leftJoin(scopeTask, eq(knowledgeItems.scopeTaskId, scopeTask.id))
    .leftJoin(scopeObjective, eq(knowledgeItems.scopeObjectiveId, scopeObjective.id))
    .leftJoin(knowledgeProposals, eq(knowledgeProposals.knowledgeItemId, knowledgeItems.id))
    .where(and(eq(knowledgeItems.projectId, ctx.projectId), eq(knowledgeItems.orgId, ctx.orgId), eq(knowledgeItems.scope, 'project')));
  return rows as PortfolioRow[];
}

/** Restricted item ids that currently have a LIVE institutional disclosure grant (any agent/purpose). */
async function loadGrantedRestrictedIds(tx: DbTx, ctx: TenantContext, restrictedIds: string[], now: Date): Promise<Set<string>> {
  if (restrictedIds.length === 0) return new Set();
  const rows = await tx
    .select({ id: knowledgeDisclosureGrants.knowledgeItemId })
    .from(knowledgeDisclosureGrants)
    .where(
      and(
        eq(knowledgeDisclosureGrants.orgId, ctx.orgId),
        eq(knowledgeDisclosureGrants.projectId, ctx.projectId),
        inArray(knowledgeDisclosureGrants.knowledgeItemId, restrictedIds),
        isNull(knowledgeDisclosureGrants.revokedAt),
        lte(knowledgeDisclosureGrants.grantedAt, now),
        gt(knowledgeDisclosureGrants.expiresAt, now),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

export interface KnowledgePortfolio {
  groups: Record<KnowledgePortfolioGroup, KnowledgePortfolioReference[]>;
  /** The Needs-Review lens: references (from any group) carrying evidence-backed concerns. */
  needsReviewLens: KnowledgePortfolioReference[];
}

/**
 * Build the whole Portfolio: every project Knowledge record turned into a grouped conversation
 * reference from the shared assessment. The Needs-Review lens points at canonical records — it does not
 * duplicate them.
 */
export async function buildKnowledgePortfolio(tx: DbTx, ctx: TenantContext): Promise<KnowledgePortfolio> {
  const rows = await loadRows(tx, ctx);
  const successorOf = new Set<string>();
  for (const r of rows) if (r.supersedes) successorOf.add(r.supersedes);
  const now = new Date();
  const grantedRestricted = await loadGrantedRestrictedIds(tx, ctx, rows.filter((r) => r.disclosure === 'restricted').map((r) => r.id), now);

  const groups: Record<KnowledgePortfolioGroup, KnowledgePortfolioReference[]> = {
    awaiting_review: [],
    available: [],
    use_with_qualification: [],
    needs_review: [],
    historical: [],
  };
  const needsReviewLens: KnowledgePortfolioReference[] = [];

  for (const row of rows) {
    const ref = await assembleReference(tx, ctx, row, successorOf, grantedRestricted, now);
    groups[ref.group].push(ref);
    // The lens flags ACTIVE records with concerns (drafts live in Awaiting; archived in Historical).
    if (row.status === 'active' && ref.concerns.length > 0) needsReviewLens.push(ref);
  }
  return { groups, needsReviewLens };
}

/** One record's full conversational reference for the Detail surface (same descriptor, same trust). */
export async function buildKnowledgeReference(tx: DbTx, ctx: TenantContext, itemId: string): Promise<KnowledgePortfolioReference | null> {
  const rows = await loadRows(tx, ctx);
  const row = rows.find((r) => r.id === itemId);
  if (!row) return null;
  const successorOf = new Set<string>();
  for (const r of rows) if (r.supersedes) successorOf.add(r.supersedes);
  const now = new Date();
  const grantedRestricted = await loadGrantedRestrictedIds(tx, ctx, row.disclosure === 'restricted' ? [row.id] : [], now);
  return assembleReference(tx, ctx, row, successorOf, grantedRestricted, now);
}
