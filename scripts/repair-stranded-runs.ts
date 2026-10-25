import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/db/schema';
import { type DbTx } from '../src/db/client';
import { closeStrandedRun, findStrandedRuns, STRANDED_RUN_MIN_AGE_DAYS, strandedCutoff, strandedReason } from '../src/domain/tasks/stranded-runs';

/**
 * One-time repair for STRANDED runs (see src/domain/tasks/stranded-runs.ts): runs whose finalization was audited as
 * complete but whose row was never closed, so they show "running" forever.
 *
 * DRY RUN by default: lists what would change and changes nothing. Applying needs ALL of:
 *   --apply  --expect=<exact count from the dry run>  REPAIR_ACTOR_USER_ID=<the owner's profile id>
 * and refuses when the live count differs from --expect. Each run is closed in its own transaction with the run row
 * locked and every condition re-checked, so a run that changed after the dry run is skipped, never overwritten.
 * No notifications are sent. Output carries ids, workspace keys and dates only, never task content.
 *
 *   npm run repair:stranded-runs                                  # dry run
 *   npm run repair:stranded-runs -- --apply --expect=14           # apply (with REPAIR_ACTOR_USER_ID set)
 * Optional: --min-age-days=<n> (default 7).
 */

function arg(name: string): string | null {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : '';
}

async function main() {
  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_MIGRATION_URL or DATABASE_URL must be set.');
  const apply = arg('apply') !== null;
  const expectRaw = arg('expect');
  const minAgeDays = arg('min-age-days') ? Number(arg('min-age-days')) : STRANDED_RUN_MIN_AGE_DAYS;
  if (!Number.isFinite(minAgeDays) || minAgeDays < 1) throw new Error('--min-age-days must be a number >= 1.');
  const actorUserId = process.env.REPAIR_ACTOR_USER_ID ?? '';
  if (apply) {
    if (expectRaw === null || !/^\d+$/.test(expectRaw)) throw new Error('--apply needs --expect=<exact count from the dry run>.');
    if (!/^[0-9a-f-]{36}$/i.test(actorUserId)) throw new Error('--apply needs REPAIR_ACTOR_USER_ID set to the owner profile id.');
  }

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const db = drizzle(sql, { schema });
  const tx = <T>(fn: (t: DbTx) => Promise<T>): Promise<T> => db.transaction((t) => fn(t));
  try {
    const now = new Date();
    const cutoff = strandedCutoff(now, minAgeDays);
    const found = await tx((t) => findStrandedRuns(t, cutoff));
    console.log(`${apply ? 'APPLY' : 'DRY RUN'} — stranded runs older than ${minAgeDays} day(s) (before ${cutoff.toISOString()}): ${found.length}`);
    for (const r of found) {
      console.log(`  run ${r.runId}  ${r.projectKey}  started ${r.startedAt.toISOString().slice(0, 10)}  task ${r.taskStatus}${r.taskStatus === 'running' ? ' -> failed' : ' (unchanged)'}`);
    }
    if (found.length > 0) console.log(`  reason recorded: "${strandedReason(found[0]!, now)}"`);
    if (!apply) {
      console.log('Nothing changed. To apply: --apply --expect=' + found.length + ' with REPAIR_ACTOR_USER_ID set.');
      return;
    }
    if (Number(expectRaw) !== found.length) {
      console.error(`REFUSED: found ${found.length}, expected ${expectRaw}. Nothing changed.`);
      process.exitCode = 1;
      return;
    }
    let closed = 0;
    let tasksFailed = 0;
    for (const r of found) {
      const out = await tx((t) => closeStrandedRun(t, r, { now, cutoff, actorUserId }));
      if (out.repaired) {
        closed += 1;
        if (out.taskFailed) tasksFailed += 1;
        console.log(`  closed ${out.runId}${out.taskFailed ? ' (task -> failed)' : ''}`);
      } else {
        console.log(`  skipped ${out.runId}: ${out.skipped}`);
      }
    }
    console.log(`Done: ${closed} run(s) closed, ${tasksFailed} task(s) moved to failed, ${found.length - closed} skipped.`);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
