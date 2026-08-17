import 'server-only';
import { and, desc, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import { agents, messages, tasks } from '@/db/schema';
import { type DbTx } from '@/db/client';
import { type TenantContext } from '@/types/domain';

/**
 * Team Briefing (owner directive 2026-08-16: "make sure employees can communicate with each
 * other"). The workspace-level sibling of the org briefing: every General Manager's run carries
 * live, read-only sight of their OWN team's recent work — completed tasks with report excerpts,
 * work in flight, and work awaiting the owner. The GM is the team's information router; without
 * this they delegated blind and re-assigned work that was already done.
 *
 * Same-workspace reads only — no tenancy crossing, no writes. Chat threads (conversationId set)
 * are excluded: they are owner conversations, not team output.
 */

const MAX_TEAM_TASKS = 12;
const MAX_TEAM_REPORT_EXCERPT = 500;
const RECENT_DAYS = 7;

export async function assembleTeamBriefing(
  tx: DbTx,
  ctx: TenantContext,
  opts: { excludeTaskId?: string } = {},
): Promise<string | null> {
  const since = new Date(Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000);
  const rows = await tx
    .select({
      id: tasks.id,
      title: tasks.title,
      status: sql<string>`${tasks.status}::text`,
      updatedAt: tasks.updatedAt,
      assignee: agents.name,
    })
    .from(tasks)
    .leftJoin(agents, eq(tasks.assignedPrimaryAgentId, agents.id))
    .where(
      and(
        eq(tasks.projectId, ctx.projectId),
        isNull(tasks.conversationId),
        gt(tasks.updatedAt, since),
        ...(opts.excludeTaskId ? [ne(tasks.id, opts.excludeTaskId)] : []),
      ),
    )
    .orderBy(desc(tasks.updatedAt))
    .limit(MAX_TEAM_TASKS);
  if (rows.length === 0) return null;

  const lines: string[] = [];
  for (const t of rows) {
    const who = t.assignee ?? 'unassigned';
    const when = `${t.updatedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    if (t.status === 'completed' || t.status === 'awaiting_approval') {
      const msg = (
        await tx
          .select({ content: messages.content })
          .from(messages)
          .where(and(eq(messages.taskId, t.id), eq(messages.role, 'assistant')))
          .orderBy(desc(messages.createdAt))
          .limit(1)
      )[0];
      const excerpt = msg ? msg.content.slice(0, MAX_TEAM_REPORT_EXCERPT) : '(no report recorded)';
      const state = t.status === 'completed' ? 'COMPLETED' : 'done, awaiting owner approval';
      lines.push(`- "${t.title}" (${who}) — ${state} ${when}\n  Report excerpt: ${excerpt}`);
    } else {
      lines.push(`- "${t.title}" (${who}) — ${t.status.replace(/_/g, ' ')} (as of ${when})`);
    }
  }
  return (
    `Team briefing — this workspace's recent work (live, read-only; last ${RECENT_DAYS} days). ` +
    `CHECK THIS BEFORE DELEGATING: never re-assign work that is already completed or in flight; build on it instead.\n` +
    lines.join('\n')
  );
}
