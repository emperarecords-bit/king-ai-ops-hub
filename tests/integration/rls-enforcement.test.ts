import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSql, appSql, asTenant, asUser, rlsAvailable } from '@tests/support/db';

/**
 * O-22 — Production RLS enforcement, proven while connected as the non-superuser
 * `app_server` role (NOT the migration superuser that dev/most tests use).
 *
 * Setup runs as the migration role (admin); every ASSERTION runs as app_server,
 * so RLS is what blocks access — not the app-layer WHERE filters, which are
 * deliberately omitted here. Covers acceptance Tests 1–4, 6, 7, 10 plus the
 * role guard. Test 5 (worker) lives in worker-isolation.test.ts.
 */

const available = await rlsAvailable('rls-enforcement.test');

// Two orgs; org A has two workspaces (A1, A2); org B has one (B1).
const ids = {
  userA: randomUUID(), // member of A1 + A2
  userB: randomUUID(), // member of B1 only
  outsider: randomUUID(), // no memberships
  orgA: randomUUID(),
  orgB: randomUUID(),
  A1: randomUUID(),
  A2: randomUUID(),
  B1: randomUUID(),
  agentA1: randomUUID(),
  agentA2: randomUUID(),
  agentB1: randomUUID(),
  taskA1: randomUUID(),
  taskA1b: randomUUID(),
  taskA2: randomUUID(),
  taskB1: randomUUID(),
  runA1: randomUUID(),
  runA2: randomUUID(),
  runB1: randomUUID(),
  docA1: randomUUID(),
  docA2: randomUUID(),
  docB1: randomUUID(),
};

let admin: postgres.Sql;
let app: postgres.Sql;

