import 'server-only';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import { documents, knowledgeItems, projectContextItems, projects, tasks } from '@/db/schema';
import { type DbTx } from '@/db/client';
import { type TenantContext } from '@/types/domain';

/**
 * Employee Profile (owner directive 2026-08-17: employee editing "should be a little bit more
 * detailed"). One read assembling everything the profile page shows beyond the two edit forms:
 * the employee's recent work and — critically — WHAT THIS EMPLOYEE KNOWS: the workspace
 * information that actually reaches their runs, so access is visible instead of guessed.
 * Read-only, same-workspace only.
 */

const MAX_RECENT_TASKS = 10;
const MAX_LISTED_TITLES = 8;

export interface EmployeeProfile {
  readonly isGeneralManager: boolean;
  readonly recentTasks: ReadonlyArray<{
    id: string;
    title: string;
    status: string;
    updatedAt: Date;
    isChat: boolean;
  }>;
  readonly knowledge: {
    readonly activeCount: number;
    readonly titles: readonly string[];
  };
  readonly documentsCount: number;
  readonly sharedContext: {
    readonly approvedCount: number;
    readonly titles: readonly string[];
  };
}

export async function employeeProfile(tx: DbTx, ctx: TenantContext, agentId: string): Promise<EmployeeProfile> {
  const proj = (
    await tx.select({ ownerAgentId: projects.ownerAgentId }).from(projects).where(eq(projects.id, ctx.projectId)).limit(1)
  )[0];

  const recent = await tx
    .select({
      id: tasks.id,
      title: tasks.title,
      status: sql<string>`${tasks.status}::text`,
      updatedAt: tasks.updatedAt,
      isChat: sql<boolean>`${tasks.conversationId} is not null`,
    })
    .from(tasks)
    .where(and(eq(tasks.projectId, ctx.projectId), eq(tasks.assignedPrimaryAgentId, agentId)))
    .orderBy(desc(tasks.updatedAt))
    .limit(MAX_RECENT_TASKS);

  const kRows = await tx
    .select({ title: knowledgeItems.title })
    .from(knowledgeItems)
    .where(and(eq(knowledgeItems.projectId, ctx.projectId), eq(knowledgeItems.status, 'active')))
    .orderBy(desc(knowledgeItems.createdAt));

  const docCount = (
    await tx.select({ n: count() }).from(documents).where(eq(documents.projectId, ctx.projectId))
  )[0];

  const ctxRows = await tx
    .select({ title: projectContextItems.title })
    .from(projectContextItems)
    .where(and(eq(projectContextItems.projectId, ctx.projectId), eq(projectContextItems.status, 'approved')))
    .orderBy(desc(projectContextItems.createdAt));

  return {
    isGeneralManager: proj?.ownerAgentId === agentId,
    recentTasks: recent,
    knowledge: { activeCount: kRows.length, titles: kRows.slice(0, MAX_LISTED_TITLES).map((r) => r.title) },
    documentsCount: Number(docCount?.n ?? 0),
    sharedContext: { approvedCount: ctxRows.length, titles: ctxRows.slice(0, MAX_LISTED_TITLES).map((r) => r.title) },
  };
}
