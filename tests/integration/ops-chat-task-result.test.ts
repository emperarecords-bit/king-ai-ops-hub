import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { appSql, rlsAvailable } from '@tests/support/db';
import { type TenantContext } from '@/types/domain';
import { type DbTx, getSetupDb } from '@/db/client';
import { type ProjectAccessRecord } from '@/db/system';
import { agents, approvals, memberships, organizations, profiles, projectMembers, projects, runs, tasks } from '@/db/schema';
import { createOpsChatToolset } from '@/domain/opschat/tools';
import { loadTaskResultRun } from '@/domain/opschat/task-result';

/**
 * P5c-1 — get_task_result against real rows: the owner reads the actual run output with an honest label; another
 * workspace's task/run is never reachable (tool scope + RLS); a run id from elsewhere is "not on this task".
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';

const available = await rlsAvailable('ops-chat-task-result.test');
const db = getSetupDb();
let app: postgres.Sql;
let owner: TenantContext;
let foreign: TenantContext;
let ownerProject: ProjectAccessRecord;
let foreignProject: ProjectAccessRecord;
const ids = { draftTask: '', draftRun: '', approvalTask: '', approvalRun: '', failedTask: '', foreignTask: '', foreignRun: '' };
const RESULT = 'Duct sizing: CFM ≈ 3,160 at ΔT 20°F; main trunk 36×18; branch runs 14×8.';

async function seedOrg(tag: string) {
  const u = randomUUID();
  await db.insert(profiles).values({ id: u, email: `${tag}-${u.slice(0, 8)}@t.local`, displayName: tag });
  const orgId = (await db.insert(organizations).values({ name: tag, slug: `${tag}-${u.slice(0, 8)}` }).returning({ id: organizations.id }))[0]!.id;
  await db.insert(memberships).values({ orgId, userId: u, role: 'owner' });
  const key = fixtureKey(tag);
  const pid = (await db.insert(projects).values({ orgId, key, name: `${tag} workspace` }).returning({ id: projects.id }))[0]!.id;
  await db.insert(projectMembers).values({ orgId, projectId: pid, userId: u, role: 'admin' });
  const agentId = (
    await db
      .insert(agents)
      .values({ orgId, projectId: pid, name: 'Research Analyst', role: 'primary', provider: 'openai', model: 'm', systemPrompt: 'p', temperatureMilli: 700, maxOutputTokens: 1000 })
      .returning({ id: agents.id })
  )[0]!.id;
  const ctx = { userId: u, orgId, projectId: pid, orgRole: 'owner', projectRole: 'admin' } as TenantContext;
  const rec = { orgId, projectId: pid, key, name: `${tag} workspace`, description: '', projectRole: 'admin' } as unknown as ProjectAccessRecord;
  return { ctx, rec, agentId };
}

async function seedTaskRun(ctx: TenantContext, agentId: string, title: string, run: Partial<typeof runs.$inferInsert>) {
  const taskId = (
    await db
      .insert(tasks)
      .values({ orgId: ctx.orgId, projectId: ctx.projectId, title, input: 'x', providerSelection: 'openai', reviewEnabled: false, status: 'completed', createdBy: ctx.userId, assignedPrimaryAgentId: agentId })
      .returning({ id: tasks.id })
  )[0]!.id;
  const runId = (
    await db
      .insert(runs)
      .values({ classification: 'live', orgId: ctx.orgId, projectId: ctx.projectId, taskId, status: 'completed', primaryAgentId: agentId, startedAt: new Date(Date.now() - 60_000), finishedAt: new Date(), ...run })
      .returning({ id: runs.id })
  )[0]!.id;
  return { taskId, runId };
}

beforeAll(async () => {
  if (!available) return;
  app = appSql();
  const o = await seedOrg('tr');
  const f = await seedOrg('trf');
  owner = o.ctx;
  ownerProject = o.rec;
  foreign = f.ctx;
  foreignProject = f.rec;
  const d = await seedTaskRun(owner, o.agentId, 'Duct CFM calc + duct size options', { consolidatedResult: RESULT, reviewOutcome: 'required_unmet' });
  ids.draftTask = d.taskId;
  ids.draftRun = d.runId;
  const a = await seedTaskRun(owner, o.agentId, 'Customer reply about cooling', { consolidatedResult: 'Draft reply to the customer.', reviewOutcome: 'reviewed' });
  ids.approvalTask = a.taskId;
  ids.approvalRun = a.runId;
  await db.insert(approvals).values({
    orgId: owner.orgId,
    projectId: owner.projectId,
    taskId: a.taskId,
    runId: a.runId,
    actionType: 'external_http',
    status: 'pending',
    payload: { kind: 'x' },
    payloadSha256: 'c'.repeat(64),
    summary: 'Send the reply',
    requestedBy: 'openai',
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  ids.failedTask = (await seedTaskRun(owner, o.agentId, 'Failing estimate', { status: 'failed', errorMessage: 'provider timeout', consolidatedResult: null })).taskId;
  const x = await seedTaskRun(foreign, f.agentId, 'Foreign secret plan', { consolidatedResult: 'FOREIGN-SECRET', reviewOutcome: 'reviewed' });
  ids.foreignTask = x.taskId;
  ids.foreignRun = x.runId;
});

afterAll(async () => {
  await app?.end();
});

const tool = (ctx: TenantContext, projectsList: ProjectAccessRecord[]) =>
  createOpsChatToolset({ userId: ctx.userId, projects: projectsList, orgRoles: new Map([[ctx.orgId, 'owner' as const]]) });
const call = async (ctx: TenantContext, projectsList: ProjectAccessRecord[], input: Record<string, unknown>) =>
  JSON.parse(await tool(ctx, projectsList).runTool({ name: 'get_task_result', input }));

describe.skipIf(!available)('get_task_result — real rows', () => {
  it('returns the ACTUAL run output, labelled UNREVIEWED DRAFT, wrapped as untrusted data', async () => {
    const out = await call(owner, [ownerProject], { project: ownerProject.key, task: 'Duct CFM calc' });
    expect(out).toMatchObject({ label: 'UNREVIEWED DRAFT', task: { id: ids.draftTask }, run: { id: ids.draftRun, reviewOutcome: 'required_unmet' }, totalChars: RESULT.length, nextOffset: null });
    expect(out.result).toContain(RESULT);
    expect(out.result).toContain('<untrusted-context>');
    expect(out.guidance).toMatch(/never call it final/);
  });

  it('a run whose proposed approval is still pending is APPROVAL NEEDED (from the real approvals row)', async () => {
    const out = await call(owner, [ownerProject], { project: ownerProject.key, task: ids.approvalTask });
    expect(out).toMatchObject({ label: 'APPROVAL NEEDED', run: { pendingApprovals: 1 } });
    expect(out.result).toContain('Draft reply to the customer.');
  });

  it('a failed run is FAILED with its reason and no result text', async () => {
    const out = await call(owner, [ownerProject], { project: ownerProject.key, task: 'Failing estimate' });
    expect(out).toMatchObject({ label: 'FAILED', result: null, run: { error: 'provider timeout' } });
  });

  it('another workspace is unreachable: not in scope → refused; its task id → no match; its run id → not on this task', async () => {
    expect((await call(owner, [ownerProject], { project: foreignProject.key, task: ids.foreignTask })).error).toMatch(/No workspace matched/);
    expect(await call(owner, [ownerProject], { project: ownerProject.key, task: ids.foreignTask })).toMatchObject({ note: 'No matching task.' });
    const crossRun = await call(owner, [ownerProject], { project: ownerProject.key, task: ids.draftTask, run: ids.foreignRun });
    expect(crossRun.error).toBe('That run is not on this task.');
    expect(JSON.stringify(crossRun)).not.toContain('FOREIGN-SECRET');
  });

  it('RLS (app_server): the result loader under another org`s tenant sees nothing; the owning tenant sees it', async () => {
    const d = drizzle(app);
    const read = (ctx: TenantContext, taskId: string) =>
      d.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.user_id', ${ctx.userId}, true), set_config('app.org_id', ${ctx.orgId}, true), set_config('app.project_id', ${ctx.projectId}, true)`);
        return loadTaskResultRun(tx as unknown as DbTx, taskId, null);
      });
    expect((await read(foreign, ids.draftTask)).run).toBeNull();
    expect((await read(owner, ids.draftTask)).run?.result).toBe(RESULT);
    expect((await read(owner, ids.foreignTask)).run).toBeNull();
  });
});
