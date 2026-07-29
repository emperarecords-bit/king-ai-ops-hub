/**
 * HUB-005 approved real-workspace change: assign the objective "Activate first 3 pilot contractors"
 * to Tom Brown (Customer Activation Manager) through the canonical, audited domain function
 * `setObjectiveOwner` — never a raw FK write. Then verify the 9 gate checks against accuratebids-com.
 *
 * One-off, run in the staging container:
 *   npx tsx --conditions=react-server scripts/hub005-assign-owner.ts
 */
import postgres from 'postgres';
import { withTenant } from '@/db/tenant';
import { getObjective, listObjectives, setObjectiveOwner } from '@/domain/objectives/objectives';
import type { TenantContext } from '@/types/domain';

const PROJECT_KEY = 'accuratebids-com';
const OBJECTIVE_ID = '9cd71c11-6fad-4241-9a03-2d76f5fac835'; // "Activate first 3 pilot contractors"
const TOM_BROWN = '47f1dea9-e12c-4246-b946-60dde12145ae'; // Customer Activation Manager

async function main(): Promise<void> {
  const admin = postgres(process.env.DATABASE_MIGRATION_URL!, { prepare: false });
  const proj = (await admin`select id, org_id from projects where key = ${PROJECT_KEY}`)[0];
  if (!proj) throw new Error(`project ${PROJECT_KEY} not found`);
  const adminUser = (await admin`select user_id from project_members where project_id = ${proj.id} and role = 'admin' limit 1`)[0];
  if (!adminUser) throw new Error('no admin user for project');

  const ctx: TenantContext = {
    userId: adminUser.user_id,
    orgId: proj.org_id,
    projectId: proj.id,
    orgRole: 'owner',
    projectRole: 'admin',
  };

  const auditCount = async (): Promise<number> =>
    Number((await admin`select count(*)::int n from audit_logs where entity_id = ${OBJECTIVE_ID} and action = 'objective.owner_assigned'`)[0]!.n);
  const taskState = async (): Promise<string> =>
    JSON.stringify(await admin`select id, status from tasks where objective_id = ${OBJECTIVE_ID} order by id`);

  // PRE-STATE.
  const before = await withTenant(ctx, (tx) => getObjective(tx, ctx, OBJECTIVE_ID));
  const beforeAudit = await auditCount();
  const beforeTasks = await taskState();
  console.log('PRE  owner=%s status=%s progress=%d%% tasks=%d/%d assignedEvents=%d',
    before.accountableAgentId, before.status, before.progress.percent, before.progress.tasksCompleted, before.progress.tasksTotal, beforeAudit);

  // THE APPROVED CHANGE (audited domain function).
  await withTenant(ctx, (tx) => setObjectiveOwner(tx, ctx, OBJECTIVE_ID, TOM_BROWN));

  // Idempotency proof: repeat the same assignment — must add NO event.
  await withTenant(ctx, (tx) => setObjectiveOwner(tx, ctx, OBJECTIVE_ID, TOM_BROWN));

  // POST-STATE — read through the SAME domain functions the UI uses.
  const detail1 = await withTenant(ctx, (tx) => getObjective(tx, ctx, OBJECTIVE_ID)); // detail
  const detail2 = await withTenant(ctx, (tx) => getObjective(tx, ctx, OBJECTIVE_ID)); // "refresh" = fresh read
  const list = await withTenant(ctx, (tx) => listObjectives(tx, ctx));
  const listRow = list.find((o) => o.id === OBJECTIVE_ID)!;
  const afterAudit = await auditCount();
  const afterTasks = await taskState();

  console.log('\n=== HUB-005 real-workspace verification (accuratebids-com) ===');
  console.log('1. accountable_agent_id == Tom Brown        :', detail1.accountableAgentId === TOM_BROWN);
  console.log('2. exactly ONE new owner_assigned event     :', afterAudit - beforeAudit === 1, `(before=${beforeAudit} after=${afterAudit})`);
  console.log('3. detail displays Tom Brown                :', detail1.accountableEmployee);
  console.log('4. refresh still displays Tom Brown         :', detail2.accountableEmployee);
  console.log('5. Objectives list shows Tom Brown          :', listRow.accountableEmployee);
  console.log('6. list/detail (Dashboard+briefing source) consistent :', detail1.accountableEmployee === listRow.accountableEmployee);
  console.log('7. fresh read (== new session) shows owner  :', detail2.accountableAgentId === TOM_BROWN);
  console.log('8. repeat assignment added NO extra event   :', afterAudit - beforeAudit === 1);
  console.log('9a. objective status unchanged              :', before.status === detail1.status, `(${detail1.status})`);
  console.log('9b. progress unchanged                      :', before.progress.percent === detail1.progress.percent && before.progress.tasksTotal === detail1.progress.tasksTotal && before.progress.tasksCompleted === detail1.progress.tasksCompleted);
  console.log('9c. task statuses/routing unchanged         :', beforeTasks === afterTasks);

  await admin.end();
}

main().then(() => process.exit(0)).catch((e) => { console.error('ERR', e); process.exit(1); });
