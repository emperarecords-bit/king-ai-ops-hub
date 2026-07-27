import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { and, eq, isNotNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/db/schema';
import { documentChunks, documentVersions, documents, projectMembers, projects, runs } from '../src/db/schema';
import { type DbTx } from '../src/db/client';
import type { RunSourceSnapshot, TenantContext } from '../src/types/domain';
import { getObjectStore } from '../src/domain/documents/object-store';
import { backfillProject } from '../src/domain/documents/backfill';
import { resolveRunSuppliedEvidence, retrieveExactHistorical } from '../src/domain/documents/historical';
import { assessDocumentViewerAccess } from '../src/domain/documents/viewer-access';
import { assessLegacyObjects, assessPurge, executePurge } from '../src/domain/documents/retention';
import { auditDocumentIntegrity } from '../src/domain/documents/integrity';

/**
 * Documents increment 1, Stage D10 — staging acceptance. Read-only assessments on real data + a DISPOSABLE
 * fixture for the destructive purge (never purges evidence-bearing records).
 *   RETRIEVAL_MODE_PROJECT=<id|key> npm run stage-d:acceptance
 */
const shaOf = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

async function main() {
  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_MIGRATION_URL or DATABASE_URL must be set.');
  const target = process.env.RETRIEVAL_MODE_PROJECT;
  if (!target) throw new Error('RETRIEVAL_MODE_PROJECT=<id|key> required.');
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const db = drizzle(sql, { schema });
  const tx = <T>(fn: (t: DbTx) => Promise<T>): Promise<T> => db.transaction((t) => fn(t));
  const store = await getObjectStore();

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target);
  const project = isUuid ? (await db.select().from(projects).where(eq(projects.id, target)).limit(1))[0] : (await db.select().from(projects).where(eq(projects.key, target)).limit(1))[0];
  if (!project) throw new Error(`Project '${target}' not found.`);
  const member = (await db.select({ userId: projectMembers.userId }).from(projectMembers).where(eq(projectMembers.projectId, project.id)).limit(1))[0];
  const ctx: TenantContext = { userId: member!.userId, orgId: project.orgId, projectId: project.id, orgRole: 'owner', projectRole: 'admin' };

  const out: Record<string, unknown> = { project: project.key };

  // 1. Historical retrieval of a real current byte_exact version (S3-backed).
  const be = (await db.select({ vid: documentVersions.id, docId: documentVersions.documentId }).from(documentVersions).innerJoin(documents, eq(documents.currentVersionId, documentVersions.id)).where(and(eq(documentVersions.orgId, ctx.orgId), eq(documentVersions.projectId, ctx.projectId), eq(documentVersions.contentFidelity, 'byte_exact'))).limit(1))[0];
  if (be) {
    const got = await tx((t) => retrieveExactHistorical(t, ctx, store, { kind: 'versionId', versionId: be.vid }, { authorized: true, revealHash: true }));
    out.historicalByteExact = { versionId: be.vid, state: got.state, downloadable: got.downloadable, hashVerified: got.state === 'resolved' && shaOf(got.bytes!.toString('utf8')) === got.versionHash };
  }

  // 2. Real run → exact version evidence (source evidence vs supplied prompt text), incl. failed runs.
  const runRows = await db.select({ id: runs.id, status: runs.status, rs: runs.retrievedSources }).from(runs).where(and(eq(runs.orgId, ctx.orgId), eq(runs.projectId, ctx.projectId), isNotNull(runs.retrievedSources)));
  const runWithVersion = runRows.find((r) => ((r.rs as RunSourceSnapshot[] | null) ?? []).some((s) => s.documentVersionId));
  if (runWithVersion) {
    const vid = ((runWithVersion.rs as RunSourceSnapshot[]) ?? []).find((s) => s.documentVersionId)!.documentVersionId!;
    const ev = await tx((t) => resolveRunSuppliedEvidence(t, ctx, runWithVersion.id, vid));
    out.runEvidence = { runId: runWithVersion.id, status: runWithVersion.status, suppliedChunks: ev?.suppliedFromSnapshot.length ?? 0, versionResolved: ev?.version.state };
  }
  out.failedRunEvidencePreserved = runRows.filter((r) => r.status === 'failed' && ((r.rs as RunSourceSnapshot[] | null) ?? []).some((s) => s.documentVersionId)).length;

  // 3. Integrity audit + legacy-object assessment (read-only).
  out.integrity = (await tx((t) => auditDocumentIntegrity(t, ctx, store))).byCategory;
  out.legacyObjects = (await tx((t) => assessLegacyObjects(t, ctx, store))).byClass;

  // 4. Purge blocked by real institutional evidence (assess only — never execute on real records).
  if (runWithVersion) {
    const vid = ((runWithVersion.rs as RunSourceSnapshot[]) ?? []).find((s) => s.documentVersionId)!.documentVersionId!;
    out.purgeBlockedRealVersion = (await tx((t) => assessPurge(t, ctx, vid))).decision;
  }

  // 5. DISPOSABLE fixture: a restricted recon doc → viewer denial vs permit → permitted purge → tombstone.
  const fixturePath = `__stage-d-fixture-${randomUUID().slice(0, 8)}.md`;
  const insDoc = await db.insert(documents).values({ orgId: ctx.orgId, projectId: ctx.projectId, source: 'local_folder', sourceId: fixturePath, relativePath: fixturePath, kind: 'markdown', sha256: shaOf('fixture body'), sizeBytes: 12, status: 'active', disclosure: 'restricted' }).returning({ id: documents.id });
  const fixtureDoc = insDoc[0]!.id;
  await db.insert(documentChunks).values({ orgId: ctx.orgId, projectId: ctx.projectId, documentId: fixtureDoc, chunkIndex: 0, content: 'disposable fixture chunk' });
  await tx((t) => backfillProject(t, ctx, store, { operationId: randomUUID() }));
  const fixtureVersion = (await db.select({ id: documentVersions.id }).from(documentVersions).where(eq(documentVersions.documentId, fixtureDoc)))[0]!.id;

  const memberCtx: TenantContext = { userId: randomUUID(), orgId: ctx.orgId, projectId: ctx.projectId, orgRole: 'member', projectRole: 'member' };
  out.viewerDeniedNonMember = (await tx((t) => assessDocumentViewerAccess(t, memberCtx, fixtureDoc))).canInspect;
  out.viewerPermittedAdmin = (await tx((t) => assessDocumentViewerAccess(t, ctx, fixtureDoc))).canInspect;

  // Detach current pointer so the disposable version is purgeable, then purge it.
  await db.update(documents).set({ currentVersionId: null }).where(eq(documents.id, fixtureDoc));
  out.fixturePurgeAssessment = (await tx((t) => assessPurge(t, ctx, fixtureVersion))).decision;
  const purge = await tx((t) => executePurge(t, ctx, store, fixtureVersion, 'stage-d disposable fixture'));
  out.fixturePurged = purge.purged;
  out.fixtureTombstone = (await db.select({ id: schema.documentVersionTombstones.id }).from(schema.documentVersionTombstones).where(eq(schema.documentVersionTombstones.versionId, fixtureVersion))).length === 1;
  // Remove the disposable document shell (cascade removes any residue). Not institutional evidence.
  await db.delete(documents).where(eq(documents.id, fixtureDoc));

  console.log(JSON.stringify(out, null, 2));
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
