import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { asc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { FakeProvider } from '@tests/support/fake-provider';
import { adminSql, appSql, asTenant, asUser, rlsAvailable } from '@tests/support/db';
import { type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { withTenant, withUser } from '@/db/tenant';
import { agents, memberships, organizations, profiles, projectMembers, projects, runJobs, runs, spendLimits, tasks } from '@/db/schema';
import { setProviderOverrideForTests } from '@/providers/registry';
import { createTask } from '@/domain/tasks/tasks';
import { claimJobForTask, enqueueRun, requestRerun, runClaimedJob } from '@/domain/jobs/jobs';
import { addProposal, appendAssistantMessage, appendOwnerMessage, createConversation } from '@/domain/opschat/conversations';
import { loadTaskStates } from '@/domain/opschat/task-state';

/**
 * P4 — Ops Chat provenance (migration 0087). Separate, immutable links:
 *  - tasks.ops_chat_proposal_id  = the dispatch card that CREATED the task (never overwritten by a re-run);
 *  - run_jobs.ops_chat_proposal_id / runs.ops_chat_proposal_id = the card behind EACH attempt / result.
 * Proves the schema (nullable, FK ON DELETE SET NULL, indexed), the round trip through the real queue + worker,
 * immutability (trigger: only the FK's own SET NULL may change it), RLS (the card stays owner-private), and that
 * Ops Chat task state names both the creating card and the card behind the latest result.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? 'test-openai-key';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'test-anthropic-key';
process.env.APP_ENCRYPTION_KEY = process.env.APP_ENCRYPTION_KEY ?? Buffer.alloc(32).toString('base64');
process.env.RATE_LIMIT_RUNS_PER_MINUTE = '1000';

const available = await rlsAvailable('opschat-provenance.test');
const db = getSetupDb();
let admin: postgres.Sql;
let app: postgres.Sql;
let owner: TenantContext;
let other: TenantContext; // a second member of the SAME workspace
let primaryId = '';

async function card(ctx: TenantContext, kind: 'dispatch_task' | 'rerun_task', proposal: Record<string, unknown>) {
  return withUser({ userId: ctx.userId }, async (tx) => {
    const conv = await createConversation(tx, ctx.userId);
    const o = await appendOwnerMessage(tx, ctx.userId, { conversationId: conv.id, content: 'go' });
    const a = await appendAssistantMessage(tx, ctx.userId, { conversationId: conv.id, replyToMessageId: o.id, content: 'card below' });
    return (await addProposal(tx, ctx.userId, { conversationId: conv.id, messageId: a.id, kind, proposal: { kind, ...proposal } })).id;
  });
}

function inject(text: string) {
  const openai = new FakeProvider('openai');
  openai.reply(text);
  setProviderOverrideForTests((id) => (id === 'openai' ? openai : undefined));
}

const newTask = (ctx: TenantContext, opsChatProposalId: string | null) =>
  withTenant(ctx, (tx) =>
    createTask(tx, ctx, {
      title: 'Duct CFM calc',
      input: 'Size the ducts.',
      providerSelection: 'openai',
      reviewEnabled: false,
      modelTier: 'standard',
      flagshipCategory: null,
      objectiveId: null,
      scheduleId: null,
      primaryAgentId: primaryId,
      reviewerAgentId: null,
      opsChatProposalId,
    }),
  );

beforeAll(async () => {
  if (!available) return;
  admin = adminSql();
  app = appSql();
  const u1 = randomUUID();
  const u2 = randomUUID();
  await db.insert(profiles).values([
    { id: u1, email: `pv1-${u1.slice(0, 8)}@t.local`, displayName: 'Owner' },
    { id: u2, email: `pv2-${u2.slice(0, 8)}@t.local`, displayName: 'Member' },
  ]);
  const orgId = (await db.insert(organizations).values({ name: 'O', slug: `pv-${u1.slice(0, 8)}` }).returning({ id: organizations.id }))[0]!.id;
  await db.insert(memberships).values([{ orgId, userId: u1, role: 'owner' }, { orgId, userId: u2, role: 'member' }]);
  const pid = (await db.insert(projects).values({ orgId, key: fixtureKey('pv'), name: 'Empera A/C' }).returning({ id: projects.id }))[0]!.id;
  await db.insert(projectMembers).values([{ orgId, projectId: pid, userId: u1, role: 'admin' }, { orgId, projectId: pid, userId: u2, role: 'member' }]);
  await db.insert(spendLimits).values({ orgId, projectId: pid, monthlyLimitMicros: 100_000_000n });
  primaryId = (
    await db
      .insert(agents)
      .values({ orgId, projectId: pid, name: 'Research Analyst', role: 'primary', provider: 'openai', model: 'gpt-x', systemPrompt: 'p', temperatureMilli: 700, maxOutputTokens: 1000 })
      .returning({ id: agents.id })
  )[0]!.id;
  owner = { userId: u1, orgId, projectId: pid, orgRole: 'owner', projectRole: 'admin' } as TenantContext;
  other = { userId: u2, orgId, projectId: pid, orgRole: 'member', projectRole: 'member' } as TenantContext;
});
afterEach(() => setProviderOverrideForTests(null));
afterAll(async () => {
  setProviderOverrideForTests(null);
  await app?.end();
  await admin?.end();
});

describe.skipIf(!available)('migration 0087 — schema', () => {
  it('adds nullable ops_chat_proposal_id to tasks, run_jobs, runs — FK to ops_chat_proposals ON DELETE SET NULL, indexed, immutability trigger', async () => {
    for (const t of ['tasks', 'run_jobs', 'runs']) {
      const col = await admin`select is_nullable, data_type from information_schema.columns where table_schema='public' and table_name=${t} and column_name='ops_chat_proposal_id'`;
      expect(col[0]).toMatchObject({ is_nullable: 'YES', data_type: 'uuid' });
      const fk = await admin`
        select c.confdeltype, cf.relname as target from pg_constraint c
          join pg_class cl on cl.oid = c.conrelid join pg_class cf on cf.oid = c.confrelid
          join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
         where c.contype = 'f' and cl.relname = ${t} and a.attname = 'ops_chat_proposal_id'`;
      expect(fk[0]).toMatchObject({ confdeltype: 'n', target: 'ops_chat_proposals' });
      const idx = await admin`select indexname from pg_indexes where tablename = ${t} and indexname = ${`${t}_ops_chat_proposal_idx`}`;
      expect(idx).toHaveLength(1);
      const trg = await admin`select tgname from pg_trigger where tgrelid = ${`public.${t}`}::regclass and tgname = ${`${t}_ops_chat_provenance_immutable`}`;
      expect(trg).toHaveLength(1);
    }
  });
});

describe.skipIf(!available)('provenance round trip (dispatch → run → re-run → run) through the real queue + worker', () => {
  it('the task keeps its DISPATCH card; each attempt and result carries its OWN card; Ops Chat names both', async () => {
    const dispatchCard = await card(owner, 'dispatch_task', { title: 'Duct CFM calc', agentId: primaryId });
    const taskId = await newTask(owner, dispatchCard);
    const first = await withTenant(owner, (tx) => enqueueRun(tx, owner, taskId, 'interactive', { opsChatProposalId: dispatchCard }));
    inject('CFM ≈ 3,160.');
    await runClaimedJob((await claimJobForTask(owner, taskId))!);

    const rerunCard = await card(owner, 'rerun_task', { taskId, taskTitle: 'Duct CFM calc' });
    const r = await withTenant(owner, (tx) => requestRerun(tx, owner, taskId, { opsChatProposalId: rerunCard }));
    expect(r.status).toBe('started');
    inject('CFM ≈ 3,200 (re-run).');
    await runClaimedJob((await claimJobForTask(owner, taskId))!);

    const t = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
    expect(t.opsChatProposalId).toBe(dispatchCard); // never overwritten by the re-run
    const jobs = await db.select().from(runJobs).where(eq(runJobs.taskId, taskId)).orderBy(asc(runJobs.createdAt));
    expect(jobs.map((j) => j.opsChatProposalId)).toEqual([dispatchCard, rerunCard]);
    expect(jobs[0]!.id).toBe(first.jobId);
    const rs = await db.select().from(runs).where(eq(runs.taskId, taskId)).orderBy(asc(runs.createdAt));
    expect(rs.map((x) => x.opsChatProposalId)).toEqual([dispatchCard, rerunCard]);

    const [state] = await withTenant(owner, (tx) => loadTaskStates(tx, owner, [taskId]));
    expect(state!.createdByCard).toMatchObject({ proposalId: dispatchCard, kind: 'dispatch_task' });
    expect(state!.latestRunCard).toMatchObject({ proposalId: rerunCard, kind: 'rerun_task' });
    expect(state!.ownerFacing).toContain(`Created by Ops Chat card ${dispatchCard.slice(0, 8)}`);
    expect(state!.ownerFacing).toContain(`latest result came from re-run card ${rerunCard.slice(0, 8)}`);
  });

  it('a task that did not come from Ops Chat, and pre-0087 rows, stay null (no backfill)', async () => {
    const taskId = await newTask(owner, null);
    await withTenant(owner, (tx) => enqueueRun(tx, owner, taskId));
    inject('ok');
    await runClaimedJob((await claimJobForTask(owner, taskId))!);
    expect((await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.opsChatProposalId).toBeNull();
    expect((await db.select().from(runs).where(eq(runs.taskId, taskId)))[0]!.opsChatProposalId).toBeNull();
    const [state] = await withTenant(owner, (tx) => loadTaskStates(tx, owner, [taskId]));
    expect(state!.createdByCard).toBeNull();
    expect(state!.ownerFacing).not.toMatch(/card/);
  });
});

describe.skipIf(!available)('immutability (trigger) — set once at insert; only the FK’s ON DELETE SET NULL may change it', () => {
  it('re-pointing, clearing by hand, or setting a link later is refused on all three tables — for the app role too', async () => {
    const c1 = await card(owner, 'dispatch_task', { title: 'x' });
    const c2 = await card(owner, 'rerun_task', { title: 'y' });
    const linked = await newTask(owner, c1);
    const bare = await newTask(owner, null);
    await withTenant(owner, (tx) => enqueueRun(tx, owner, linked, 'interactive', { opsChatProposalId: c1 }));

    // App role (RLS + grants as in production).
    await expect(asTenant(app, owner, (tx) => tx`update tasks set ops_chat_proposal_id = ${c2} where id = ${linked}`)).rejects.toThrow(/immutable provenance/);
    await expect(asTenant(app, owner, (tx) => tx`update tasks set ops_chat_proposal_id = null where id = ${linked}`)).rejects.toThrow(/immutable provenance/);
    await expect(asTenant(app, owner, (tx) => tx`update tasks set ops_chat_proposal_id = ${c2} where id = ${bare}`)).rejects.toThrow(/immutable provenance/);
    await expect(asTenant(app, owner, (tx) => tx`update run_jobs set ops_chat_proposal_id = ${c2} where task_id = ${linked}`)).rejects.toThrow(/immutable provenance/);
    // Even the owner/DDL role cannot re-point it.
    await expect(admin`update tasks set ops_chat_proposal_id = ${c2} where id = ${linked}`).rejects.toThrow(/immutable provenance/);
    // Unrelated columns stay freely updatable (the trigger fires only when the link changes).
    await asTenant(app, owner, (tx) => tx`update tasks set title = 'Duct CFM calc v2' where id = ${linked}`);
    expect((await db.select().from(tasks).where(eq(tasks.id, linked)))[0]!.opsChatProposalId).toBe(c1);
  });

  it('deleting the card (admin) clears the links through the FK — the one permitted change', async () => {
    const c = await card(owner, 'dispatch_task', { title: 'z' });
    const taskId = await newTask(owner, c);
    await withTenant(owner, (tx) => enqueueRun(tx, owner, taskId, 'interactive', { opsChatProposalId: c }));
    await admin`delete from ops_chat_proposals where id = ${c}`;
    expect((await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.opsChatProposalId).toBeNull();
    expect((await db.select().from(runJobs).where(eq(runJobs.taskId, taskId)))[0]!.opsChatProposalId).toBeNull();
  });
});

describe.skipIf(!available)('RLS — the card stays owner-private', () => {
  it('another workspace member sees the task and its link id, but cannot read the card; their state view shows a bare id', async () => {
    const c = await card(owner, 'dispatch_task', { title: 'private' });
    const taskId = await newTask(owner, c);
    const seen = await asTenant(app, other, (tx) => tx`select ops_chat_proposal_id as p from tasks where id = ${taskId}`);
    expect(seen[0]?.p).toBe(c);
    const cardRead = await asUser(app, other.userId, (tx) => tx`select id from ops_chat_proposals where id = ${c}`);
    expect(cardRead).toHaveLength(0);
    const own = await asUser(app, owner.userId, (tx) => tx`select id from ops_chat_proposals where id = ${c}`);
    expect(own).toHaveLength(1);
    // The same join loadTaskStates performs, under the production app role: the member gets the bare id only.
    const joined = await asTenant(
      app,
      other,
      (tx) => tx`select t.ops_chat_proposal_id as p, pr.kind from tasks t left join ops_chat_proposals pr on pr.id = t.ops_chat_proposal_id where t.id = ${taskId}`,
    );
    expect(joined[0]).toMatchObject({ p: c, kind: null });
    // A different organization cannot see the task at all.
    const stranger = { ...other, orgId: randomUUID(), projectId: randomUUID(), userId: randomUUID() } as TenantContext;
    expect(await asTenant(app, stranger, (tx) => tx`select id from tasks where id = ${taskId}`)).toHaveLength(0);
  });
});
