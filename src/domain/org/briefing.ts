import 'server-only';
import { and, desc, eq, sql } from 'drizzle-orm';
import { agents, approvals, auditLogs, messages, objectives, projects, tasks } from '@/db/schema';
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
const MAX_BRIEFING_CHARS = 30_000;
/**
 * Every business must survive the size cap. A tail-only truncation once silently dropped the
 * last four workspaces alphabetically (their directive reports existed; the Chief of Staff
 * reported "no reply") — so the budget is divided per business, never taken from the tail.
 */
const MIN_BUSINESS_SECTION_CHARS = 1_500;
/** Report-back: HQ directives return in FULL (bounded), unlike ordinary work's short excerpt. */
const MAX_DIRECTIVES_PER_BUSINESS = 3;
const MAX_DIRECTIVE_REPORT_CHARS = 4_000;

/**
 * Cross-workspace delegation targets for headquarters' Chief of Staff: every OTHER active
 * workspace in the org that has an installed General Manager (projects.owner_agent_id).
 * Read-only, org-scoped — the same authority the briefing itself uses.
 */
export async function listDelegationTargets(
  userId: string,
  orgId: string,
  excludeProjectId: string,
): Promise<Array<{ key: string; name: string }>> {
  return withOrg({ userId, orgId }, async (tx) => {
    const rows = await tx
      .select({ id: projects.id, key: projects.key, name: projects.name, ownerAgentId: projects.ownerAgentId })
      .from(projects)
      .where(and(eq(projects.orgId, orgId), eq(projects.archived, false)))
      .orderBy(projects.key);
    return rows
      .filter((p) => p.id !== excludeProjectId && p.ownerAgentId != null)
      .map((p) => ({ key: p.key, name: p.name }));
  });
}

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

      // Report-back (owner directive 2026-08-16): tasks this business received FROM headquarters
      // via approved cross-workspace delegation come back in FULL — the Chief of Staff must be
      // able to close the loop without anyone relaying. Provenance is the audited task.delegated
      // event the executor wrote in this workspace (crossWorkspace=true), never a string match.
      const directiveAudits = await tx
        .select({ taskId: auditLogs.entityId })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.orgId, orgId),
            eq(auditLogs.projectId, p.id),
            eq(auditLogs.action, 'task.delegated'),
            sql`${auditLogs.detail}->>'crossWorkspace' = 'true'`,
          ),
        )
        .orderBy(desc(auditLogs.createdAt))
        .limit(MAX_DIRECTIVES_PER_BUSINESS);
      const directiveLines: string[] = [];
      for (const d of directiveAudits) {
        if (!d.taskId) continue;
        const t = (
          await tx
            .select({ id: tasks.id, title: tasks.title, status: tasks.status, updatedAt: tasks.updatedAt })
            .from(tasks)
            .where(and(eq(tasks.id, d.taskId), eq(tasks.projectId, p.id)))
            .limit(1)
        )[0];
        if (!t) continue;
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
          const body = !msg
            ? '(no report recorded)'
            : msg.content.length > MAX_DIRECTIVE_REPORT_CHARS
              ? `${msg.content.slice(0, MAX_DIRECTIVE_REPORT_CHARS)}\n[directive report truncated]`
              : msg.content;
          const state = t.status === 'completed' ? 'COMPLETED' : 'done, awaiting owner approval';
          directiveLines.push(`- "${t.title}" — ${state} ${when}. Full report:\n${body}`);
        } else {
          directiveLines.push(`- "${t.title}" — ${t.status.replace(/_/g, ' ')} (as of ${when})`);
        }
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
      if (directiveLines.length > 0) {
        lines.push(`Headquarters directives (report-back):\n${directiveLines.join('\n')}`);
      }
      sections.push(lines.join('\n'));
    }

    // Fair-share sizing: when the whole briefing would exceed the cap, every business section
    // shrinks to its share — no business is ever dropped from the end.
    const header = `Organization-wide briefing across ${projectRows.length} workspaces (read-only; assembled by the hub):`;
    let body = sections.join('\n\n');
    if (header.length + 2 + body.length > MAX_BRIEFING_CHARS && sections.length > 0) {
      const perBusiness = Math.max(
        MIN_BUSINESS_SECTION_CHARS,
        Math.floor((MAX_BRIEFING_CHARS - header.length - 2 * sections.length) / sections.length),
      );
      body = sections
        .map((s) => (s.length > perBusiness ? `${s.slice(0, perBusiness)}\n[section truncated to fit; full reports live in that workspace]` : s))
        .join('\n\n');
    }
    const briefing = `${header}\n\n${body}`;
    return briefing.length > MAX_BRIEFING_CHARS ? `${briefing.slice(0, MAX_BRIEFING_CHARS)}\n[briefing truncated]` : briefing;
  });
}
