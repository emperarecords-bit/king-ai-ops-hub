import 'server-only';
import { and, asc, eq } from 'drizzle-orm';
import { agents, ownerQuestions } from '@/db/schema';
import { type DbTx } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { writeAudit } from '@/domain/audit/audit';
import { createKnowledge } from '@/domain/knowledge/knowledge';
import { AppError, NotFoundError, ValidationError } from '@/lib/errors';
import { type TenantContext } from '@/types/domain';
import { type ProjectAccessRecord } from '@/db/system';

/**
 * Ask-the-owner (owner directive 2026-08-17): the question half of the Inbox. Employees raise
 * questions from runs; the owner answers from the Inbox; the answer becomes ACTIVE workspace
 * knowledge (the durable record every future run carries) plus provenance on the question row.
 */

const MAX_OPEN_QUESTIONS_PER_WORKSPACE = 25;

/** Called from run finalization: record the run's questions (bounded; failures never fail the run upstream). */
export async function createOwnerQuestions(
  tx: DbTx,
  ctx: TenantContext,
  input: { taskId: string; runId: string | null; agentId: string; questions: readonly string[] },
): Promise<number> {
  if (input.questions.length === 0) return 0;
  const openCount = await tx
    .select({ id: ownerQuestions.id })
    .from(ownerQuestions)
    .where(and(eq(ownerQuestions.projectId, ctx.projectId), eq(ownerQuestions.status, 'open')));
  let budget = Math.max(0, MAX_OPEN_QUESTIONS_PER_WORKSPACE - openCount.length);
  let created = 0;
  for (const q of input.questions) {
    if (budget === 0) break;
    // Dedup: an identical open question in this workspace is not asked twice.
    const dup = await tx
      .select({ id: ownerQuestions.id })
      .from(ownerQuestions)
      .where(and(eq(ownerQuestions.projectId, ctx.projectId), eq(ownerQuestions.status, 'open'), eq(ownerQuestions.question, q)))
      .limit(1);
    if (dup.length > 0) continue;
    const row = (
      await tx
        .insert(ownerQuestions)
        .values({ orgId: ctx.orgId, projectId: ctx.projectId, taskId: input.taskId, runId: input.runId, agentId: input.agentId, question: q })
        .returning({ id: ownerQuestions.id })
    )[0]!;
    await writeAudit(tx, ctx, {
      action: 'owner_question.asked',
      entityType: 'owner_question',
      entityId: row.id,
      detail: { byAgentId: input.agentId, taskId: input.taskId },
    });
    budget -= 1;
    created += 1;
  }
  return created;
}

export interface OpenOwnerQuestion {
  readonly questionId: string;
  readonly projectKey: string;
  readonly workspaceName: string;
  readonly askedBy: string | null;
  readonly question: string;
  readonly createdAt: Date;
}

/** Open questions across the workspaces the caller ADMINISTERS (the Inbox rule: never show what you cannot act on). */
export async function openQuestionsForOwner(
  userId: string,
  projects_: readonly ProjectAccessRecord[],
  orgRoleByOrg: ReadonlyMap<string, TenantContext['orgRole']>,
): Promise<readonly OpenOwnerQuestion[]> {
  const items: OpenOwnerQuestion[] = [];
  for (const project of projects_.filter((p) => p.projectRole === 'admin')) {
    const ctx: TenantContext = {
      userId,
      orgId: project.orgId,
      projectId: project.projectId,
      orgRole: orgRoleByOrg.get(project.orgId) ?? 'member',
      projectRole: project.projectRole,
    };
    const rows = await withTenant(ctx, (tx) =>
      tx
        .select({ id: ownerQuestions.id, question: ownerQuestions.question, createdAt: ownerQuestions.createdAt, askedBy: agents.name })
        .from(ownerQuestions)
        .leftJoin(agents, eq(ownerQuestions.agentId, agents.id))
        .where(and(eq(ownerQuestions.projectId, ctx.projectId), eq(ownerQuestions.status, 'open')))
        .orderBy(asc(ownerQuestions.createdAt)),
    );
    for (const r of rows) {
      items.push({ questionId: r.id, projectKey: project.key, workspaceName: project.name, askedBy: r.askedBy, question: r.question, createdAt: r.createdAt });
    }
  }
  items.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return items;
}

/** The owner answers: the answer becomes ACTIVE workspace knowledge + provenance on the row. Admin-only. */
export async function answerOwnerQuestion(
  tx: DbTx,
  ctx: TenantContext,
  questionId: string,
  answer: string,
): Promise<void> {
  if (ctx.projectRole !== 'admin') throw new AppError('forbidden', 'Only workspace admins can answer owner questions.');
  const a = answer.trim();
  if (a.length === 0) throw new ValidationError(['An answer is required.']);
  if (a.length > 8_000) throw new ValidationError(['Answer is too long (max 8000 characters).']);
  const row = (
    await tx
      .select({ id: ownerQuestions.id, question: ownerQuestions.question, status: ownerQuestions.status })
      .from(ownerQuestions)
      .where(and(eq(ownerQuestions.id, questionId), eq(ownerQuestions.projectId, ctx.projectId)))
      .limit(1)
  )[0];
  if (!row) throw new NotFoundError('Question');
  if (row.status !== 'open') throw new AppError('conflict', 'This question was already resolved.');

  const knowledgeId = await createKnowledge(tx, ctx, {
    title: `Owner answer: ${row.question.slice(0, 160)}`,
    body: `Question (from the team): ${row.question}\n\nOwner's answer: ${a}`,
    kind: 'fact',
    activate: true,
  });
  await tx
    .update(ownerQuestions)
    .set({ status: 'answered', answer: a, answeredBy: ctx.userId, answeredAt: new Date(), updatedAt: new Date() })
    .where(eq(ownerQuestions.id, questionId));
  await writeAudit(tx, ctx, {
    action: 'owner_question.answered',
    entityType: 'owner_question',
    entityId: questionId,
    detail: { knowledgeId },
  });
}

/** Dismiss without answering (not relevant / already known). Admin-only. */
export async function dismissOwnerQuestion(tx: DbTx, ctx: TenantContext, questionId: string): Promise<void> {
  if (ctx.projectRole !== 'admin') throw new AppError('forbidden', 'Only workspace admins can dismiss owner questions.');
  const updated = await tx
    .update(ownerQuestions)
    .set({ status: 'dismissed', answeredBy: ctx.userId, answeredAt: new Date(), updatedAt: new Date() })
    .where(and(eq(ownerQuestions.id, questionId), eq(ownerQuestions.projectId, ctx.projectId), eq(ownerQuestions.status, 'open')))
    .returning({ id: ownerQuestions.id });
  if (updated.length === 0) throw new NotFoundError('Question');
  await writeAudit(tx, ctx, { action: 'owner_question.dismissed', entityType: 'owner_question', entityId: questionId, detail: {} });
}
