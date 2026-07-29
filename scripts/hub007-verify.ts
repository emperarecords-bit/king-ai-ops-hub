/**
 * HUB-007 read-only verification against accuratebids-com. Runs the REAL assessWorkspaceHealth +
 * briefingSummary. NEVER mutates.
 *   npx tsx --conditions=react-server scripts/hub007-verify.ts
 */
import postgres from 'postgres';
import { withTenant } from '@/db/tenant';
import { assessWorkspaceHealth, briefingSummary, outcomeLine } from '@/domain/health/health';
import type { TenantContext } from '@/types/domain';

async function main(): Promise<void> {
  const admin = postgres(process.env.DATABASE_MIGRATION_URL!, { prepare: false });
  const proj = (await admin`select id, org_id, name from projects where key = 'accuratebids-com'`)[0];
  if (!proj) throw new Error('project not found');
  const adminUser = (await admin`select user_id from project_members where project_id = ${proj.id} and role = 'admin' limit 1`)[0];
  const ctx: TenantContext = { userId: adminUser!.user_id, orgId: proj.org_id, projectId: proj.id, orgRole: 'owner', projectRole: 'admin' };

  const health = await withTenant(ctx, (tx) => assessWorkspaceHealth(tx, ctx));
  console.log('OVERALL:', health.overall, '(healthy?', health.overall === 'healthy', ')');
  console.log('DIMENSIONS:', JSON.stringify(health.dimensions));
  console.log('EXECUTION FACTS:', JSON.stringify({ runsCompleted: health.execution.runsCompleted, runsFailed: health.execution.runsFailed, failedTasks: health.execution.failedTasks, spent: (Number(health.execution.spentMicros) / 1e6).toFixed(4), budgetExhausted: health.execution.budgetExhausted }));

  const o = health.activeObjective;
  console.log('\nACTIVE OBJECTIVE:', o ? o.title : '(none)');
  if (o) {
    console.log('  Contributing tasks (activity):', `${o.contributingTasksCompleted} of ${o.contributingTasksTotal} completed`);
    console.log('  Outcome criteria:', `${o.outcomeCriteriaMet} of ${o.outcomeCriteriaTotal} met`);
    o.criteria.forEach((c) => console.log('  Target:', `${c.met ? c.target : 0} of ${c.target} ${c.unit}`, '| met=', c.met));
    console.log('  Milestones:', `${o.milestonesActive} active, ${o.milestonesCompleted} completed, ${o.milestonesTotal} total`);
    console.log('  Status:', o.status, '| Evidence:', o.evidenceNote);
    console.log('  outcomeLine:', outcomeLine(o));
  }

  console.log('\nFINDINGS:');
  for (const f of health.findings) console.log(`  [${f.severity}] ${f.code} (${f.dimension}) blocks=${f.blocksOperation} — ${f.title}`);
  const stale = ['objective_link_error', 'employee_cost_unreconciled', 'approval_state_conflict', 'objective_missing_owner', 'audit_access_unavailable'];
  console.log('\nSTALE HUB-001/003/004/005/006 findings present?', health.findings.some((f) => stale.includes(f.code)));

  console.log('\nBRIEFING SUMMARY:');
  const s = briefingSummary(health, proj.name);
  console.log('  headline:', s.headline);
  console.log('  outcome :', s.outcome);
  console.log('  activity:', s.activity);
  console.log('  warnings:', JSON.stringify(s.warnings));
  console.log('  evidence:', s.evidenceLimit);

  await admin.end();
}
main().then(() => process.exit(0)).catch((e) => { console.error('ERR', e); process.exit(1); });
