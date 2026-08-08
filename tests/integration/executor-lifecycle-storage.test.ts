import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSql, appSql, asTenant, rlsAvailable } from '@tests/support/db';

let available = await rlsAvailable('executor-lifecycle-storage.test');
if (available) {
  const probe = adminSql();
  try { await probe`select 1 from executor_executions limit 1`; }
  catch { available = false; console.warn('[executor-lifecycle-storage.test] SKIPPING — 0058 schema not applied'); }
  finally { await probe.end(); }
}
const ids = { user: randomUUID(), org: randomUUID(), project: randomUUID(), task: randomUUID(), approval: randomUUID() };
const hash = (c: string) => c.repeat(64);
let admin: postgres.Sql;
let app: postgres.Sql;

beforeAll(async () => {
  if (!available) return;
  admin = adminSql(); app = appSql();
  await admin`insert into profiles (id,email,display_name) values (${ids.user},${`exec-${ids.user.slice(0,8)}@test.local`},'Executor Owner')`;
  await admin`insert into organizations (id,name,slug) values (${ids.org},'Executor Org',${`exec-${ids.org.slice(0,8)}`})`;
  await admin`insert into memberships (org_id,user_id,role) values (${ids.org},${ids.user},'owner')`;
  await admin`insert into projects (id,org_id,key,name) values (${ids.project},${ids.org},${`zz-exec-${ids.project.slice(0,8)}`},'Executor Project')`;
  await admin`insert into project_members (org_id,project_id,user_id,role) values (${ids.org},${ids.project},${ids.user},'admin')`;
  await admin`insert into tasks (id,org_id,project_id,title,input,provider_selection,created_by,status) values (${ids.task},${ids.org},${ids.project},'Preview','x','openai',${ids.user},'completed')`;
  await admin`insert into approvals (id,org_id,project_id,task_id,action_type,payload,payload_sha256,summary,status,decided_by,decided_at,expires_at) values (${ids.approval},${ids.org},${ids.project},${ids.task},'file_write',${admin.json({path:'plans/test.md'})},${hash('a')},'Preview', 'approved',${ids.user},now(),now()+interval '1 hour')`;
});

afterAll(async () => {
  if (!admin) return;
  await admin`delete from executor_execution_attempts where org_id=${ids.org}`;
  await admin`delete from executor_executions where org_id=${ids.org}`;
  await admin`delete from approvals where org_id=${ids.org}`;
  await admin`delete from tasks where org_id=${ids.org}`;
  await admin`delete from project_members where org_id=${ids.org}`;
  await admin`delete from projects where org_id=${ids.org}`;
  await admin`delete from memberships where org_id=${ids.org}`;
  await admin`delete from organizations where id=${ids.org}`;
  await admin`delete from profiles where id=${ids.user}`;
  await admin.end(); await app.end();
});

function values(key: string, confirmation = randomUUID(), target = 'plans/test.md') {
  return { key, confirmation, target };
}

async function insertExecution(v: ReturnType<typeof values>, state = 'confirmed', reconciliation = 'not_required') {
  return asTenant(app, { userId: ids.user, orgId: ids.org, projectId: ids.project }, (tx) => tx`
    insert into executor_executions
      (org_id,project_id,approval_id,task_id,executor_id,executor_version,action_type,risk_class,mode,
       workspace_storage_id,normalized_target,target_collision_key,payload_sha256,precondition_kind,desired_sha256,
       confirmation_id,confirmation_sha256,confirmed_by,confirmation_expires_at,actor_id,idempotency_key,correlation_id,state,reconciliation_state)
    values (${ids.org},${ids.project},${ids.approval},${ids.task},'sandboxed_file_write_v1','1','file_write','reversible_internal_write','live',
      'storage-1',${v.target},${v.target.toLowerCase()},${hash('a')},'absent',${hash('b')},${v.confirmation},${hash('c')},${ids.user},now()+interval '10 minutes',${ids.user},${v.key},${randomUUID()},${state},${reconciliation})
    returning id`);
}

describe.skipIf(!available)('executor lifecycle storage', { timeout: 20_000 }, () => {
  it('stores a tenant-scoped lifecycle row and hides it without tenant context', async () => {
    const row = await insertExecution(values(`key-${randomUUID()}`));
    expect(row).toHaveLength(1);
    expect((await app`select id from executor_executions where id=${row[0]!.id}`)).toHaveLength(0);
    const crossTenant = await asTenant(
      app,
      { userId: ids.user, orgId: randomUUID(), projectId: randomUUID() },
      (tx) => tx`select id from executor_executions where id=${row[0]!.id}`,
    );
    expect(crossTenant).toHaveLength(0);
  });

  it('enforces scoped idempotency, single-use confirmation, and one active target', async () => {
    const key = `key-${randomUUID()}`; const confirmation = randomUUID();
    await insertExecution(values(key, confirmation, `plans/${randomUUID()}.md`));
    await expect(insertExecution(values(key, randomUUID(), `plans/${randomUUID()}.md`))).rejects.toThrow();
    await expect(insertExecution(values(`key-${randomUUID()}`, confirmation, `plans/${randomUUID()}.md`))).rejects.toThrow();
    const target = `plans/${randomUUID()}.md`;
    await insertExecution(values(`key-${randomUUID()}`, randomUUID(), target), 'claimed');
    await expect(insertExecution(values(`key-${randomUUID()}`, randomUUID(), target), 'claimed')).rejects.toThrow();
  });

  it('requires ambiguity to enter reconciliation', async () => {
    await expect(insertExecution(values(`key-${randomUUID()}`), 'ambiguous', 'not_required')).rejects.toThrow();
    expect(await insertExecution(values(`key-${randomUUID()}`), 'ambiguous', 'required')).toHaveLength(1);
  });
});
