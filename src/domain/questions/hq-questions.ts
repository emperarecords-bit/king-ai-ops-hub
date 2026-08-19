import 'server-only';
import { and, desc, eq, like, notInArray, sql as dsql, sql } from 'drizzle-orm';
import { agents, auditLogs, knowledgeItems, projects, runJobs, tasks } from '@/db/schema';
import { type DbTx } from '@/db/client';
import { writeAudit } from '@/domain/audit/audit';
import { createTask } from '@/domain/tasks/tasks';
import { resolveHqProjectKey } from '@/domain/org/briefing';
import { type TenantContext } from '@/types/domain';

/**
 * Ask-HQ (owner directive 2026-08-19: "the walls stay; the building gets internal mail").
 *
 * A business General Manager's `hq-questions` block becomes a REAL task on the Chief of
 * Staff's desk at headquarters; when that task completes, the Chief of Staff's reply is
 * written back into the ASKING workspace's knowledge as "HQ answer: ...". Both crossings use
 * the sanctioned org-crossing pattern (savepoint + project-GUC re-stamp, exactly like
 * org-delegation) — a failure rolls back the savepoint, so nothing partial ever lands.
 *
 * Boundaries: internal and read-only in effect (a question and an answer); no external side
 * effects; the Chief of Staff's answering run is an ordinary budgeted run whose consequential
 * proposals still flow to the owner's Inbox. Caps: MAX per run enforced by the extractor;
 * at most OPEN_CAP unanswered HQ questions per asking workspace.
 */

const OPEN_CAP = 5;
const TITLE_PREFIX = 'HQ question from ';
const TERMINAL_TASK_STATUSES = ['completed', 'cancelled', 'failed'] as const;
const MAX_ANSWER_CHARS = 8_000;

export interface CreateHqQuestionsInput {
  readonly taskId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly questions: readonly string[];
}

/** Called from run finalization for non-HQ General Manager runs. Returns how many were filed. */
export async function createHqQuestions(tx: DbTx, ctx: TenantContext, input: CreateHqQuestionsInput): Promise<number> {
  const hqKey = resolveHqProjectKey();
  if (!hqKey || input.questions.length === 0) return 0;

  const [asking] = await tx
    .select({ key: projects.key, name: projects.name })
    .from(projects)
    .where(eq(projects.id, ctx.projectId))
    .limit(1);
  if (!asking || asking.key === hqKey) return 0;

  const [hq] = await tx
    .select({ id: projects.id, name: projects.name, archived: projects.archived, ownerAgentId: projects.ownerAgentId })
    .from(projects)
    .where(and(eq(projects.orgId, ctx.orgId), eq(projects.key, hqKey)))
    .limit(1);
  if (!hq || hq.archived || !hq.ownerAgentId) return 0;

  let filed = 0;
  for (const question of input.questions) {
    const created = await tx.transaction(async (inner) => {
      // The sanctioned org-crossing re-stamp; savepoint-local, rolled back on any failure.
      await inner.execute(sql`select set_config('app.project_id', ${hq.id}, true)`);
      const hqCtx: TenantContext = { ...ctx, projectId: hq.id, projectRole: 'admin' };

      // Cap open HQ questions per asking workspace (title prefix is hub-minted, so it is a
      // reliable marker; models cannot create tasks).
      const open = await inner
        .select({ n: dsql<number>`count(*)` })
        .from(tasks)
        .where(
          and(
            eq(tasks.projectId, hq.id),
            like(tasks.title, `${TITLE_PREFIX}${asking.key}:%`),
            notInArray(tasks.status, [...TERMINAL_TASK_STATUSES]),
          ),
        );
      if (Number(open[0]?.n ?? 0) >= OPEN_CAP) return false;

      const [cos] = await inner
        .select({ id: agents.id, provider: agents.provider, enabled: agents.enabled, role: agents.role })
        .from(agents)
        .where(and(eq(agents.projectId, hq.id), eq(agents.id, hq.ownerAgentId!)))
        .limit(1);
      if (!cos || !cos.enabled || cos.role !== 'primary') return false;

      const hqTaskId = await createTask(inner, hqCtx, {
        title: `${TITLE_PREFIX}${asking.key}: ${question.slice(0, 120)}`,
        input:
          `Internal question to headquarters from ${input.agentName}, General Manager of ${asking.name} (${asking.key}):\n\n` +
          `${question}\n\n` +
          'Answer it yourself, completely, in your reply text - your organization-wide briefing is your primary source. ' +
          'Your reply is automatically filed into the asking workspace\'s knowledge as "HQ answer: ...", so write it FOR that team. ' +
          'Only delegate or escalate to the owner if the answer genuinely requires it.',
        providerSelection: cos.provider,
        reviewEnabled: false,
        primaryAgentId: cos.id,
      });
      await inner
        .insert(runJobs)
        .values({ orgId: ctx.orgId, projectId: hq.id, taskId: hqTaskId, status: 'queued', dispatchKind: 'standing' })
        .onConflictDoNothing();
      await writeAudit(inner, hqCtx, {
        action: 'hq_question.asked',
        entityType: 'task',
        entityId: hqTaskId,
        detail: {
          askingProjectId: ctx.projectId,
          askingProjectKey: asking.key,
          askingAgentId: input.agentId,
          sourceTaskId: input.taskId,
          sourceRunId: input.runId,
          question: question.slice(0, 500),
        },
      });
      return true;
    });
    if (created) filed += 1;
  }
  return filed;
}

