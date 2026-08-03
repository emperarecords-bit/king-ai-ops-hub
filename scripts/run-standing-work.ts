import { config as loadEnv } from 'dotenv';
// Provider keys and DATABASE_URL live in .env.local.
loadEnv({ path: '.env.local' });
loadEnv();

import { runDueSchedules } from '../src/domain/standing/standing';

/**
 * The standing-work tick (Sprint 8, Continuous Operations). Registered with
 * Windows Task Scheduler (scripts/register-standing-work-task.ps1) to run
 * hourly. Deliberately dumb: find due schedules, run each once through the
 * ordinary gated path, report, exit. All intelligence — budgets, review,
 * approvals, audit — lives in the platform, not the tick.
 */
async function main() {
  const started = Date.now();
  const result = await runDueSchedules();
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `standing-work tick: ${result.due} due, ${result.enqueued} enqueued, ${result.suppressed} suppressed, ${result.assignmentRequired} assignment-required, ${result.failures.length} failures in ${seconds}s`,
  );
  for (const f of result.failures) {
    console.warn(`  schedule ${f.scheduleId}: ${f.reason}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('standing-work tick crashed:', err);
  process.exit(1);
});
