import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();

import postgres from 'postgres';

/**
 * Usage harvest (Sprint 10). Read-only. Prints what ACTUALLY happened across
 * the platform so friction becomes evidence instead of memory:
 *   - where work is really flowing (and where it isn't)
 *   - what the platform charged, and whether cost tracks outcomes
 *   - which insights would fire right now
 *   - the friction signals: failed runs, expired approvals, ignored output
 *
 * Run weekly during the validation period:  npm run observe
 *
 * This is a diagnostic script, deliberately NOT a product surface. If a
 * number here proves worth watching every week, that is evidence it belongs
 * in the briefing — which is exactly the input Sprint 11 should be designed
 * from.
 */
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set.');

const sql = postgres(url, { max: 1, onnotice: () => {} });

const money = (micros: bigint | string | null) =>
  `$${(Number(micros ?? 0) / 1_000_000).toFixed(4)}`;

function section(title: string) {
  console.log(`\n${'─'.repeat(64)}\n${title}\n${'─'.repeat(64)}`);
}

async function main() {
  console.log(`\nKING AI OPS HUB — USAGE HARVEST  ${new Date().toISOString().slice(0, 16).replace('T', ' ')}Z`);

  section('WHERE WORK IS ACTUALLY FLOWING');
  // Correlated subqueries, NOT joins: fanning five one-to-many joins into one
  // GROUP BY multiplies rows, and sum(cost_micros) is not distinct-safe — the
  // first run of this script reported $28.75 in a workspace that had spent
  // $0.17. Counts survived (count distinct); the money did not.
  const flow = await sql`
    select p.key,
      (select count(*) from tasks t where t.project_id = p.id
         and t.created_at > now() - interval '7 days') as tasks_7d,
      (select count(*) from tasks t where t.project_id = p.id) as tasks_total,
      (select count(*) from objectives o where o.project_id = p.id
         and o.status = 'active') as active_objectives,
      (select count(*) from knowledge_items k where k.project_id = p.id
         and k.status = 'active') as knowledge_items,
      (select count(*) from task_schedules s where s.project_id = p.id
         and s.enabled) as standing_work,
      (select coalesce(sum(u.cost_micros), 0) from usage_events u
         where u.project_id = p.id) as spent
    from projects p
    where p.archived = false
    order by tasks_total desc, p.key`;
  for (const r of flow) {
    console.log(
      `  ${String(r.key).padEnd(18)} tasks ${String(r.tasks_total).padStart(3)} (${r.tasks_7d} this week) · objectives ${r.active_objectives} · knowledge ${r.knowledge_items} · standing ${r.standing_work} · ${money(r.spent)}`,
    );
  }

  section('DOES COST TRACK OUTCOMES?');
  const outcomes = await sql`
    select p.key, o.title, o.status,
           jsonb_array_length(o.success_criteria) as criteria,
           (select count(*) from jsonb_array_elements(o.success_criteria) c
             where c->>'status' <> 'unmet') as satisfied,
           (select count(*) from tasks t where t.objective_id = o.id) as tasks,
           coalesce((select sum(u.cost_micros) from usage_events u
             join tasks t on t.id = u.task_id where t.objective_id = o.id), 0) as spent
    from objectives o join projects p on p.id = o.project_id
    where p.archived = false order by spent desc limit 10`;
  if (outcomes.length === 0) console.log('  (no objectives yet — the platform cannot answer this question)');
  for (const r of outcomes) {
    console.log(
      `  ${String(r.key).padEnd(14)} ${String(r.title).slice(0, 34).padEnd(36)} ${r.satisfied}/${r.criteria} criteria · ${r.tasks} tasks · ${money(r.spent)}`,
    );
  }

  section('FRICTION SIGNALS');
  const friction = await sql`
    select
      (select count(*) from runs where status = 'failed') as failed_runs,
      (select count(*) from runs where status = 'failed' and started_at > now() - interval '7 days') as failed_7d,
      (select count(*) from approvals where status = 'expired') as expired_approvals,
      (select count(*) from approvals where status = 'pending') as pending_approvals,
      (select count(*) from tasks t where t.schedule_id is not null
         and t.status = 'awaiting_approval' and t.created_at < now() - interval '3 days') as ignored_standing,
      (select count(*) from audit_logs where action = 'model.malformed_output') as malformed_outputs,
      (select round(avg(extract(epoch from (decided_at - created_at)) / 3600.0)::numeric, 1)
         from approvals where decided_at is not null) as avg_decision_hours`;
  const f = friction[0]!;
  console.log(`  failed runs:            ${f.failed_runs} (${f.failed_7d} this week)`);
  console.log(`  approvals expired:      ${f.expired_approvals}   pending now: ${f.pending_approvals}`);
  console.log(`  standing output ignored >3d: ${f.ignored_standing}`);
  console.log(`  malformed model output: ${f.malformed_outputs}`);
  console.log(`  avg decision latency:   ${f.avg_decision_hours ?? 'n/a'} h`);

  section('QUALITY: IS THE CROSS-CHECK EARNING ITS KEEP?');
  const review = await sql`
    select p.key,
           count(*) filter (where rs.kind = 'review' and rs.succeeded) as reviews,
           count(*) filter (where rs.kind = 'review' and rs.succeeded
             and rs.verdict in ('revise','reject')) as interventions,
           coalesce(sum(u.cost_micros) filter (where rs.kind = 'review'), 0) as review_cost,
           coalesce(sum(u.cost_micros), 0) as total_cost
    from run_steps rs
    join projects p on p.id = rs.project_id
    left join usage_events u on u.run_step_id = rs.id
    group by p.key having count(*) filter (where rs.kind = 'review') > 0`;
  if (review.length === 0) console.log('  (no reviews recorded yet)');
  for (const r of review) {
    const rate = Number(r.reviews) > 0 ? Math.round((Number(r.interventions) / Number(r.reviews)) * 100) : 0;
    const share = Number(r.total_cost) > 0 ? Math.round((Number(r.review_cost) / Number(r.total_cost)) * 100) : 0;
    console.log(
      `  ${String(r.key).padEnd(18)} ${r.reviews} reviews · changed ${rate}% · review is ${share}% of spend (${money(r.review_cost)})`,
    );
  }

  section('WHAT THE OWNER ACTUALLY DOES HERE');
  const behavior = await sql`
    select action, count(*) as n, max(created_at) as last_seen
    from audit_logs group by action order by n desc limit 15`;
  for (const r of behavior) {
    console.log(
      `  ${String(r.action).padEnd(30)} ${String(r.n).padStart(4)}   last ${String(r.last_seen).slice(0, 16)}`,
    );
  }

  console.log('\nHarvest complete. Record surprises in OBSERVATIONS.md.\n');
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
