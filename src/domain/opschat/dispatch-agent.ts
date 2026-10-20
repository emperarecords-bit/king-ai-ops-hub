/**
 * Which agent (and reviewer) a dispatch card names — and therefore runs.
 *
 * Evidence (server-cooling conversation, Hub prod 2026-10-19): Ops Chat told the owner "I'll use the Research
 * Analyst" (msg 1cb566c0, 11:31), but the card it prepared at 11:41 dispatched **Marketing Lead** — the tool's
 * rule was "otherwise the first available agent is used", and name matching was a loose substring. The owner
 * then re-dispatched the same work to Research Analyst, creating duplicate tasks and competing approvals.
 *
 * Rules: only enabled PRIMARY agents can own a task; with more than one, the agent must be named (no silent
 * default); a name must match exactly (case-insensitive) or uniquely; anything else is refused with the
 * candidates. The card stores the resolved id AND name, so what the owner is told is what runs.
 *
 * Review policy: a dispatched task's review is required by policy (not quick-exempt). If the workspace has an
 * enabled reviewer, the card assigns it; if not, the card says plainly that the result will be an UNREVIEWED
 * DRAFT (not final) — the run is never presented as final when no review can happen.
 */

export interface AgentLike {
  id: string;
  name: string;
  role: string;
  enabled: boolean;
}

export type AgentResolution<A extends AgentLike> =
  | { ok: true; agent: A }
  | { ok: false; error: string; candidates: string[] };

export function resolveDispatchAgent<A extends AgentLike>(all: readonly A[], ref: string | null | undefined): AgentResolution<A> {
  const primaries = all.filter((a) => a.enabled && a.role === 'primary');
  const names = primaries.map((a) => a.name);
  if (primaries.length === 0) return { ok: false, error: 'No enabled primary agent can own a task in this workspace.', candidates: [] };
  const r = (ref ?? '').trim();
  if (!r) {
    if (primaries.length === 1) return { ok: true, agent: primaries[0]! };
    return {
      ok: false,
      error: 'This workspace has several agents — name the one that should own this task (exact name from list_agents). No default is chosen for you.',
      candidates: names,
    };
  }
  const byId = primaries.find((a) => a.id === r);
  if (byId) return { ok: true, agent: byId };
  const lower = r.toLowerCase();
  const exact = primaries.filter((a) => a.name.toLowerCase() === lower);
  if (exact.length === 1) return { ok: true, agent: exact[0]! };
  const partial = primaries.filter((a) => a.name.toLowerCase().includes(lower));
  if (partial.length === 1) return { ok: true, agent: partial[0]! };
  if (partial.length > 1) return { ok: false, error: `"${r}" matches several agents — use the exact name.`, candidates: partial.map((a) => a.name) };
  return { ok: false, error: `No enabled primary agent named "${r}" in this workspace.`, candidates: names };
}

/** The reviewer a dispatch card assigns (first enabled reviewer), or null → the card says UNREVIEWED DRAFT. */
export function pickDispatchReviewer<A extends AgentLike>(all: readonly A[]): A | null {
  return all.find((a) => a.enabled && a.role === 'reviewer') ?? null;
}

export const UNREVIEWED_DRAFT_NOTE =
  'No reviewer in this workspace — review is required by policy, so the result will be an UNREVIEWED DRAFT (intermediate, not final).';