/**
 * Called from run finalization when a HEADQUARTERS task completes: if the task was an Ask-HQ
 * question, the reply is written into the asking workspace's knowledge. Returns true when an
 * answer was delivered.
 */
export async function deliverHqAnswer(
  tx: DbTx,
  ctx: TenantContext,
  input: { taskId: string; answerText: string },
): Promise<boolean> {
  const [asked] = await tx
    .select({ detail: auditLogs.detail })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.orgId, ctx.orgId),
        eq(auditLogs.projectId, ctx.projectId),
        eq(auditLogs.action, 'hq_question.asked'),
        eq(auditLogs.entityId, input.taskId),
      ),
    )
    .orderBy(desc(auditLogs.createdAt))
    .limit(1);
  if (!asked) return false;
  const d = (asked.detail ?? {}) as Record<string, unknown>;
  const askingProjectId = typeof d.askingProjectId === 'string' ? d.askingProjectId : null;
  const question = typeof d.question === 'string' ? d.question : '';
  if (!askingProjectId || askingProjectId === ctx.projectId) return false;

  const [hqTask] = await tx
    .select({ createdBy: tasks.createdBy })
    .from(tasks)
    .where(eq(tasks.id, input.taskId))
    .limit(1);
  if (!hqTask) return false;

  const answer = input.answerText.trim().slice(0, MAX_ANSWER_CHARS) || '(headquarters returned no text)';

  await tx.transaction(async (inner) => {
    await inner.execute(sql`select set_config('app.project_id', ${askingProjectId}, true)`);
    const askingCtx: TenantContext = { ...ctx, projectId: askingProjectId, projectRole: 'admin' };
    await inner.insert(knowledgeItems).values({
      orgId: ctx.orgId,
      projectId: askingProjectId,
      scope: 'project',
      kind: 'fact',
      title: `HQ answer: ${question.slice(0, 160)}`,
      body: `Question (from this workspace's General Manager to headquarters): ${question}\n\nAnswer from the Chief of Staff:\n${answer}`,
      status: 'active',
      source: 'manual',
      createdBy: hqTask.createdBy,
      approvedBy: hqTask.createdBy,
      approvedAt: new Date(),
    });
    await writeAudit(inner, askingCtx, {
      action: 'hq_question.answered',
      entityType: 'task',
      entityId: input.taskId,
      detail: { question: question.slice(0, 300), answerChars: answer.length },
    });
  });
  return true;
}
