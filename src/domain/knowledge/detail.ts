// Server/worker-only: this loader sits on the extraction import path (it reads knowledge proposals from
// `@/domain/knowledge/extraction`, a `server-only` module that owns the provider-facing extraction calls). The
// explicit guard keeps the whole chain out of any client bundle even if the transitive import later changes.
import 'server-only';
import { type TenantContext } from '@/types/domain';
import { type DbTx } from '@/db/client';
import {
  type KnowledgeInjectionRow,
  type KnowledgeRow,
  type KnowledgeSourceRow,
  listInjectionsForKnowledge,
  listKnowledge,
  listKnowledgeSources,
} from '@/domain/knowledge/knowledge';
import { type KnowledgeProposalRow, listKnowledgeProposals } from '@/domain/knowledge/extraction';
import { buildKnowledgeReference, type KnowledgePortfolioReference } from '@/domain/knowledge/portfolio';

/**
 * The Knowledge Detail ROUTE LOADER — the single data-loading path the Detail page uses. Access is
 * resolved and the sensitive queries are GATED here, at retrieval: for a record the viewer may not see,
 * this returns a bounded `{ visible: false }` result and never runs the item / application / source
 * queries. So direct navigation to a restricted detail URL cannot return sensitive data in the server
 * payload — the denied content is absent, not hidden by the component.
 */

export type KnowledgeDetailView =
  | { visible: false; itemId: string; withholdingReason: string | null }
  | {
      visible: true;
      ref: KnowledgePortfolioReference;
      item: KnowledgeRow | undefined;
      applications: KnowledgeInjectionRow[];
      sources: KnowledgeSourceRow[];
      proposal: KnowledgeProposalRow | null;
    };

export async function loadKnowledgeDetail(tx: DbTx, ctx: TenantContext, itemId: string): Promise<KnowledgeDetailView | null> {
  const ref = await buildKnowledgeReference(tx, ctx, itemId);
  if (!ref) return null;

  // Visibility FIRST. A non-permitted viewer gets only the bounded reason — the sensitive queries below
  // never run, so nothing sensitive reaches the payload.
  if (ref.descriptor.visibility.operator !== 'full' || ref.descriptor.claim === null) {
    return { visible: false, itemId, withholdingReason: ref.descriptor.disclosure.reason };
  }

  const items = await listKnowledge(tx, ctx);
  const item = items.find((i) => i.id === itemId);
  const applications = await listInjectionsForKnowledge(tx, ctx, itemId);
  const proposals = ref.proposalReviewStatus === 'pending' ? await listKnowledgeProposals(tx, ctx, 'pending') : [];
  const proposal = proposals.find((p) => p.knowledgeItemId === itemId) ?? null;
  // Load cited sources for ANY visible record (not just drafts) so the Detail can show exact version
  // hashes behind progressive disclosure. Only visible → already gated above, so no restricted leak.
  const sources = item ? await listKnowledgeSources(tx, ctx, itemId, item.version) : [];
  return { visible: true, ref, item, applications, sources, proposal };
}
