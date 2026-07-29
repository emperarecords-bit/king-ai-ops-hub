// HUB-009 Gate 3C — read-only staging schema verification.
// Tables live in schema `public`; the trigger functions live in schema `app`.
import postgres from 'postgres';

const url = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL;
const sql = postgres(url, { max: 1, prepare: false });

const out = {};
try {
  out.enum = await sql`
    select e.enumlabel as label, e.enumsortorder as ord
    from pg_type t join pg_enum e on e.enumtypid = t.oid
    where t.typname = 'data_classification'
    order by e.enumsortorder`;

  out.columns = await sql`
    select table_name, is_nullable, column_default, udt_name
    from information_schema.columns
    where column_name = 'classification'
      and table_schema = 'public'
      and table_name in ('projects','tasks','objectives','work_items','agents','decisions','runs','usage_events')
    order by table_name`;

  out.functions = await sql`
    select p.proname, n.nspname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where p.proname in ('enforce_run_classification','enforce_usage_classification')
    order by p.proname`;

  out.triggers = await sql`
    select t.tgname, c.relname as tbl, t.tgenabled as enabled,
           (t.tgtype & 2) > 0 as is_before,
           (t.tgtype & 4) > 0 as on_insert,
           (t.tgtype & 16) > 0 as on_update
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where not t.tgisinternal and n.nspname = 'public'
      and c.relname in ('runs','usage_events')
      and t.tgname like '%classification%'
    order by c.relname, t.tgname`;

  out.nullRuns = (await sql`select count(*)::int as n from public.runs where classification is null`)[0].n;
  out.totalRuns = (await sql`select count(*)::int as n from public.runs`)[0].n;
  out.nullUsage = (await sql`select count(*)::int as n from public.usage_events where classification is null`)[0].n;
  out.totalUsage = (await sql`select count(*)::int as n from public.usage_events`)[0].n;

  out.storedTableNulls = await sql`
    select 'projects' as t, count(*) filter (where classification is null)::int as nulls, count(*)::int as total from public.projects
    union all select 'tasks', count(*) filter (where classification is null)::int, count(*)::int from public.tasks
    union all select 'objectives', count(*) filter (where classification is null)::int, count(*)::int from public.objectives
    union all select 'work_items', count(*) filter (where classification is null)::int, count(*)::int from public.work_items
    union all select 'agents', count(*) filter (where classification is null)::int, count(*)::int from public.agents
    union all select 'decisions', count(*) filter (where classification is null)::int, count(*)::int from public.decisions`;

  out.migrationsApplied = (await sql`select count(*)::int as n from drizzle.__drizzle_migrations`)[0].n;
  out.lastMigrations = await sql`select hash, created_at from drizzle.__drizzle_migrations order by created_at desc limit 4`;

  console.log(JSON.stringify(out, null, 2));
} catch (e) {
  console.log(JSON.stringify({ ERROR: String((e && e.message) || e) }));
  process.exitCode = 1;
} finally {
  await sql.end();
}
