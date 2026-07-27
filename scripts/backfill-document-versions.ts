import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/db/schema';
import { aiOperations, projectMembers, projects } from '../src/db/schema';
import { type DbTx } from '../src/db/client';
import type { TenantContext } from '../src/types/domain';
import { getObjectStore } from '../src/domain/documents/object-store';
import { aggregateReports, backfillProject, type ProjectBackfillReport } from '../src/domain/documents/backfill';

/**
 * Documents increment 1, Stage C1 — restart-safe backfill runner.
 *
 * Populates the immutable version model for every workspace WITHOUT switching retrieval, deleting legacy
 * columns, purging orphans, or building UI. Restart-safe: a stable per-project operation identity
 * (ai_operations idempotency key) means a rerun after any interruption reuses the same operation and
 * reconciles rather than duplicating. Each project's reconciliation report is persisted to its operation
 * row (result_data); the aggregate is emitted to stdout.
 *
 * Uses its OWN migration-role connection (like scripts/seed.ts) — never the app_server path — and passes
 * that transaction straight to the tenant-scoped domain function.
 *
 *   BACKFILL_OP_KEY=c1 npm run backfill:document-versions       (default op key: 'c1')
 *   BACKFILL_ONLY_PROJECT=<projectId>  restricts to one project (optional).
 */

const OP_TYPE = 'documents.backfill.c1';

async function main() {
  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_MIGRATION_URL or DATABASE_URL must be set.');
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const db = drizzle(sql, { schema });
  const tx = <T>(fn: (t: DbTx) => Promise<T>): Promise<T> => db.transaction((t) => fn(t));

  const opKey = process.env.BACKFILL_OP_KEY ?? 'c1';
  const onlyProject = process.env.BACKFILL_ONLY_PROJECT ?? null;
  const store = await getObjectStore();

  const allProjects = await db.select({ id: projects.id, orgId: projects.orgId, key: projects.key }).from(projects);
  const targets = onlyProject ? allProjects.filter((p) => p.id === onlyProject) : allProjects;
  if (targets.length === 0) {
    console.error(onlyProject ? `Project ${onlyProject} not found.` : 'No projects found.');
    await sql.end();
    process.exit(1);
  }

  const reports: ProjectBackfillReport[] = [];
  for (const p of targets) {
    // A project member gives the operation a plausible actor context; scoping is by (org, project).
    const member = (await db.select({ userId: projectMembers.userId }).from(projectMembers).where(eq(projectMembers.projectId, p.id)).limit(1))[0];
    const ctx: TenantContext = { userId: member?.userId ?? '00000000-0000-0000-0000-000000000000', orgId: p.orgId, projectId: p.id, orgRole: 'owner', projectRole: 'admin' };

    // Stable operation identity (idempotency key is unique per project+type). Reuse across reruns.
    const existing = (
      await db.select({ id: aiOperations.id }).from(aiOperations).where(and(eq(aiOperations.projectId, p.id), eq(aiOperations.operationType, OP_TYPE), eq(aiOperations.idempotencyKey, opKey))).limit(1)
    )[0];
    let operationId: string;
    if (existing) {
      operationId = existing.id;
    } else {
      const ins = await db
        .insert(aiOperations)
        .values({ orgId: p.orgId, projectId: p.id, operationType: OP_TYPE, idempotencyKey: opKey, status: 'dispatched', dispatchedAt: new Date() })
        .onConflictDoNothing()
        .returning({ id: aiOperations.id });
      operationId = ins[0]?.id ?? (await db.select({ id: aiOperations.id }).from(aiOperations).where(and(eq(aiOperations.projectId, p.id), eq(aiOperations.operationType, OP_TYPE), eq(aiOperations.idempotencyKey, opKey))).limit(1))[0]!.id;
    }

    let report: ProjectBackfillReport;
    try {
      report = await tx((t) => backfillProject(t, ctx, store, { operationId }));
    } catch (err) {
      await db.update(aiOperations).set({ status: 'failed', failedAt: new Date(), error: err instanceof Error ? err.message.slice(0, 2000) : String(err) }).where(eq(aiOperations.id, operationId));
      console.error(`[backfill] project ${p.key} (${p.id}) FAILED: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    await db.update(aiOperations).set({ status: 'completed', completedAt: new Date(), resultData: report as unknown as Record<string, unknown> }).where(eq(aiOperations.id, operationId));
    reports.push(report);
    console.log(`[backfill] ${p.key}: created=${report.versions.created} reused=${report.versions.reused} current+=${report.versions.currentAssigned} withheld=${report.versions.currentWithheld} gate(without=${report.gate.withoutValidCurrent}/${report.gate.activeIndexed})`);
  }

  const agg = aggregateReports(reports);
  console.log('\n=== Stage C1 backfill aggregate ===');
  console.log(JSON.stringify(agg, null, 2));

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
