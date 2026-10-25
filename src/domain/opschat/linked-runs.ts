import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { type DbTx } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { approvals, runJobs, runs, tasks } from '@/db/schema';
import { type TenantContext } from '@/types/domain';
import { describeLinkedRun, RESULT_EXCERPT_CHARS, type LinkedRunFacts, type LinkedRunView } from '@/domain/opschat/linked-run-view';
import { allStems, briefDeliverables, notFoundHeadings } from '@/domain/opschat/deliverables';
import { UNREVIEWED_DRAFT_BANNER } from '@/orchestration/engine';

/**
 * P5a loader: each confirmed dispatch / re-run card → the newest job and run that carry its id
 * (P4: run_jobs.ops_chat_proposal_id, runs.ops_chat_proposal_id). Read-only; derived on every load, so there
 * is nothing to backfill, deliver or drift.
 *
 * TENANCY: cards are owner-private (ops_chat_* RLS = user) but jobs/runs are tenant rows (org/project RLS).
 * The card's own `projectKey` is resolved through the caller's auth gate (`requireTenant` in the app) and each
 * project is read in its OWN withTenant transaction — never a cross-tenant query, never a nested transaction.
 * A project the owner can no longer access simply yields no link.
 */

/**
 * The stored result of an unreviewed draft STARTS with the engine's draft banner (it must travel with the answer).
 * In the chat completion reply the label already says UNREVIEWED DRAFT, so the banner only ate the excerpt
 * (Hub prod 2026-10-22: ~300 of the 1,200 characters). Strip it here, server-side, before bounding.
 */
const EXCERPT_READ_CHARS = RESULT_EXCERPT_CHARS + UNREVIEWED_DRAFT_BANNER.length + 3;

export function stripDraftBanner(text: string | null, totalChars: number): { text: string | null; totalChars: number } {
  if (!text || !text.startsWith(UNREVIEWED_DRAFT_BANNER)) return { text, totalChars };
  const rest = text.slice(UNREVIEWED_DRAFT_BANNER.length);
  const trimmed = rest.replace(/^\s+/, '');
  return { text: trimmed, totalChars: Math.max(0, totalChars - UNREVIEWED_DRAFT_BANNER.length - (rest.length - trimmed.length)) };
}

/** Card kinds whose confirmation starts a run. */
export const RUN_STARTING_KINDS: ReadonlySet<string> = new Set(['dispatch_task', 'rerun_task']);

export interface LinkableCard {
  id: string;
  kind: string;
  state: string;
  proposal: unknown;
}

