import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL, { max: 1, prepare: false });
try {
  const t = await sql`select table_schema, table_name from information_schema.tables
    where table_name in ('runs','usage_events','projects') order by table_name, table_schema`;
  const s = await sql`select nspname from pg_namespace where nspname not like 'pg_%' and nspname <> 'information_schema' order by 1`;
  console.log(JSON.stringify({ schemas: s.map(r=>r.nspname), tableHomes: t }, null, 2));
} catch(e){ console.log(JSON.stringify({ERROR:String(e.message||e)})); process.exitCode=1; }
finally { await sql.end(); }
