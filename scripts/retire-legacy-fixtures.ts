import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();

import postgres from 'postgres';
import { isFixtureKey } from '../src/lib/fixtures';

/**
 * One-off cleanup (Sprint 11, O-3): fixture workspaces created BEFORE the
 * reserved-prefix convention still pollute operational reads. This renames
 * them into the convention so the harvest excludes them structurally.
 *
 * Renaming, not deleting: audit rows, runs, and usage events reference these
 * projects, and the audit trail is append-only by design (I6). The key is
 * presentation; the history stays intact.
 *
 * Idempotent — safe to re-run. Anything already matching the convention, or
 * on the real-workspace allowlist, is left untouched.
 */

/**
 * Workspaces that are REAL as of 2026-07-24. Anything else matching a known
 * legacy fixture prefix gets retired. The allowlist is explicit so a new real
 * workspace can never be swept up by a prefix rule.
 */
const REAL_WORKSPACE_KEYS = new Set([
  'accuratebids',
  'kodiscan',
  'bushandbelly',
  'stresspro',
  'partshunt-pro',
  'king-ai-ops-hub',
  'kingdom-core',
]);

/** Prefixes used by tests before the convention existed. */
const LEGACY_PREFIXES = [
  'insight-',
  'know-',
  'obj-test-',
  'prov-',
  'stand-',
  'relink-',
  'my-first-venture',
];

const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set.');
const sql = postgres(url, { max: 1, onnotice: () => {} });

async function main() {
  const rows = await sql<{ id: string; key: string }[]>`select id, key from projects`;

  const toRetire = rows.filter(
    (r) =>
      !REAL_WORKSPACE_KEYS.has(r.key) &&
      !isFixtureKey(r.key) &&
      LEGACY_PREFIXES.some((p) => r.key.startsWith(p)),
  );

  if (toRetire.length === 0) {
    console.log('Nothing to retire — all fixture workspaces already follow the convention.');
    await sql.end();
    return;
  }

  console.log(`Retiring ${toRetire.length} legacy fixture workspace(s):`);
  for (const r of toRetire) {
    // Truncate: the key column is unbounded text, but keeping it readable
    // matters more than preserving every character of a dead fixture name.
    const next = `zz-fixture-legacy-${r.key}`.slice(0, 100);
    await sql`update projects set key = ${next}, archived = true where id = ${r.id}`;
    console.log(`  ${r.key.padEnd(28)} → ${next}`);
  }

  const unswept = rows.filter(
    (r) => !REAL_WORKSPACE_KEYS.has(r.key) && !isFixtureKey(r.key) && !toRetire.includes(r),
  );
  if (unswept.length > 0) {
    console.log(
      `\nNot retired (no known legacy prefix — check these are real):\n${unswept
        .map((r) => `  ${r.key}`)
        .join('\n')}`,
    );
  }

  console.log('\nDone. Re-run `npm run observe` to confirm the harvest is clean.');
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
