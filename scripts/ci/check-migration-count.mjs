/* eslint-disable no-console -- CI orchestration script: progress + diagnostics go to stdout/stderr by design. */
// CI-only, branch-agnostic: assert the number of APPLIED migrations equals the CHECKED-OUT branch's committed
// journal length (main=54 entries/…0053, PR#2=55/…0054, P1a–c=56/…0055, P1d=57/…0056). Never hardcodes a count.
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const url = process.env.DATABASE_MIGRATION_URL;
if (!url) {
  console.error('[migration-count] DATABASE_MIGRATION_URL is unset.');
  process.exit(1);
}
const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'));
const expected = journal.entries.length;
const lastTag = journal.entries[journal.entries.length - 1]?.tag ?? '(none)';

const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  const rows = await sql`select count(*)::int as n from drizzle.__drizzle_migrations`;
  const actual = rows[0].n;
  console.log(`[migration-count] committed journal entries=${expected} (last=${lastTag}); applied in DB=${actual}`);
  if (actual !== expected) {
    console.error(`[migration-count] MISMATCH — applied ${actual} != committed journal ${expected}.`);
    process.exit(1);
  }
  console.log('[migration-count] OK — branch-aware count matches the committed journal (no hardcoded 57).');
} finally {
  await sql.end();
}
