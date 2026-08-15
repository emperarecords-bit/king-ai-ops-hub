import { and, asc, eq } from 'drizzle-orm';
import { type TenantContext } from '@/types/domain';
import { type ProjectAccessRecord } from '@/db/system';
import { withTenant } from '@/db/tenant';
import { agents, approvals, tasks } from '@/db/schema';

/**
 * Owner Inbox (EV-011 follow-up) — every pending approval across every
 * workspace the user can act in, as ONE stack. Read-only aggregation: each
 * workspace is queried under its own withTenant scope (RLS enforced per
 * workspace, same as the per-workspace queue), then merged oldest-first so
 * the thing that has waited longest is on top. Deciding still happens through
 * the ordinary per-workspace decideApproval path — this surface adds no new
 * authority.
 */

export interface InboxItem {
  readonly approvalId: string;
  readonly projectKey: string;
  readonly workspaceName: string;
  readonly taskId: string;
  readonly taskTitle: string;
  readonly employeeName: string | null;
  readonly actionType: string;
  readonly summary: string;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
}

export interface OwnerInbox {
  readonly items: readonly InboxItem[];
  readonly workspacesWithPending: number;
  readonly workspacesChecked: number;
}

export async function ownerInbox(
  userId: string,
  projects: readonly ProjectAccessRecord[],
  orgRoleByOrg: ReadonlyMap<string, TenantContext['orgRole']>,
): Promise<OwnerInbox> {
  const items: InboxItem[] = [];
  let workspacesWithPending = 0;
  for (const project of projects) {
    const ctx: TenantContext = {
      userId,
      orgId: project.orgId,
      projectId: project.projectId,
      orgRole: orgRoleByOrg.get(project.orgId) ?? 'member',
      projectRole: project.projectRole,
    };
    const rows = await withTenant(ctx, (tx) =>
      tx
        .select({
          approvalId: approvals.id,
          taskId: approvals.taskId,
          taskTitle: tasks.title,
          employeeName: agents.name,
          actionType: approvals.actionType,
          summary: approvals.summary,
          createdAt: approvals.createdAt,
          expiresAt: approvals.expiresAt,
        })
        .from(approvals)
        .innerJoin(tasks, eq(approvals.taskId, tasks.id))
        .leftJoin(agents, eq(tasks.assignedPrimaryAgentId, agents.id))
        .where(and(eq(approvals.projectId, ctx.projectId), eq(approvals.status, 'pending')))
        .orderBy(asc(approvals.createdAt)),
    );
    if (rows.length > 0) workspacesWithPending += 1;
    for (const r of rows) {
      items.push({
        approvalId: r.approvalId,
        projectKey: project.key,
        workspaceName: project.name,
        taskId: r.taskId,
        taskTitle: r.taskTitle,
        employeeName: r.employeeName,
        actionType: r.actionType,
        summary: r.summary,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
      });
    }
  }
  items.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return { items, workspacesWithPending, workspacesChecked: projects.length };
}
