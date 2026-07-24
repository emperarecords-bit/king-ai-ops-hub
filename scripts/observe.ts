import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();

import postgres from 'postgres';
import { FIXTURE_KEY_SQL_PATTERNS } from '../src/lib/fixtures';

/**
 * Usage harvest (Sprint 10, extended Sprint 11). Read-only. Prints what
 * ACTUALLY happened so friction becomes evidence instead of memory:
 *   - where work is really flowing (and where it isn't)
 *   - what the platform charged, and whether cost tracks outcomes
 *   - the friction signals: failed runs, expired approvals, ignored output
 *   - ADOPTION: when the owner leaves, and which workflows escape the Hub
 *   - TIME SAVED: against stated, owner-calibratable baselines
 *
 * Run weekly during the validation period:  npm run observe
 *
 * EVERY query here excludes fixture workspaces (src/lib/fixtures.ts). A
 * diagnostic you have to mentally filter is one you stop reading, and by
 * week 0 of Sprint 11 this script was reporting 6 pending approvals no human
 * had ever seen.
 *
 * Deliberately NOT a product surface. If a number here proves worth watching
 * every week, that is evidence it belongs in the briefing.
 */
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set.');

const sql = postgres(url, { max: 1, onnotice: () => {} });

/**
 * Fixture-exclusion predicate, applied to every query in this script.
 * Built by composing one parameterized NOT LIKE per reserved prefix — the
 * array form (`not like all (...)`) does not survive nesting inside another
 * sql`` fragment.
 */
const NOT_FIXTURE = FIXTURE_KEY_SQL_PATTERNS.reduce(
  (acc, pattern) => sql`${acc} and p.key not like ${pattern}`,
  sql`true`,
);

const money = (micros: bigint | string | null) =>
  `$${(Number(micros ?? 0) / 1_000_000).toFixed(4)}`;

function section(title: string) {
  console.log(`\n${'─'.repeat(64)}\n${title}\n${'─'.repeat(64)}`);
}

/**
 * Time-saved baselines: MINUTES a competent human would spend doing the same
 * work without the Hub. These are ASSUMPTIONS, not measurements — printed
 * with every result so the number is never mistaken for observed fact.
 * Calibrate them against your own experience; the arithmetic is trivial and
 * the honesty matters more than the total.
 */
const BASELINE_MINUTES = {
  /** Draft a piece of work, then independently check it. */
  reviewedRun: 25,
  /** Same, without a second opinion. */
  unreviewedRun: 15,
  /** A recurring chore you'd otherwise remember to do. */
  standingRun: 20,
  /** Re-explaining project standards to whoever is doing the work. */
  knowledgeInjection: 3,
} as const;

