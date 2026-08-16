import 'server-only';
import { and, desc, eq, sql } from 'drizzle-orm';
import { agents, approvals, messages, objectives, projects, tasks } from '@/db/schema';
import { withOrg } from '@/db/tenant';

/**
 * The Chief of Staff's organization-wide briefing (owner directive: Empera International is
 * HEADQUARTERS; its General Manager sees across every business).
 *
 * Authority model: this is the ONE sanctioned crossing of workspace walls, and it is read-only.
 * It runs under withOrg with the mid-transaction project-GUC re-stamp — the exact pattern the
 * org-scoped provisioning tools established — and it is invoked ONLY for runs whose primary agent
 * is the GM of the workspace named by ORG_HQ_PROJECT_KEY (checked by the runner). No write ever
 * happens here, and nothing from one subsidiary is written into another.
 */

/** Which workspace is headquarters. Unset ⇒ no workspace has org-wide sight (fail closed). */
export function resolveHqProjectKey(env: Record<string, string | undefined> = process.env): string | null {
  const key = env.ORG_HQ_PROJECT_KEY?.trim();
  return key ? key : null;
}

const MAX_REPORT_SNIPPET = 700;
const MAX_BRIEFING_CHARS = 18_000;

export async function assembleOrgBriefing(userId: string, orgId: string): Promise<string | null> {
  return withOrg({ userId, orgId }, async (tx) => {
    const projectRows = await tx
      .select({ id: projects.id, key: projects.key, name: projects.name, ownerAgentId: projects.ownerAgentId })
      .from(projects)
      .where(and(eq(projects.orgId, orgId), eq(projects.archived, false)))
      .orderBy(projects.key);
    if (projectRows.length === 0) return null;

    const sections: string[] = [];
    for (const p of projectRows) {
      // The sanctioned re-stamp: subsequent reads in this transaction see THIS project.
      await tx.execute(sql`select set_config('app.project_id', ${p.id}, true)`);

      const gm = p.ownerAgentId
        ? (await tx.select({ name: agents.name }).from(agents).where(eq(agents.id, p.ownerAgentId)).limit(1))[0]
        : undefined;

      const objectiveRows = await tx
        .select({
          title: objectives.title,
          total: sql<string>`(select count(*) from ${tasks} where ${tasks.objectiveId} = ${objectives.id} and ${tasks.classification} = 'live')`,
          done: sql<string>`(select count(*) from ${tasks} where ${tasks.objectiveId} = ${objectives.id} and ${tasks.classification} = 'live' and ${tasks.status} = 'completed')`,
        })
        .from(objectives)
        .where(and(eq(objectives.projectId, p.id), eq(objectives.status, 'active')))
        .orderBy(objectives.priority)
        .limit(6);

      const pendingApprovals = await tx
        .select({ n: sql<string>`count(*)` })
        .from(approvals)
        .where(and(eq(approvals.projectId, p.id), eq(approvals.status, 'pending')));

      const latestDone = (
        await tx
          .select({ id: tasks.id, title: tasks.title, updatedAt: tasks.updatedAt })
          .from(tasks)
          .where(and(eq(tasks.projectId, p.id), eq(tasks.status, 'completed'), eq(tasks.classification, 'live')))
          .orderBy(desc(tasks.updatedAt))
          .limit(1)
      )[0];

      let reportSnippet = '';
      if (latestDone) {
        const msg = (
          await tx
            .select({ content: messages.content })
            .from(messages)
            .where(and(eq(messages.taskId, latestDone.id), eq(messages.role, 'assistant')))
            .orderBy(desc(messages.createdAt))
            .limit(1)
        )[0];
        if (msg) reportSnippet = msg.content.slice(0, MAX_REPORT_SNIPPET);
      }

      const lines = [
        `## ${p.name} (${p.key})`,
        `General Manager: ${gm?.name ?? 'unassigned'}`,
        `Pending owner approvals: ${Number(pendingApprovals[0]?.n ?? 0)}`,
        objectiveRows.length > 0
          ? `Active objectives:\n${objectiveRows.map((o) => `- ${o.title} (${o.done} of ${o.total} live tasks done)`).join('\n')}`
          : 'Active objectives: none',
        latestDone
          ? `Latest completed work: "${latestDone.title}" (${latestDone.updatedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC)${reportSnippet ? `\nReport excerpt: ${reportSnippet}` : ''}`
          : 'Latest completed work: none yet',
      ];
      sections.push(lines.join('\n'));
    }

    const briefing = `Organization-wide briefing across ${projectRows.length} workspaces (read-only; assembled by the hub):\n\n${sections.join('\n\n')}`;
    return briefing.length > MAX_BRIEFING_CHARS ? `${briefing.slice(0, MAX_BRIEFING_CHARS)}\n[briefing truncated]` : briefing;
  });
}
