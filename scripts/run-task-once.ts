import 'dotenv/config';
import { and, desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/db/schema';
import { agents, documentChunks, documentVersions, documents, projectMembers, projects, runDocumentVersions, runs } from '../src/db/schema';
import { type DbTx } from '../src/db/client';
import type { RunSourceSnapshot, TenantContext } from '../src/types/domain';
import { getRetrievalMode } from '../src/domain/documents/retrieval-mode';
import { createTask } from '../src/domain/tasks/tasks';
import { startRun } from '../src/domain/tasks/runner';

/**
 * Documents increment 1, Stage C2 closure (Blocker 2) — a genuine provider-backed run through the REAL
 * mode-aware runner. Creates a task in the target workspace and executes it end-to-end (real provider
 * dispatch), then inspects the immutable snapshot + normalized version references.
 *
 *   RETRIEVAL_MODE_PROJECT=<id|key> [FORCE_FAIL=1] npm run run:task-once
 *
 * FORCE_FAIL temporarily points the primary agent at a bogus model so provider dispatch fails, proving the
 * run + evidence stay durable and the run is marked failed (never implying success). The model is restored
 * in a finally block.
 */

async function main() {
  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_MIGRATION_URL or DATABASE_URL must be set.');
  const target = process.env.RETRIEVAL_MODE_PROJECT;
  if (!target) throw new Error('RETRIEVAL_MODE_PROJECT=<id|key> required.');
  const forceFail = process.env.FORCE_FAIL === '1';
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const db = drizzle(sql, { schema });
  const tx = <T>(fn: (t: DbTx) => Promise<T>): Promise<T> => db.transaction((t) => fn(t));

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target);
  const project = isUuid ? (await db.select().from(projects).where(eq(projects.id, target)).limit(1))[0] : (await db.select().from(projects).where(eq(projects.key, target)).limit(1))[0];
  if (!project) throw new Error(`Project '${target}' not found.`);
  const member = (await db.select({ userId: projectMembers.userId }).from(projectMembers).where(eq(projectMembers.projectId, project.id)).limit(1))[0];
  const ctx: TenantContext = { userId: member!.userId, orgId: project.orgId, projectId: project.id, orgRole: 'owner', projectRole: 'admin' };

  const mode = await tx((t) => getRetrievalMode(t, ctx));
  const primary = (await db.select({ id: agents.id, provider: agents.provider, model: agents.model }).from(agents).where(and(eq(agents.projectId, ctx.projectId), eq(agents.role, 'primary'), eq(agents.enabled, true))).limit(1))[0];
  if (!primary) throw new Error('No enabled primary agent in this workspace.');

  // Derive a query from a real retrievable doc so the versioned path supplies version-bound evidence.
  const c = (await db
    .select({ content: documentChunks.content })
    .from(documentChunks)
    .innerJoin(documents, eq(documentChunks.documentId, documents.id))
    .innerJoin(documentVersions, eq(documents.currentVersionId, documentVersions.id))
    .where(and(eq(documents.orgId, ctx.orgId), eq(documents.projectId, ctx.projectId), eq(documents.status, 'active'), eq(documentVersions.indexStatus, 'indexed'), eq(documentChunks.documentVersionId, documents.currentVersionId), eq(documentChunks.chunkIndex, 0)))
    .limit(1))[0];
  const query = (c?.content ?? 'summarize the current project status').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 4).slice(0, 5).join(' ') || 'status';

  const originalModel = primary.model;
  try {
    if (forceFail) await db.update(agents).set({ model: 'nonexistent-model-zzz-c2-verify' }).where(eq(agents.id, primary.id));

    const taskId = await tx((t) => createTask(t, ctx, { title: `[c2-verify] ${forceFail ? 'failure' : 'success'} run`, input: query, providerSelection: primary.provider as never, reviewEnabled: false }));
    let runError: string | null = null;
    try {
      await startRun(ctx, taskId);
    } catch (err) {
      runError = err instanceof Error ? err.message : String(err);
    }

    // Inspect the resulting run.
    const run = (await db.select({ id: runs.id, status: runs.status, retrievedSources: runs.retrievedSources }).from(runs).where(eq(runs.taskId, taskId)).orderBy(desc(runs.createdAt)).limit(1))[0];
    const snap = (run?.retrievedSources as RunSourceSnapshot[] | null) ?? [];
    const refs = run ? await db.select({ chunkIndex: runDocumentVersions.chunkIndex, versionId: runDocumentVersions.documentVersionId }).from(runDocumentVersions).where(eq(runDocumentVersions.runId, run.id)) : [];

    console.log(JSON.stringify({
      mode,
      forceFail,
      query,
      taskId,
      runId: run?.id ?? null,
      runStatus: run?.status ?? null,
      runError,
      snapshotSources: snap.length,
      snapshotWithVersionId: snap.filter((s) => s.documentVersionId).length,
      normalizedRefRows: refs.length,
      versionLevelRefs: refs.filter((r) => r.chunkIndex === -1).length,
      chunkLevelRefs: refs.filter((r) => r.chunkIndex >= 0).length,
      distinctVersionsReferenced: new Set(refs.map((r) => r.versionId)).size,
    }, null, 2));
  } finally {
    if (forceFail) await db.update(agents).set({ model: originalModel }).where(eq(agents.id, primary.id));
  }

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
