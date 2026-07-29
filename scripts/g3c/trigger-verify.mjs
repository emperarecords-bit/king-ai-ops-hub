// HUB-009 Gate 3C — DB trigger enforcement verification on staging.
// Every case runs inside ONE transaction that is ROLLED BACK at the end:
// nothing here persists. Expected-failure cases use savepoints so an aborted
// statement does not poison the surrounding transaction.
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';

const url = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL;
const sql = postgres(url, { max: 1, prepare: false });

const results = [];
function record(name, expected, outcome, detail) {
  results.push({ name, expected, outcome, pass: expected === outcome, detail: detail || null });
}

try {
  await sql.begin(async (tx) => {
    // Template rows: an existing run (all 15 are legacy-NULL) and a usage event.
    const [runTpl] = await tx`select * from public.runs order by created_at limit 1`;
    const [useTpl] = await tx`select * from public.usage_events order by created_at limit 1`;
    if (!runTpl || !useTpl) throw new Error('no template rows available');

    async function attempt(name, expected, fn) {
      try {
        await tx.savepoint(async (sp) => { await fn(sp); });
        record(name, expected, 'ALLOWED');
      } catch (e) {
        record(name, expected, 'REJECTED', String((e && e.message) || e).slice(0, 140));
      }
    }

    // 1. INSERT run with NULL classification -> REJECTED (non-null on insert)
    await attempt('insert run classification=NULL', 'REJECTED', async (sp) => {
      const r = { ...runTpl, id: randomUUID(), classification: null };
      await sp`insert into public.runs ${sp(r)}`;
    });

    // 2. INSERT run with 'live' -> ALLOWED
    await attempt("insert run classification='live'", 'ALLOWED', async (sp) => {
      const r = { ...runTpl, id: randomUUID(), classification: 'live' };
      await sp`insert into public.runs ${sp(r)}`;
    });

    // 3. INSERT run with 'demo' -> ALLOWED
    await attempt("insert run classification='demo'", 'ALLOWED', async (sp) => {
      const r = { ...runTpl, id: randomUUID(), classification: 'demo' };
      await sp`insert into public.runs ${sp(r)}`;
    });

    // 4. INSERT 'live' then UPDATE -> 'demo' : the UPDATE is REJECTED (full immutability)
    await attempt("update run 'live'->'demo'", 'REJECTED', async (sp) => {
      const id = randomUUID();
      await sp`insert into public.runs ${sp({ ...runTpl, id, classification: 'live' })}`;
      await sp`update public.runs set classification = 'demo' where id = ${id}`;
    });

    // 5. UPDATE a legacy-NULL run: NULL -> 'live' : REJECTED (null can never be back-filled)
    await attempt('update legacy run NULL->live (backfill)', 'REJECTED', async (sp) => {
      await sp`update public.runs set classification = 'live' where id = ${runTpl.id}`;
    });

    // 6. UPDATE a legacy-NULL run's OTHER column, classification untouched -> ALLOWED
    await attempt('update legacy run other column (class stays NULL)', 'ALLOWED', async (sp) => {
      await sp`update public.runs set status = status where id = ${runTpl.id}`;
    });

    // 7. INSERT usage_event with NULL classification -> REJECTED (parallel guard)
    await attempt('insert usage classification=NULL', 'REJECTED', async (sp) => {
      const u = { ...useTpl, id: randomUUID(), classification: null };
      await sp`insert into public.usage_events ${sp(u)}`;
    });

    // Force rollback of the whole transaction — nothing above persists.
    throw new Error('__ROLLBACK__');
  });
} catch (e) {
  if (String((e && e.message) || e) !== '__ROLLBACK__') {
    console.log(JSON.stringify({ FATAL: String((e && e.message) || e), results }, null, 2));
    await sql.end();
    process.exit(1);
  }
}

// Confirm the rollback left no trace (counts unchanged from the read-only baseline).
const runCount = (await sql`select count(*)::int as n from public.runs`)[0].n;
const useCount = (await sql`select count(*)::int as n from public.usage_events`)[0].n;
const allPass = results.every((r) => r.pass);
console.log(JSON.stringify({ allPass, results, postRollback: { runs: runCount, usage_events: useCount } }, null, 2));
if (!allPass) process.exitCode = 1;
await sql.end();
