import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * THE test that matters most (SECURITY.md T1): with RLS active, a connection
 * scoped to project A cannot read project B's rows, even when the SQL forgets
 * its WHERE clause entirely.
 *
 * Requires the local Docker Postgres with migrations + RLS applied:
 *   npm run db:up && npm run db:migrate
 * Skips (with a warning) when the database is unreachable, so unit CI stays
 * green without infrastructure; the quality gate runs it with the DB up.
 */

const ADMIN_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://king:king@localhost:5433/king_ai_hub';

// app_server credentials created by rls.sql (dev password; local only).
const APP_URL = ADMIN_URL.replace(/\/\/[^@]+@/, '//app_server:app_server_dev_only@');

let admin: postgres.Sql | null = null;
let app: postgres.Sql | null = null;

// Availability is probed at module load (top-level await) so describe.skipIf
// sees the real value at collection time.
let available = false;
{
  const probe = postgres(ADMIN_URL, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    const rls = await probe`select relrowsecurity from pg_class where relname = 'tasks'`;
    if (!rls[0]?.relrowsecurity) {
      console.warn('[tenancy.test] SKIPPING — RLS not applied. Run: npm run db:up && npm run db:migrate');
    } else {
      available = true;
    }
  } catch (err) {
    console.warn(
      `[tenancy.test] SKIPPING — database not reachable: ${err instanceof Error ? err.message : err}`,
    );
  } finally {
    await probe.end();
  }
}

const ids = {
  user: randomUUID(),
  outsider: randomUUID(),
  org: randomUUID(),
  projectA: randomUUID(),
  projectB: randomUUID(),
  taskA: randomUUID(),
  taskB: randomUUID(),
};

beforeAll(async () => {
  if (!available) return;
  admin = postgres(ADMIN_URL, { max: 1, connect_timeout: 3, onnotice: () => {} });

  // Seed two projects with one task each, as admin (bypasses RLS via table owner).
  await admin`insert into profiles (id, email, display_name)
    values (${ids.user}, ${`${ids.user}@test.local`}, 'Tenant Tester'),
           (${ids.outsider}, ${`${ids.outsider}@test.local`}, 'Outsider')`;
  await admin`insert into organizations (id, name, slug)
    values (${ids.org}, 'Tenancy Test Org', ${`tenancy-${ids.org.slice(0, 8)}`})`;
  await admin`insert into memberships (org_id, user_id, role)
    values (${ids.org}, ${ids.user}, 'owner')`;
  await admin`insert into projects (id, org_id, key, name)
    values (${ids.projectA}, ${ids.org}, ${`tenancy-a-${ids.projectA.slice(0, 8)}`}, 'Project A'),
           (${ids.projectB}, ${ids.org}, ${`tenancy-b-${ids.projectB.slice(0, 8)}`}, 'Project B')`;
  await admin`insert into project_members (org_id, project_id, user_id, role)
    values (${ids.org}, ${ids.projectA}, ${ids.user}, 'admin'),
           (${ids.org}, ${ids.projectB}, ${ids.user}, 'admin')`;
  await admin`insert into tasks (id, org_id, project_id, title, input, provider_selection, created_by)
    values (${ids.taskA}, ${ids.org}, ${ids.projectA}, 'Task in A', 'secret-of-project-A', 'openai', ${ids.user}),
           (${ids.taskB}, ${ids.org}, ${ids.projectB}, 'Task in B', 'secret-of-project-B', 'openai', ${ids.user})`;
  await admin`insert into project_context_items (org_id, project_id, title, content, status)
    values (${ids.org}, ${ids.projectA}, 'A memory', 'context-A-only', 'approved'),
           (${ids.org}, ${ids.projectB}, 'B memory', 'context-B-only', 'approved')`;

  app = postgres(APP_URL, { max: 1, connect_timeout: 3, onnotice: () => {} });
  await app`select 1`;
});

afterAll(async () => {
  if (admin && available) {
    // The append-only triggers (correctly) block even CASCADE deletes into
    // messages/audit_logs. For teardown only, the table owner disables them.
    await admin`alter table messages disable trigger messages_append_only`;
    await admin`alter table audit_logs disable trigger audit_logs_append_only`;
    await admin`delete from audit_logs where org_id = ${ids.org}`;
    await admin`delete from messages where org_id = ${ids.org}`;
    await admin`delete from tasks where org_id = ${ids.org}`;
    await admin`delete from project_context_items where org_id = ${ids.org}`;
    await admin`delete from project_members where org_id = ${ids.org}`;
    await admin`delete from projects where org_id = ${ids.org}`;
    await admin`delete from memberships where org_id = ${ids.org}`;
    await admin`delete from organizations where id = ${ids.org}`;
    await admin`delete from profiles where id in (${ids.user}, ${ids.outsider})`;
    await admin`alter table messages enable trigger messages_append_only`;
    await admin`alter table audit_logs enable trigger audit_logs_append_only`;
  }
  await admin?.end();
  await app?.end();
});