async function main() {
  console.log(
    `\nKING AI OPS HUB — USAGE HARVEST  ${new Date().toISOString().slice(0, 16).replace('T', ' ')}Z`,
  );
  console.log('  (fixture workspaces excluded — real usage only)');

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
    where p.archived = false and ${NOT_FIXTURE}
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
    where p.archived = false and ${NOT_FIXTURE}
    order by spent desc limit 10`;
  if (outcomes.length === 0) {
    console.log('  (no objectives in real workspaces — the platform cannot answer this yet)');
  }
  for (const r of outcomes) {
    console.log(
      `  ${String(r.key).padEnd(14)} ${String(r.title).slice(0, 34).padEnd(36)} ${r.satisfied}/${r.criteria} criteria · ${r.tasks} tasks · ${money(r.spent)}`,
    );
  }

  section('FRICTION SIGNALS');
  const friction = await sql`
    with real_projects as (
      select p.id from projects p where ${NOT_FIXTURE}
    )
    select
      (select count(*) from runs r where r.status = 'failed'
         and r.project_id in (select id from real_projects)) as failed_runs,
      (select count(*) from runs r where r.status = 'failed'
         and r.project_id in (select id from real_projects)
         and r.started_at > now() - interval '7 days') as failed_7d,
      (select count(*) from approvals a where a.status = 'expired'
         and a.project_id in (select id from real_projects)) as expired_approvals,
      (select count(*) from approvals a where a.status = 'pending'
         and a.project_id in (select id from real_projects)) as pending_approvals,
      (select count(*) from tasks t where t.schedule_id is not null
         and t.project_id in (select id from real_projects)
         and t.status = 'awaiting_approval'
         and t.created_at < now() - interval '3 days') as ignored_standing,
      (select count(*) from audit_logs a where a.action = 'model.malformed_output'
         and a.project_id in (select id from real_projects)) as malformed_outputs,
      (select round(avg(extract(epoch from (a.decided_at - a.created_at)) / 3600.0)::numeric, 1)
         from approvals a where a.decided_at is not null
         and a.project_id in (select id from real_projects)) as avg_decision_hours`;
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
    where ${NOT_FIXTURE}
    group by p.key having count(*) filter (where rs.kind = 'review') > 0`;
  if (review.length === 0) console.log('  (no reviews in real workspaces yet)');
  for (const r of review) {
    const rate =
      Number(r.reviews) > 0 ? Math.round((Number(r.interventions) / Number(r.reviews)) * 100) : 0;
    const share =
      Number(r.total_cost) > 0 ? Math.round((Number(r.review_cost) / Number(r.total_cost)) * 100) : 0;
    console.log(
      `  ${String(r.key).padEnd(18)} ${r.reviews} reviews · changed ${rate}% · review is ${share}% of spend (${money(r.review_cost)})`,
    );
  }

  // -------------------------------------------------------------------------
  // ADOPTION (Sprint 11). The executive question: does the Hub become the
  // place the business runs? These queries approach it from the only angle the
  // data allows — what happens INSIDE the Hub tells us where the edges are.
  // -------------------------------------------------------------------------

  section('ADOPTION: SESSIONS — WHEN IS THE HUB OPEN?');
  // A session = consecutive audit events with no gap longer than 30 minutes.
  // Crude, but it is real behavior rather than a self-report.
  const sessions = await sql`
    with acts as (
      select a.created_at, a.action,
             lag(a.created_at) over (order by a.created_at) as prev
      from audit_logs a
      left join projects p on p.id = a.project_id
      where a.project_id is null or ${NOT_FIXTURE}
    ),
    marked as (
      select *, case when prev is null or created_at - prev > interval '30 minutes'
                     then 1 else 0 end as is_new
      from acts
    ),
    numbered as (
      select *, sum(is_new) over (order by created_at) as session_id from marked
    )
    select session_id,
           min(created_at) as started,
           max(created_at) as ended,
           count(*) as actions,
           round(extract(epoch from (max(created_at) - min(created_at))) / 60.0) as minutes,
           (array_agg(action order by created_at desc))[1] as last_action
    from numbered group by session_id order by started desc limit 8`;
  if (sessions.length === 0) console.log('  (no activity in real workspaces)');
  for (const s of sessions) {
    console.log(
      `  ${String(s.started).slice(0, 16)} · ${String(s.minutes).padStart(3)} min · ${String(s.actions).padStart(3)} actions · left after: ${s.last_action}`,
    );
  }
  // The last action of a session is the closest thing we have to "why they
  // left" — a pattern here (always leaving after run.completed, never after
  // approval.decided) is a workflow the Hub is failing to carry to the end.
  const exits = await sql`
    with acts as (
      select a.created_at, a.action,
             lag(a.created_at) over (order by a.created_at) as prev
      from audit_logs a
      left join projects p on p.id = a.project_id
      where a.project_id is null or ${NOT_FIXTURE}
    ),
    marked as (
      select *, case when prev is null or created_at - prev > interval '30 minutes'
                     then 1 else 0 end as is_new from acts
    ),
    numbered as (select *, sum(is_new) over (order by created_at) as session_id from marked),
    lasts as (
      select distinct on (session_id) session_id, action
      from numbered order by session_id, created_at desc
    )
    select action, count(*) as n from lasts group by action order by n desc limit 5`;
  if (exits.length > 0) {
    console.log('\n  most common exit points:');
    for (const e of exits) console.log(`    ${String(e.action).padEnd(28)} ${e.n}`);
  }

  section('ADOPTION: WHICH WORKFLOWS ESCAPE THE HUB?');
  // Each row is a place where a workflow STARTED here and finished somewhere
  // else — or never finished at all. That gap is the product question.
  const escapes = await sql`
    with rp as (select p.id, p.key from projects p where p.archived = false and ${NOT_FIXTURE})
    select
      (select count(*) from objectives o where o.project_id in (select id from rp)
         and o.status = 'draft') as objectives_never_activated,
      (select count(*) from objectives o where o.project_id in (select id from rp)
         and o.status = 'active'
         and not exists (select 1 from tasks t where t.objective_id = o.id)) as active_objectives_no_work,
      (select count(*) from tasks t where t.project_id in (select id from rp)
         and t.status = 'pending') as tasks_created_never_run,
      (select count(*) from tasks t where t.project_id in (select id from rp)
         and t.objective_id is null) as tasks_outside_any_objective,
      (select count(*) from knowledge_items k where k.project_id in (select id from rp)
         and k.status = 'draft') as knowledge_stuck_in_draft,
      (select count(*) from task_schedules s where s.project_id in (select id from rp)
         and not s.enabled) as standing_work_paused`;
  const e = escapes[0]!;
  console.log(`  objectives created but never activated:   ${e.objectives_never_activated}`);
  console.log(`  active objectives with no work attached:  ${e.active_objectives_no_work}   ← planning here, working elsewhere`);
  console.log(`  tasks created but never run:              ${e.tasks_created_never_run}`);
  console.log(`  tasks not attached to any objective:      ${e.tasks_outside_any_objective}   ← work here, planning elsewhere`);
  console.log(`  knowledge stuck in draft:                 ${e.knowledge_stuck_in_draft}`);
  console.log(`  standing work paused:                     ${e.standing_work_paused}`);

  section('TIME SAVED (against stated baselines — assumptions, not measurements)');
  const saved = await sql`
    with rp as (select p.id from projects p where ${NOT_FIXTURE})
    select
      (select count(*) from runs r
         join tasks t on t.id = r.task_id
         where r.status = 'completed' and r.project_id in (select id from rp)
           and r.reviewer_agent_id is not null) as reviewed_runs,
      (select count(*) from runs r
         where r.status = 'completed' and r.project_id in (select id from rp)
           and r.reviewer_agent_id is null) as unreviewed_runs,
      (select count(*) from runs r
         join tasks t on t.id = r.task_id
         where r.status = 'completed' and r.project_id in (select id from rp)
           and t.schedule_id is not null) as standing_runs,
      (select count(*) from run_steps rs
         where rs.project_id in (select id from rp) and rs.kind = 'primary') as primary_steps`;
  const s = saved[0]!;
  const reviewed = Number(s.reviewed_runs);
  const unreviewed = Number(s.unreviewed_runs);
  const standing = Number(s.standing_runs);
  const injections = Number(s.primary_steps);

  const lines: Array<[string, number, number]> = [
    ['reviewed runs', reviewed, BASELINE_MINUTES.reviewedRun],
    ['unreviewed runs', unreviewed, BASELINE_MINUTES.unreviewedRun],
    ['standing-work runs', standing, BASELINE_MINUTES.standingRun],
    ['knowledge injections', injections, BASELINE_MINUTES.knowledgeInjection],
  ];
  let totalMinutes = 0;
  for (const [label, count, baseline] of lines) {
    const minutes = count * baseline;
    totalMinutes += minutes;
    console.log(
      `  ${label.padEnd(22)} ${String(count).padStart(4)} × ${String(baseline).padStart(2)} min = ${String(minutes).padStart(5)} min`,
    );
  }
  console.log(
    `  ${'TOTAL'.padEnd(22)} ${' '.repeat(16)}${String(totalMinutes).padStart(5)} min  (${(totalMinutes / 60).toFixed(1)} h)`,
  );
  console.log(
    `\n  Baselines are ASSUMPTIONS (BASELINE_MINUTES in this script), not observed\n  times. Standing runs are counted twice by design — once as a run, once as\n  a chore you did not have to remember. Calibrate the constants against your\n  own experience before this number is quoted anywhere.`,
  );

  section('WHAT THE OWNER ACTUALLY DOES HERE');
  const behavior = await sql`
    select a.action, count(*) as n, max(a.created_at) as last_seen
    from audit_logs a
    left join projects p on p.id = a.project_id
    where a.project_id is null or ${NOT_FIXTURE}
    group by a.action order by n desc limit 15`;
  if (behavior.length === 0) console.log('  (no recorded activity in real workspaces)');
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