/** Facts for the given card ids, read inside ONE tenant transaction (RLS scopes it to that project). */
export async function loadLinkedRunFacts(tx: DbTx, proposalIds: readonly string[]): Promise<Map<string, LinkedRunFacts>> {
  const out = new Map<string, LinkedRunFacts>();
  const ids = [...new Set(proposalIds)];
  if (ids.length === 0) return out;

  const jobRows = await tx
    .select({ proposalId: runJobs.opsChatProposalId, taskId: runJobs.taskId, status: runJobs.status, createdAt: runJobs.createdAt, updatedAt: runJobs.updatedAt })
    .from(runJobs)
    .where(inArray(runJobs.opsChatProposalId, ids))
    .orderBy(desc(runJobs.createdAt), desc(runJobs.id));
  const runRows = await tx
    .select({
      id: runs.id,
      proposalId: runs.opsChatProposalId,
      taskId: runs.taskId,
      status: runs.status,
      reviewOutcome: runs.reviewOutcome,
      startedAt: runs.startedAt,
      finishedAt: runs.finishedAt,
      errorMessage: runs.errorMessage,
      resultChars: sql<number>`coalesce(length(${runs.consolidatedResult}), 0)::int`,
      // Bounded in SQL — the whole result never leaves the database for this view.
      excerpt: sql<string | null>`left(${runs.consolidatedResult}, ${EXCERPT_READ_CHARS})`,
    })
    .from(runs)
    .where(inArray(runs.opsChatProposalId, ids))
    .orderBy(desc(runs.startedAt), desc(runs.id));

  const jobByCard = new Map<string, (typeof jobRows)[number]>();
  for (const j of jobRows) if (j.proposalId && !jobByCard.has(j.proposalId)) jobByCard.set(j.proposalId, j);
  const runByCard = new Map<string, (typeof runRows)[number]>();
  for (const r of runRows) if (r.proposalId && !runByCard.has(r.proposalId)) runByCard.set(r.proposalId, r);

  const runIds = [...runByCard.values()].map((r) => r.id);
  const pendingByRun = new Map<string, number>();
  if (runIds.length > 0) {
    const ap = await tx
      .select({ runId: approvals.runId, n: sql<number>`count(*)::int` })
      .from(approvals)
      .where(and(inArray(approvals.runId, runIds), eq(approvals.status, 'pending')))
      .groupBy(approvals.runId);
    for (const a of ap) if (a.runId) pendingByRun.set(a.runId, Number(a.n));
  }

  // "Finished" is not "complete": for each finished run with a result, which of its brief's numbered deliverables the
  // result never mentions. The brief is read here; the RESULT stays in the database (one position() test per stem).
  const notFoundByRun = new Map<string, string[]>();
  const finished = [...runByCard.values()].filter((r) => r.status === 'completed' && Number(r.resultChars) > 0);
  if (finished.length > 0) {
    const briefs = await tx
      .select({ id: tasks.id, input: tasks.input })
      .from(tasks)
      .where(inArray(tasks.id, [...new Set(finished.map((r) => r.taskId))]));
    const briefOf = new Map(briefs.map((b) => [b.id, b.input]));
    for (const r of finished) {
      const ds = briefDeliverables(briefOf.get(r.taskId) ?? '');
      if (ds.length === 0) continue;
      const stems = allStems(ds);
      const row = (
        await tx
          .select({ found: sql<boolean[]>`array[${sql.join(stems.map((s) => sql`position(${s} in lower(${runs.consolidatedResult})) > 0`), sql`, `)}]` })
          .from(runs)
          .where(eq(runs.id, r.id))
          .limit(1)
      )[0];
      const found = new Set(stems.filter((_, i) => row?.found?.[i] === true));
      const missing = notFoundHeadings(ds, found);
      if (missing.length > 0) notFoundByRun.set(r.id, missing);
    }
  }

  for (const id of ids) {
    const job = jobByCard.get(id) ?? null;
    const run = runByCard.get(id) ?? null;
    if (!job && !run) continue; // no linked attempt (pre-0087 card, or not in this project)
    out.set(id, {
      proposalId: id,
      taskId: (run?.taskId ?? job?.taskId)!,
      job: job ? { status: job.status, createdAt: job.createdAt, updatedAt: job.updatedAt } : null,
      run: run
        ? {
            id: run.id,
            status: run.status,
            reviewOutcome: run.reviewOutcome,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
            resultChars: Number(run.resultChars),
            errorMessage: run.errorMessage,
            ...(() => {
              const s = stripDraftBanner(run.excerpt, Number(run.resultChars));
              return { excerpt: s.text, excerptTotalChars: s.totalChars };
            })(),
            ...(notFoundByRun.has(run.id) ? { notFound: notFoundByRun.get(run.id)! } : {}),
          }
        : null,
      pendingApprovals: run ? (pendingByRun.get(run.id) ?? 0) : 0,
    });
  }
  return out;
}

function projectKeyOf(proposal: unknown): string | null {
  if (!proposal || typeof proposal !== 'object') return null;
  const k = (proposal as Record<string, unknown>).projectKey;
  return typeof k === 'string' && k.length > 0 ? k : null;
}

/**
 * Views for the confirmed run-starting cards among `cards`. `resolveTenant` is the caller's auth gate for a
 * project key (null ⇒ no access ⇒ no link shown). Call OUTSIDE any open transaction.
 */
export async function loadLinkedRunViews(
  cards: readonly LinkableCard[],
  resolveTenant: (projectKey: string) => Promise<TenantContext | null>,
): Promise<Map<string, LinkedRunView>> {
  const byProject = new Map<string, string[]>();
  for (const c of cards) {
    if (c.state !== 'done' || !RUN_STARTING_KINDS.has(c.kind)) continue;
    const key = projectKeyOf(c.proposal);
    if (!key) continue;
    const list = byProject.get(key) ?? [];
    list.push(c.id);
    byProject.set(key, list);
  }
  const out = new Map<string, LinkedRunView>();
  for (const [key, ids] of byProject) {
    let ctx: TenantContext | null = null;
    try {
      ctx = await resolveTenant(key);
    } catch {
      ctx = null;
    }
    if (!ctx) continue;
    const facts = await withTenant(ctx, (tx) => loadLinkedRunFacts(tx, ids));
    for (const [id, f] of facts) out.set(id, describeLinkedRun(f));
  }
  return out;
}
