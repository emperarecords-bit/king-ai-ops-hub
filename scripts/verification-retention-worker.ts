/**
 * VER-002 PR-7 — the out-of-band retention worker (docs/verification/external-runner-design.md §3.2).
 *
 * Reads open purge jobs for ONE tenant and deletes each listed object, marking it confirmed and retrying
 * transient failures. It is safe to run repeatedly and safe to kill at any point: the object list was
 * committed before the evidence references were removed, so a crash resumes from the recorded list and no
 * object is orphaned or silently skipped.
 *
 * WHY IT IS PER-TENANT, and why that is not laziness. The retention role is NOBYPASSRLS, so a query
 * issued without the tenant GUCs set returns a FALSE EMPTY instead of an error — a cross-tenant sweep
 * would look like a clean "nothing to do" while quietly draining nothing. Enumerating tenants is the
 * caller's job (a scheduler, or an operator running this per project); this script refuses to guess.
 *
 *   npx tsx scripts/verification-retention-worker.ts --org <uuid> --project <uuid> [--actor <uuid>] [--limit 10]
 *
 * Runs as `verification_retention_agent` via withRetentionTenant. It performs NO provisioning, starts no
 * server, and opens no purge of its own — opening a purge is an authorized action that happens elsewhere.
 */
import './load-env';
import { withRetentionTenant } from '@/db/tenant';
import { createDrizzlePurgeJobStore } from '@/domain/verification/drizzle-store';
import { drainOpenPurgeJobs } from '@/domain/verification/retention';
import { defaultRetentionObjectDeleter, retentionAuditSink } from '@/domain/verification/runtime-adapters';
import type { TenantContext } from '@/types/domain';

/** Matches SYSTEM_ACTOR_ID in src/domain/audit/audit.ts, which is module-private there. A background
 *  purge has no human actor, and writeAudit maps this id to a NULL actor_id rather than inventing one. */
const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main(): Promise<void> {
  const orgId = arg('org') ?? process.env.RETENTION_ORG_ID;
  const projectId = arg('project') ?? process.env.RETENTION_PROJECT_ID;
  const actorId = arg('actor') ?? process.env.RETENTION_ACTOR_ID ?? SYSTEM_ACTOR_ID;
  const limit = Number(arg('limit') ?? process.env.RETENTION_JOB_LIMIT ?? '10');

  if (!orgId || !UUID.test(orgId) || !projectId || !UUID.test(projectId)) {
    console.error('usage: tsx scripts/verification-retention-worker.ts --org <uuid> --project <uuid> [--actor <uuid>] [--limit 10]');
    console.error('both --org and --project are REQUIRED: the retention role is NOBYPASSRLS, so an unscoped run would silently drain nothing.');
    process.exit(2);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    console.error(`--limit must be an integer in [1, 100] (got ${String(limit)})`);
    process.exit(2);
  }

  const deleter = await defaultRetentionObjectDeleter();
  // Roles are the DB tenant stamp, not an authorization decision: authorization here IS the role the
  // connection runs as. 'viewer'/'member' is the least-privileged pair that satisfies the context type.
  const ctx: TenantContext = { userId: actorId, orgId, projectId, orgRole: 'member', projectRole: 'viewer' };

  const results = await withRetentionTenant(ctx, async (tx) =>
    drainOpenPurgeJobs(
      { store: createDrizzlePurgeJobStore(tx), deleter, audit: retentionAuditSink(tx, ctx) },
      limit,
    ),
  );

  if (results.length === 0) {
    console.log('no open purge jobs for this tenant');
    return;
  }
  let deleted = 0;
  let failed = 0;
  for (const r of results) {
    deleted += r.deleted;
    failed += r.failed;
    console.log(`job ${r.jobId}: deleted=${r.deleted} failed=${r.failed} complete=${r.complete}`);
  }
  console.log(`drained ${results.length} job(s): ${deleted} object(s) confirmed gone, ${failed} left pending for the next run`);
  // A failure is a retry, not an error exit — the next run picks the object up. Exiting non-zero here
  // would make a transient provider blip look like a broken worker to a scheduler.
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
