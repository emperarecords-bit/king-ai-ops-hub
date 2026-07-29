/**
 * HUB-004 read-only detector run against accuratebids-com. Invokes the real domain functions
 * (detectAttributionAnomalies + employeeAttribution + attributionReconciliation). NEVER mutates.
 *   npx tsx --conditions=react-server scripts/hub004-detector.ts
 */
import postgres from 'postgres';
import { withTenant } from '@/db/tenant';
import {
  attributionReconciliation,
  detectAttributionAnomalies,
  employeeAttribution,
  employeeAttributionDrilldown,
} from '@/domain/agents/attribution';
import type { TenantContext } from '@/types/domain';

const usd = (m: bigint): string => '$' + (Number(m) / 1_000_000).toFixed(4);

async function main(): Promise<void> {
  const admin = postgres(process.env.DATABASE_MIGRATION_URL!, { prepare: false });
  const proj = (await admin`select id, org_id from projects where key = 'accuratebids-com'`)[0];
  if (!proj) throw new Error('project not found');
  const adminUser = (await admin`select user_id from project_members where project_id = ${proj.id} and role = 'admin' limit 1`)[0];
  const ctx: TenantContext = { userId: adminUser!.user_id, orgId: proj.org_id, projectId: proj.id, orgRole: 'owner', projectRole: 'admin' };

  const rec = await withTenant(ctx, (tx) => attributionReconciliation(tx, ctx));
  console.log('=== RECONCILIATION (exact integer micros) ===');
  console.log('  total (Governance Usage) =', usd(rec.totalMicros), '(', rec.totalMicros.toString(), 'micros )');
  console.log('  employee execution       =', usd(rec.employeeExecutionMicros), '(', rec.employeeExecutionMicros.toString(), ')');
  console.log('  employee review          =', usd(rec.employeeReviewMicros), '(', rec.employeeReviewMicros.toString(), ')');
  console.log('  workspace overhead       =', usd(rec.workspaceOverheadMicros), '(', rec.workspaceOverheadMicros.toString(), ')');
  console.log('  reconciled               =', rec.reconciles);

  const attr = await withTenant(ctx, (tx) => employeeAttribution(tx, ctx));
  console.log('\n=== PER EMPLOYEE (actual role/department — no auto system/business label) ===');
  for (const a of [...attr.values()].filter((a) => a.performedWork || a.reviewImpact || a.ownedTasks || a.objectivesOwned || a.executionCostMicros || a.reviewCostMicros)) {
    console.log(`  ${a.name} (${a.role}${a.departmentName ? ', ' + a.departmentName : ''}) | performed=${a.performedWork} ownedTasks=${a.ownedTasks} objectivesOwned=${a.objectivesOwned} reviewImpact=${a.reviewImpact} interventions=${a.interventions} rate=${(a.interventionRate * 100).toFixed(0)}% | exec=${usd(a.executionCostMicros)} review=${usd(a.reviewCostMicros)}`);
  }

  // Named cards + drill-down verification (drill-down totals must equal card totals, exact micros).
  console.log('\n=== NAMED CARDS + drill-down reconciliation ===');
  const named = ['tom brown', 'thomas garvey', 'lead engineer', 'principal reviewer'];
  for (const [id, a] of attr) {
    if (!named.includes(a.name.toLowerCase())) continue;
    const d = await withTenant(ctx, (tx) => employeeAttributionDrilldown(tx, ctx, id));
    const execMatch = d.performedExecutionTotal === a.executionCostMicros;
    const revMatch = d.reviewedTotal === a.reviewCostMicros;
    console.log(`  ${a.name}: performed=${a.performedWork} ownedTasks=${a.ownedTasks} objectivesOwned=${a.objectivesOwned} reviewImpact=${a.reviewImpact} interventions=${a.interventions} | exec=${usd(a.executionCostMicros)} review=${usd(a.reviewCostMicros)}`);
    console.log(`     drill-down: performedTasks=${d.performed.length} reviewedTasks=${d.reviewed.length} ownedTasks=${d.ownedTasks.length} ownedObjectives=${d.ownedObjectives.length} | exec-match=${execMatch} review-match=${revMatch}`);
  }

  const report = await withTenant(ctx, (tx) => detectAttributionAnomalies(tx, ctx));
  console.log('\n=== DETECTOR ===  scanned', JSON.stringify(report.scanned));
  const bySev: Record<string, number> = {};
  for (const an of report.anomalies) bySev[an.severity] = (bySev[an.severity] ?? 0) + 1;
  console.log('  by severity:', JSON.stringify(bySev), '| total anomalies:', report.anomalies.length);
  for (const an of report.anomalies) console.log(`  - [${an.severity}] ${an.category} :: ${an.taskTitle ?? an.taskId ?? ''} — ${an.detail}`);

  await admin.end();
}
main().then(() => process.exit(0)).catch((e) => { console.error('ERR', e); process.exit(1); });