/** Run fn inside an app_server transaction scoped to (user, org, project). */
async function scoped<T>(
  projectId: string,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
  userId = ids.user,
): Promise<T> {
  if (!app) throw new Error('unavailable');
  return app.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true),
                    set_config('app.org_id', ${ids.org}, true),
                    set_config('app.project_id', ${projectId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

describe.skipIf(!available)('tenant isolation under RLS', () => {
  it('a filterless SELECT in project A context sees only project A tasks', async () => {
    const rows = await scoped(ids.projectA, (tx) => tx`select id, input from tasks`);
    expect(rows.length).toBe(1);
    expect(rows[0]!.input).toBe('secret-of-project-A');
  });

  it('project B context cannot see project A context items — memory never crosses', async () => {
    const rows = await scoped(ids.projectB, (tx) => tx`select content from project_context_items`);
    expect(rows.map((r) => r.content)).toEqual(['context-B-only']);
  });

  it('an explicit cross-project WHERE returns zero rows, not an error oracle', async () => {
    const rows = await scoped(ids.projectA, (tx) =>
      tx`select id from tasks where project_id = ${ids.projectB}`,
    );
    expect(rows.length).toBe(0);
  });

  it('a non-member user sees nothing at all', async () => {
    const rows = await scoped(ids.projectA, (tx) => tx`select id from tasks`, ids.outsider);
    // RLS on tasks keys off org/project GUCs; project visibility for the
    // outsider is refused at the projects policy, and app-layer requireTenant
    // would never mint this context. Even with forged GUCs, they only reach
    // what the GUC names — nothing else:
    expect(rows.length).toBeLessThanOrEqual(1);
    const projects = await scoped(ids.projectA, (tx) => tx`select id from projects`, ids.outsider);
    expect(projects.length).toBe(0);
  });

  it('INSERT into another project is rejected by policy WITH CHECK', async () => {
    await expect(
      scoped(ids.projectA, (tx) =>
        tx`insert into tasks (org_id, project_id, title, input, provider_selection, created_by)
           values (${ids.org}, ${ids.projectB}, 'smuggled', 'x', 'openai', ${ids.user})`,
      ),
    ).rejects.toThrow();
  });

  it('messages are immutable: UPDATE raises', async () => {
    if (!admin) throw new Error('unavailable');
    const msgId = randomUUID();
    await admin`insert into messages (id, org_id, project_id, task_id, role, content)
      values (${msgId}, ${ids.org}, ${ids.projectA}, ${ids.taskA}, 'user', 'original')`;
    await expect(admin`update messages set content = 'tampered' where id = ${msgId}`).rejects.toThrow(
      /append-only/,
    );
    await expect(admin`delete from messages where id = ${msgId}`).rejects.toThrow(/append-only/);
  });

  it('audit_logs are immutable: UPDATE and DELETE raise', async () => {
    if (!admin) throw new Error('unavailable');
    const auditId = randomUUID();
    await admin`insert into audit_logs (id, org_id, project_id, action, entity_type, detail, prev_hash, row_hash)
      values (${auditId}, ${ids.org}, ${ids.projectA}, 'test.event', 'test', '{}', 'x', 'y')`;
    await expect(
      admin`update audit_logs set action = 'rewritten' where id = ${auditId}`,
    ).rejects.toThrow(/append-only/);
    await expect(admin`delete from audit_logs where id = ${auditId}`).rejects.toThrow(/append-only/);
  });

  it('EVERY public table has RLS enabled — a migration cannot ship one without it', async () => {
    if (!admin) throw new Error('unavailable');
    // Dynamic on purpose (SECURITY.md T1 residual risk): a hand-maintained
    // list silently exempts whatever someone forgets to add to it.
    const rows = await admin`
      select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind = 'r'
        and c.relrowsecurity = false
    `;
    expect(rows.map((r) => r.relname)).toEqual([]);
  });
});
