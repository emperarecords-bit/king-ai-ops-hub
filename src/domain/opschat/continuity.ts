import { withTenant } from '@/db/tenant';
import { type TenantContext } from '@/types/domain';
import { cardLabelOf } from '@/domain/opschat/card-state';
import { activeJob, type ContinuityCard } from '@/domain/opschat/conversation-continuity';
import { loadLinkedRunViews, type LinkableCard } from '@/domain/opschat/linked-runs';
import { type LinkedRunView } from '@/domain/opschat/linked-run-view';
import { loadTaskStates } from '@/domain/opschat/task-state';

/**
 * P5c-3 server loader: a conversation's confirmed run-starting cards → ContinuityCards (label, workspace, linked run
 * view), with P5c-2 stale / superseded facts for the ACTIVE job. Read-only; tenant reads go through the caller's
 * membership gate (`resolveTenant`), one withTenant transaction per workspace, never nested inside another
 * transaction. Call outside any open transaction.
 */

function projectKeyOf(proposal: unknown): string | null {
  const k = proposal && typeof proposal === 'object' ? (proposal as Record<string, unknown>).projectKey : null;
  return typeof k === 'string' && k ? k : null;
}

export async function loadContinuityCards(
  cards: readonly LinkableCard[],
  resolveTenant: (projectKey: string) => Promise<TenantContext | null>,
  views?: ReadonlyMap<string, LinkedRunView>,
): Promise<ContinuityCard[]> {
  const v = views ?? (await loadLinkedRunViews(cards, resolveTenant));
  const out: ContinuityCard[] = cards.map((c) => ({
    proposalId: c.id,
    kind: c.kind,
    label: cardLabelOf(c.kind, c.proposal && typeof c.proposal === 'object' ? (c.proposal as Record<string, unknown>) : {}),
    projectKey: projectKeyOf(c.proposal),
    view: v.get(c.id) ?? null,
  }));
  // Stale / superseded state matters for the job a follow-up resolves to — read it for the active job only.
  const { active } = activeJob(out);
  if (active?.view && active.projectKey) {
    try {
      const ctx = await resolveTenant(active.projectKey);
      if (ctx) {
        const [st] = await withTenant(ctx, (tx) => loadTaskStates(tx, ctx, [active.view!.taskId]));
        if (st) {
          active.stale = st.stale ? { decisions: st.stale.decisions.length } : null;
          active.supersededBy = st.supersededBy ? { taskId: st.supersededBy.taskId, title: st.supersededBy.title } : null;
        }
      }
    } catch {
      // best-effort: the section still names the active job without the stale note
    }
  }
  return out;
}