beforeAll(async () => {
  if (!available) return;
  admin = adminSql();
  app = appSql();

  await admin`insert into profiles (id, email, display_name) values
    (${ids.userA}, ${`a-${ids.userA.slice(0, 8)}@t.local`}, 'User A'),
    (${ids.userB}, ${`b-${ids.userB.slice(0, 8)}@t.local`}, 'User B'),
    (${ids.outsider}, ${`o-${ids.outsider.slice(0, 8)}@t.local`}, 'Outsider')`;
  await admin`insert into organizations (id, name, slug) values
    (${ids.orgA}, 'Org A', ${`o22a-${ids.orgA.slice(0, 8)}`}),
    (${ids.orgB}, 'Org B', ${`o22b-${ids.orgB.slice(0, 8)}`})`;
  await admin`insert into memberships (org_id, user_id, role) values
    (${ids.orgA}, ${ids.userA}, 'owner'),
    (${ids.orgB}, ${ids.userB}, 'owner')`;
  await admin`insert into projects (id, org_id, key, name) values
    (${ids.A1}, ${ids.orgA}, ${`zz-fixture-a1-${ids.A1.slice(0, 8)}`}, 'A1'),
    (${ids.A2}, ${ids.orgA}, ${`zz-fixture-a2-${ids.A2.slice(0, 8)}`}, 'A2'),
    (${ids.B1}, ${ids.orgB}, ${`zz-fixture-b1-${ids.B1.slice(0, 8)}`}, 'B1')`;
  await admin`insert into project_members (org_id, project_id, user_id, role) values
    (${ids.orgA}, ${ids.A1}, ${ids.userA}, 'admin'),
    (${ids.orgA}, ${ids.A2}, ${ids.userA}, 'admin'),
    (${ids.orgB}, ${ids.B1}, ${ids.userB}, 'admin')`;
  await admin`insert into agents (id, org_id, project_id, name, provider, model, system_prompt) values
    (${ids.agentA1}, ${ids.orgA}, ${ids.A1}, 'AgA1', 'openai', 'gpt-5.4-mini', 'x'),
    (${ids.agentA2}, ${ids.orgA}, ${ids.A2}, 'AgA2', 'openai', 'gpt-5.4-mini', 'x'),
    (${ids.agentB1}, ${ids.orgB}, ${ids.B1}, 'AgB1', 'openai', 'gpt-5.4-mini', 'x')`;
  await admin`insert into tasks (id, org_id, project_id, title, input, provider_selection, created_by, status) values
    (${ids.taskA1}, ${ids.orgA}, ${ids.A1}, 'A1 task', 'secret-A1', 'openai', ${ids.userA}, 'completed'),
    (${ids.taskA1b}, ${ids.orgA}, ${ids.A1}, 'A1 task b', 'secret-A1b', 'openai', ${ids.userA}, 'pending'),
    (${ids.taskA2}, ${ids.orgA}, ${ids.A2}, 'A2 task', 'secret-A2', 'openai', ${ids.userA}, 'completed'),
    (${ids.taskB1}, ${ids.orgB}, ${ids.B1}, 'B1 task', 'secret-B1', 'openai', ${ids.userB}, 'completed')`;
  await admin`insert into runs (id, org_id, project_id, task_id, primary_agent_id, classification) values
    (${ids.runA1}, ${ids.orgA}, ${ids.A1}, ${ids.taskA1}, ${ids.agentA1}, 'live'),
    (${ids.runA2}, ${ids.orgA}, ${ids.A2}, ${ids.taskA2}, ${ids.agentA2}, 'live'),
    (${ids.runB1}, ${ids.orgB}, ${ids.B1}, ${ids.taskB1}, ${ids.agentB1}, 'live')`;
  await admin`insert into documents (id, org_id, project_id, relative_path, kind, sha256, size_bytes) values
    (${ids.docA1}, ${ids.orgA}, ${ids.A1}, 'a1.md', 'markdown', 'h-a1', 10),
    (${ids.docA2}, ${ids.orgA}, ${ids.A2}, 'a2.md', 'markdown', 'h-a2', 10),
    (${ids.docB1}, ${ids.orgB}, ${ids.B1}, 'b1.md', 'markdown', 'h-b1', 10)`;
  await admin`insert into document_chunks (org_id, project_id, document_id, chunk_index, content) values
    (${ids.orgA}, ${ids.A1}, ${ids.docA1}, 0, 'chunk-A1'),
    (${ids.orgA}, ${ids.A2}, ${ids.docA2}, 0, 'chunk-A2'),
    (${ids.orgB}, ${ids.B1}, ${ids.docB1}, 0, 'chunk-B1')`;
  await admin`insert into decisions (org_id, project_id, title, summary, author_label, status) values
    (${ids.orgA}, ${ids.A1}, 'A1 accepted', 'sum', 'Owner', 'accepted'),
    (${ids.orgA}, ${ids.A1}, 'A1 candidate', 'sum', 'AI', 'proposed'),
    (${ids.orgA}, ${ids.A2}, 'A2 accepted', 'sum', 'Owner', 'accepted'),
    (${ids.orgB}, ${ids.B1}, 'B1 accepted', 'sum', 'Owner', 'accepted')`;
  await admin`insert into task_dependencies (org_id, project_id, prerequisite_task_id, dependent_task_id) values
    (${ids.orgA}, ${ids.A1}, ${ids.taskA1}, ${ids.taskA1b})`;
  // 'done' (not 'queued'): this row exists only so run_jobs is exercised by the
  // isolation reads; leaving it claimable would pollute the global claimNextJob
  // that the worker/run-jobs tests exercise concurrently.
  await admin`insert into run_jobs (org_id, project_id, task_id, status) values
    (${ids.orgA}, ${ids.A1}, ${ids.taskA1b}, 'done')`;

  await app`select 1`;
});

afterAll(async () => {
  if (admin && available) {
    for (const org of [ids.orgA, ids.orgB]) {
      await admin`delete from run_jobs where org_id = ${org}`;
      await admin`delete from task_dependencies where org_id = ${org}`;
      await admin`delete from decisions where org_id = ${org}`;
      await admin`delete from document_chunks where org_id = ${org}`;
      await admin`delete from documents where org_id = ${org}`;
      await admin`delete from runs where org_id = ${org}`;
      await admin`delete from tasks where org_id = ${org}`;
      await admin`delete from agents where org_id = ${org}`;
      await admin`delete from project_members where org_id = ${org}`;
      await admin`delete from projects where org_id = ${org}`;
      await admin`delete from memberships where org_id = ${org}`;
      await admin`delete from organizations where id = ${org}`;
    }
    await admin`delete from profiles where id in (${ids.userA}, ${ids.userB}, ${ids.outsider})`;
  }
  await admin?.end();
  await app?.end();
});

