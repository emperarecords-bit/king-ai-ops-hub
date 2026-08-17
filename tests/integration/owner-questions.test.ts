import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { agents, knowledgeItems, memberships, organizations, ownerQuestions, profiles, projectMembers, projects, tasks } from '@/db/schema';
import { getSetupDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { extractOwnerQuestions } from '@/orchestration/questions-block';
import { answerOwnerQuestion, createOwnerQuestions, dismissOwnerQuestion, openQuestionsForOwner } from '@/domain/questions/questions';
import { type TenantContext } from '@/types/domain';
import { fixtureKey } from '@tests/support/fixture-key';

/** Ask-the-owner: extraction, creation, inbox listing, and the answer→knowledge loop. */

process.env.DATABASE_URL = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';
let available = false;
try { await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1); available = true; }
catch (err) { console.warn(`[owner-questions.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`); }

let ctx: TenantContext;
let projectKey = '';
let agentId = '';
let taskId = '';
let accessRecord: { projectId: string; orgId: string; key: string; name: string; description: string; projectRole: 'admin' };

beforeAll(async () => {
  if (!available) return;
  const db = getSetupDb();
  const userId = randomUUID();
  await db.insert(profiles).values({ id: userId, email: `oq-${randomUUID().slice(0, 8)}@test.local`, displayName: 'Owner' });
  const [org] = await db.insert(organizations).values({ name: 'OQ Org', slug: fixtureKey('oq-org') }).returning({ id: organizations.id });
  projectKey = fixtureKey('oq');
  const [project] = await db.insert(projects).values({ orgId: org!.id, key: projectKey, name: 'OQ Workspace' }).returning({ id: projects.id });
  await db.insert(memberships).values({ orgId: org!.id, userId, role: 'owner' });
  await db.insert(projectMembers).values({ orgId: org!.id, projectId: project!.id, userId, role: 'admin' });
  ctx = { userId, orgId: org!.id, projectId: project!.id, orgRole: 'owner', projectRole: 'admin' };
  accessRecord = { projectId: project!.id, orgId: org!.id, key: projectKey, name: 'OQ Workspace', description: '', projectRole: 'admin' };
  agentId = (
    await db.insert(agents).values({ orgId: org!.id, projectId: project!.id, name: 'Asker', role: 'primary', provider: 'openai', model: 'gpt-x', systemPrompt: 'x', enabled: true }).returning({ id: agents.id })
  )[0]!.id;
  taskId = (
    await db.insert(tasks).values({ orgId: org!.id, projectId: project!.id, title: 'Asking task', input: 'x', providerSelection: 'openai', createdBy: userId, status: 'completed' }).returning({ id: tasks.id })
  )[0]!.id;
});

afterAll(async () => {
  if (!available) return;
  await getSetupDb().update(projects).set({ archived: true }).where(eq(projects.id, ctx.projectId));
});

describe('owner-questions extraction (pure)', () => {
  it('parses the block, enforces caps and strictness, never repairs', () => {
    const good = extractOwnerQuestions('reply\n```owner-questions\n["What ZIP codes do we serve for HVAC jobs?"]\n```');
    expect(good.questions).toEqual(['What ZIP codes do we serve for HVAC jobs?']);
    expect(good.rejected).toEqual([]);
    const bad = extractOwnerQuestions('```owner-questions\n{"not":"an array"}\n```');
    expect(bad.questions).toHaveLength(0);
    expect(bad.rejected).toHaveLength(1);
    const tooShort = extractOwnerQuestions('```owner-questions\n["why?"]\n```');
    expect(tooShort.questions).toHaveLength(0);
    expect(tooShort.rejected).toHaveLength(1);
    expect(extractOwnerQuestions('no block at all').questions).toHaveLength(0);
  });
});

describe.skipIf(!available)('owner questions (live DB)', { timeout: 20_000 }, () => {
  it('creates deduped question rows, lists them for admins only, and answer becomes ACTIVE knowledge', async () => {
    const created = await withTenant(ctx, (tx) =>
      createOwnerQuestions(tx, ctx, {
        taskId,
        runId: null,
        agentId,
        questions: ['What ZIP codes do we serve?', 'What ZIP codes do we serve?', 'What is our hourly labor rate?'],
      }),
    );
    expect(created).toBe(2); // exact duplicate collapsed

    const orgRoles = new Map([[ctx.orgId, 'owner' as const]]);
    const open = await openQuestionsForOwner(ctx.userId, [accessRecord], orgRoles);
    expect(open).toHaveLength(2);
    expect(open[0]!.askedBy).toBe('Asker');

    // A member sees nothing — questions are a decision surface.
    const memberView = await openQuestionsForOwner(ctx.userId, [{ ...accessRecord, projectRole: 'member' as never }], orgRoles);
    expect(memberView).toHaveLength(0);

    // Answer the first: knowledge item appears ACTIVE with Q and A; row is provenance.
    await withTenant(ctx, (tx) => answerOwnerQuestion(tx, ctx, open[0]!.questionId, 'We serve 11203, 11226, and 11210.'));
    const k = await getSetupDb()
      .select({ title: knowledgeItems.title, body: knowledgeItems.body, status: knowledgeItems.status })
      .from(knowledgeItems)
      .where(and(eq(knowledgeItems.projectId, ctx.projectId)));
    const answerItem = k.find((r) => r.title.startsWith('Owner answer:'));
    expect(answerItem).toBeTruthy();
    expect(answerItem!.status).toBe('active');
    expect(answerItem!.body).toContain('11203');
    const row = (await getSetupDb().select({ status: ownerQuestions.status, answer: ownerQuestions.answer }).from(ownerQuestions).where(eq(ownerQuestions.id, open[0]!.questionId)))[0]!;
    expect(row.status).toBe('answered');
    expect(row.answer).toContain('11203');

    // Answering again is refused; dismiss works on the second.
    await expect(withTenant(ctx, (tx) => answerOwnerQuestion(tx, ctx, open[0]!.questionId, 'again'))).rejects.toThrow();
    await withTenant(ctx, (tx) => dismissOwnerQuestion(tx, ctx, open[1]!.questionId));
    const remaining = await openQuestionsForOwner(ctx.userId, [accessRecord], orgRoles);
    expect(remaining).toHaveLength(0);
  });

  it('non-admins can neither answer nor dismiss', async () => {
    const created = await withTenant(ctx, (tx) =>
      createOwnerQuestions(tx, ctx, { taskId, runId: null, agentId, questions: ['What is the marketing budget for this quarter?'] }),
    );
    expect(created).toBe(1);
    const open = await openQuestionsForOwner(ctx.userId, [accessRecord], new Map([[ctx.orgId, 'owner' as const]]));
    const memberCtx = { ...ctx, projectRole: 'member' as const };
    await expect(withTenant(memberCtx, (tx) => answerOwnerQuestion(tx, memberCtx, open[0]!.questionId, 'no'))).rejects.toThrow();
    await expect(withTenant(memberCtx, (tx) => dismissOwnerQuestion(tx, memberCtx, open[0]!.questionId))).rejects.toThrow();
  });
});
