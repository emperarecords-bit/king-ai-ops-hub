import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/db/schema';
import { agents, documentChunks, documentVersions, documents, projectMembers, projects, runDocumentVersions, runs, tasks } from '../src/db/schema';
import { type DbTx } from '../src/db/client';
import type { RunSourceSnapshot, TenantContext } from '../src/types/domain';
import { assembleDocumentSources, getRetrievalMode } from '../src/domain/documents/retrieval-mode';
import { writeRunVersionEvidence } from '../src/domain/documents/references';

/**
 * Documents increment 1, Stage C2 — staging evidence-write verification. For a VERSIONED workspace, runs
 * the real versioned retrieval on real data, builds the run snapshot, writes normalized run→version
 * evidence for a SYNTHETIC run, inspects the persisted snapshot + references, then deletes the synthetic
 * run (cascade) so staging is left clean. Proves the C2 retrieval + evidence path end-to-end on real data;
 * the provider dispatch (unchanged by C2) is not invoked.
 *
 *   RETRIEVAL_MODE_PROJECT=<id|key> [SAMPLE_QUERY="..."] npm run verify:versioned-evidence
 */

async function main() {
  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_MIGRATION_URL or DATABASE_URL must be set.');
  const target = process.env.RETRIEVAL_MODE_PROJECT;
  if (!target) throw new Error('RETRIEVAL_MODE_PROJECT=<id|key> required.');
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const db = drizzle(sql, { schema });
  const tx = <T>(fn: (t: DbTx) => Promise<T>): Promise<T> => db.transaction((t) => fn(t));

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target);
  const project = isUuid
    ? (await db.select().from(projects).where(eq(projects.id, target)).limit(1))[0]
    : (await db.select().from(projects).where(eq(projects.key, target)).limit(1))[0];
  if (!project) throw new Error(`Project '${target}' not found.`);
  const member = (await db.select({ userId: projectMembers.userId }).from(projectMembers).where(eq(projectMembers.projectId, project.id)).limit(1))[0];
  const ctx: TenantContext = { userId: member?.userId ?? '00000000-0000-0000-0000-000000000000', orgId: project.orgId, projectId: project.id, orgRole: 'owner', projectRole: 'admin' };

  const mode = await tx((t) => getRetrievalMode(t, ctx));
  // Derive a query from a real retrievable doc if none supplied.
  let query = process.env.SAMPLE_QUERY ?? '';
  if (!query) {
    const rows = await db
      .select({ content: documentChunks.content })
      .from(documentChunks)
      .innerJoin(documents, eq(documentChunks.documentId, documents.id))
      .innerJoin(documentVersions, eq(documents.currentVersionId, documentVersions.id))
      .where(and(eq(documents.orgId, ctx.orgId), eq(documents.projectId, ctx.projectId), eq(documents.status, 'active'), eq(documentVersions.indexStatus, 'indexed'), eq(documentChunks.documentVersionId, documents.currentVersionId), eq(documentChunks.chunkIndex, 0)))
      .limit(1);
    const c = rows[0];
    query = (c?.content ?? 'status').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 4).slice(0, 3).join(' ') || 'status';
  }

  const result = await tx(async (t) => {
    const asm = await assembleDocumentSources(t, ctx, query, 5);
    const supplied = [...asm.retrieved, ...asm.coreRefs, ...(asm.productionStatus ? [asm.productionStatus] : [])];
    const snapshot: RunSourceSnapshot[] = supplied.map((r) => ({ relativePath: r.relativePath, sha256: r.sha256, disclosure: r.disclosure, chunkIndex: r.chunkIndex, rank: r.rank, excerpt: r.content, documentVersionId: r.documentVersionId }));

    // Synthetic run (cleaned up below).
    const agent = (await t.select({ id: agents.id }).from(agents).where(and(eq(agents.projectId, ctx.projectId), eq(agents.role, 'primary'))).limit(1))[0]
      ?? (await t.insert(agents).values({ orgId: ctx.orgId, projectId: ctx.projectId, name: '[verify] agent', role: 'primary', provider: 'openai', model: 'm', systemPrompt: 'x', classification: 'seed' }).returning({ id: agents.id }))[0]!;
    const task = (await t.insert(tasks).values({ orgId: ctx.orgId, projectId: ctx.projectId, title: '[verify] c2 evidence', input: query, providerSelection: 'openai', status: 'completed', createdBy: ctx.userId, classification: 'seed' }).returning({ id: tasks.id }))[0]!;
    const run = (await t.insert(runs).values({ orgId: ctx.orgId, projectId: ctx.projectId, taskId: task.id, status: 'completed', primaryAgentId: agent.id, retrievedSources: snapshot.length > 0 ? snapshot : null, classification: 'seed' }).returning({ id: runs.id }))[0]!;

    const written = asm.versioned
      ? await writeRunVersionEvidence(t, ctx, run.id, supplied.filter((r) => r.documentVersionId).map((r) => ({ documentVersionId: r.documentVersionId!, chunkIndex: r.chunkIndex, rank: r.rank, disclosure: r.disclosure, retrievalReason: 'run_context' })))
      : { versionLevel: 0, chunkLevel: 0 };

    const refs = await t.select({ chunkIndex: runDocumentVersions.chunkIndex, versionId: runDocumentVersions.documentVersionId }).from(runDocumentVersions).where(eq(runDocumentVersions.runId, run.id));
    const snapBack = (await t.select({ s: runs.retrievedSources }).from(runs).where(eq(runs.id, run.id)))[0]!.s as RunSourceSnapshot[] | null;

    const summary = {
      query,
      mode,
      versioned: asm.versioned,
      suppliedCount: supplied.length,
      snapshotWithVersionId: (snapBack ?? []).filter((s) => s.documentVersionId).length,
      snapshotTotal: (snapBack ?? []).length,
      evidenceVersionLevel: written.versionLevel,
      evidenceChunkLevel: written.chunkLevel,
      refRowsPersisted: refs.length,
      distinctVersionsReferenced: new Set(refs.map((r) => r.versionId)).size,
    };

    // Clean up the synthetic run (cascade removes run_document_versions) unless KEEP=1.
    if (process.env.KEEP !== '1') await t.delete(tasks).where(eq(tasks.id, task.id));
    return summary;
  });

  console.log(JSON.stringify(result, null, 2));
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