// The protected tenant tables named by the sprint's policy audit.
const TENANT_TABLES = [
  'agents', 'project_context_items', 'integration_secrets', 'tasks', 'runs',
  'run_steps', 'messages', 'artifacts', 'approvals', 'usage_events',
  'spend_limits', 'objectives', 'milestones', 'knowledge_items',
  'task_schedules', 'documents', 'document_chunks', 'task_dependencies',
  'decisions', 'knowledge_disclosure_grants', 'run_jobs',
];

describe.skipIf(!available)('O-22 RLS enforcement (as app_server)', () => {
  it('GUARD: the test connection is a non-superuser, non-bypassrls role that owns no protected table', async () => {
    const who = await app`select current_user as u,
      (select rolsuper from pg_roles where rolname = current_user) as super,
      (select rolbypassrls from pg_roles where rolname = current_user) as bypass`;
    expect(who[0]!.u).toBe('app_server');
    expect(who[0]!.super).toBe(false);
    expect(who[0]!.bypass).toBe(false);

    const owned = await app`
      select c.relname from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and pg_get_userbyid(c.relowner) = current_user`;
    expect(owned.map((r) => r.relname)).toEqual([]);
  });

  it('Test 1 — cross-ORGANIZATION read returns zero rows, even filterless', async () => {
    const rows = await asTenant(app, { userId: ids.userA, orgId: ids.orgA, projectId: ids.A1 }, async (tx) => ({
      tasks: await tx`select input from tasks`,
      runs: await tx`select id from runs`,
      documents: await tx`select relative_path from documents`,
      chunks: await tx`select content from document_chunks`,
      decisions: await tx`select title from decisions`,
      deps: await tx`select id from task_dependencies`,
    }));
    // Only A1 data is visible; nothing from org B leaks in.
    expect(rows.tasks.map((r) => r.input).sort()).toEqual(['secret-A1', 'secret-A1b']);
    expect(rows.tasks.some((r) => r.input === 'secret-B1')).toBe(false);
    expect(rows.documents.map((r) => r.relative_path)).toEqual(['a1.md']);
    expect(rows.chunks.map((r) => r.content)).toEqual(['chunk-A1']);
    expect(rows.decisions.map((r) => r.title).sort()).toEqual(['A1 accepted', 'A1 candidate']);
    expect(rows.runs.length).toBe(1);
    expect(rows.deps.length).toBe(1);
  });

  it('Test 2 — cross-WORKSPACE read within one org returns zero protected rows', async () => {
    const rows = await asTenant(app, { userId: ids.userA, orgId: ids.orgA, projectId: ids.A1 }, async (tx) => ({
      a2Tasks: await tx`select id from tasks where input = 'secret-A2'`,
      allTasksInputs: await tx`select input from tasks`,
      a2Docs: await tx`select id from documents where relative_path = 'a2.md'`,
    }));
    expect(rows.a2Tasks.length).toBe(0);
    expect(rows.allTasksInputs.some((r) => r.input === 'secret-A2')).toBe(false);
    expect(rows.a2Docs.length).toBe(0);
  });

  it('Test 3 — cross-tenant INSERT is rejected by WITH CHECK (other org AND other workspace)', async () => {
    // Into org B while in A1 context.
    await expect(
      asTenant(app, { userId: ids.userA, orgId: ids.orgA, projectId: ids.A1 }, (tx) =>
        tx`insert into tasks (org_id, project_id, title, input, provider_selection, created_by)
           values (${ids.orgB}, ${ids.B1}, 'smuggled', 'x', 'openai', ${ids.userA})`,
      ),
    ).rejects.toThrow();
    // Into sibling workspace A2 while in A1 context.
    await expect(
      asTenant(app, { userId: ids.userA, orgId: ids.orgA, projectId: ids.A1 }, (tx) =>
        tx`insert into tasks (org_id, project_id, title, input, provider_selection, created_by)
           values (${ids.orgA}, ${ids.A2}, 'smuggled', 'x', 'openai', ${ids.userA})`,
      ),
    ).rejects.toThrow();
  });

  it('Test 4 — cross-tenant UPDATE (repointing org/project) is rejected', async () => {
    // Move an A1 task into A2.
    await expect(
      asTenant(app, { userId: ids.userA, orgId: ids.orgA, projectId: ids.A1 }, (tx) =>
        tx`update tasks set project_id = ${ids.A2} where id = ${ids.taskA1}`,
      ),
    ).rejects.toThrow();
    // Move an A1 task into org B.
    await expect(
      asTenant(app, { userId: ids.userA, orgId: ids.orgA, projectId: ids.A1 }, (tx) =>
        tx`update tasks set org_id = ${ids.orgB}, project_id = ${ids.B1} where id = ${ids.taskA1}`,
      ),
    ).rejects.toThrow();
    // The row is unchanged (admin peek).
    const still = await admin`select project_id from tasks where id = ${ids.taskA1}`;
    expect(still[0]!.project_id).toBe(ids.A1);
  });

  it('Test 6 — with NO tenant context, protected reads see nothing and writes are rejected', async () => {
    const rows = await app`select count(*)::int as n from tasks`; // no GUCs set
    expect(rows[0]!.n).toBe(0);
    await expect(
      app`insert into tasks (org_id, project_id, title, input, provider_selection, created_by)
          values (${ids.orgA}, ${ids.A1}, 'no-ctx', 'x', 'openai', ${ids.userA})`,
    ).rejects.toThrow();
  });

  it('Test 7 — membership access: member sees own workspace; outsider and other-org member see nothing', async () => {
    // userA (member) sees A1.
    const a = await asTenant(app, { userId: ids.userA, orgId: ids.orgA, projectId: ids.A1 }, (tx) =>
      tx`select count(*)::int as n from tasks`,
    );
    expect(a[0]!.n).toBeGreaterThan(0);

    // Outsider, even with forged GUCs naming A1, sees no project row and no tenant rows beyond what the GUC names.
    const outProjects = await asUser(app, ids.outsider, (tx) => tx`select id from projects`);
    expect(outProjects.length).toBe(0);
    const outMemberships = await asUser(app, ids.outsider, (tx) => tx`select id from memberships`);
    expect(outMemberships.length).toBe(0);

    // userB (org B) cannot see org A's projects during bootstrap.
    const bProjects = await asUser(app, ids.userB, (tx) => tx`select id from projects`);
    expect(bProjects.map((r) => r.id)).toEqual([ids.B1]);

    // userA at bootstrap sees exactly their two workspaces.
    const aProjects = await asUser(app, ids.userA, (tx) => tx`select id from projects order by 1`);
    expect(aProjects.map((r) => r.id).sort()).toEqual([ids.A1, ids.A2].sort());
  });

  it('Test 10 — policy regression guard: every tenant table has RLS enabled+forced, is not owned by app_server, and grants no unsafe privilege', async () => {
    const meta = await admin`
      select c.relname,
             c.relrowsecurity as enabled,
             c.relforcerowsecurity as forced,
             pg_get_userbyid(c.relowner) as owner
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and c.relname = any(${TENANT_TABLES})`;
    expect(meta.length).toBe(TENANT_TABLES.length);
    for (const row of meta) {
      expect(row.enabled, `${row.relname} RLS enabled`).toBe(true);
      expect(row.forced, `${row.relname} RLS forced`).toBe(true);
      expect(row.owner, `${row.relname} not owned by app_server`).not.toBe('app_server');
    }
    // app_server must hold no unsafe broad privilege (TRUNCATE/REFERENCES/TRIGGER)
    // on any protected table — only select/insert/update(/delete).
    const unsafe = await admin`
      select table_name, privilege_type
      from information_schema.role_table_grants
      where grantee = 'app_server'
        and table_name = any(${TENANT_TABLES})
        and privilege_type in ('TRUNCATE', 'REFERENCES', 'TRIGGER')`;
    expect(unsafe.map((r) => `${r.table_name}:${r.privilege_type}`)).toEqual([]);

    // Every tenant table has its `_tenant` policy present.
    const policies = await admin`
      select tablename from pg_policies
      where schemaname = 'public' and policyname = tablename || '_tenant'`;
    const withPolicy = new Set(policies.map((r) => r.tablename));
    for (const t of TENANT_TABLES) {
      expect(withPolicy.has(t), `${t} has a _tenant policy`).toBe(true);
    }
  });
});
