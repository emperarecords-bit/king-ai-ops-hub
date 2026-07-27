import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/db/schema';
import { agents, documentChunks, documentVersions, documents, knowledgeItems, knowledgeSources, projectMembers, projects, runDocumentVersions, runs, tasks } from '../src/db/schema';
import { type DbTx } from '../src/db/client';
import type { TenantContext } from '../src/types/domain';
import { getObjectStore } from '../src/domain/documents/object-store';
import { backfillProject } from '../src/domain/documents/backfill';
import { tenantObjectKey } from '../src/domain/documents/object-store';
import { chunkText } from '../src/domain/documents/documents';
import { ingestDocumentVersion } from '../src/domain/documents/versions';

/**
 * Seeds the Documents Portfolio acceptance matrix — one disposable fixture per canonical/lens state, all
 * prefixed `__pf-demo-` (never a real restricted title). Idempotent: removes any prior `__pf-demo-` batch
 * first. Cleanup: `SEED_MODE=clean` removes the batch via lifecycle-safe delete.
 *
 *   SEED_PROJECT_KEY=<key> [SEED_MODE=clean] npm run seed:portfolio-states
 */
const PREFIX = '__pf-demo-';
const shaOf = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

async function main() {
  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_MIGRATION_URL or DATABASE_URL must be set.');
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const db = drizzle(sql, { schema });
  const tx = <T>(fn: (t: DbTx) => Promise<T>): Promise<T> => db.transaction((t) => fn(t));
  const store = await getObjectStore();

  const key = process.env.SEED_PROJECT_KEY;
  if (!key) throw new Error('SEED_PROJECT_KEY=<key> required.');
  const project = (await db.select().from(projects).where(eq(projects.key, key)).limit(1))[0];
  if (!project) throw new Error(`Project '${key}' not found.`);
  const member = (await db.select({ userId: projectMembers.userId }).from(projectMembers).where(eq(projectMembers.projectId, project.id)).limit(1))[0];
  const ctx: TenantContext = { userId: member!.userId, orgId: project.orgId, projectId: project.id, orgRole: 'owner', projectRole: 'admin' };

  // Always clean the prior demo batch first (delete the logical docs; cascades versions/chunks).
  const prior = await db.select({ id: documents.id }).from(documents).where(and(eq(documents.orgId, ctx.orgId), eq(documents.projectId, ctx.projectId)));
  for (const d of prior) {
    const doc = (await db.select({ relativePath: documents.relativePath }).from(documents).where(eq(documents.id, d.id)))[0];
    if (doc && doc.relativePath.startsWith(PREFIX)) await db.delete(documents).where(eq(documents.id, d.id));
  }
  if (process.env.SEED_MODE === 'clean') {
    console.log('cleaned __pf-demo- batch.');
    await sql.end();
    return;
  }

  const insDoc = async (rel: string, o: { source?: 'local_folder' | 'cloud_upload'; status?: string; disclosure?: 'workspace_internal' | 'restricted'; objectKey?: string | null; body?: string; sha?: string }) => {
    const r = await db.insert(documents).values({ orgId: ctx.orgId, projectId: ctx.projectId, source: o.source ?? 'cloud_upload', sourceId: rel, relativePath: rel, kind: 'markdown', sha256: o.sha ?? (o.body ? shaOf(o.body) : shaOf(rel)), sizeBytes: o.body ? Buffer.byteLength(o.body, 'utf8') : 10, status: (o.status ?? 'active') as 'active', disclosure: o.disclosure ?? 'workspace_internal', objectKey: o.objectKey ?? null, mimeType: 'text/markdown' }).returning({ id: documents.id });
    return r[0]!.id;
  };
  const addChunks = async (docId: string, contents: string[]) => {
    if (contents.length === 0) return;
    await db.insert(documentChunks).values(contents.map((content, i) => ({ orgId: ctx.orgId, projectId: ctx.projectId, documentId: docId, chunkIndex: i, content })));
    await db.update(documents).set({ chunkCount: contents.length, indexedAt: new Date() }).where(eq(documents.id, docId));
  };
  const byteExact = async (rel: string, body: string, disclosure: 'workspace_internal' | 'restricted' = 'workspace_internal') => {
    const sha = shaOf(body);
    const legacyKey = tenantObjectKey({ orgId: ctx.orgId, projectId: ctx.projectId, sourceId: rel, versionHash: sha });
    await store.put(legacyKey, Buffer.from(body, 'utf8'), 'text/markdown');
    const docId = await insDoc(rel, { source: 'cloud_upload', objectKey: legacyKey, body, disclosure });
    await addChunks(docId, chunkText(body));
    await tx((t) => backfillProject(t, ctx, store, { operationId: randomUUID() }));
    const v = (await db.select({ id: documentVersions.id }).from(documentVersions).where(and(eq(documentVersions.documentId, docId), eq(documentVersions.contentFidelity, 'byte_exact'))))[0]!;
    return { docId, versionId: v.id };
  };
  const reconstructed = async (rel: string, contents: string[]) => {
    const docId = await insDoc(rel, { source: 'local_folder', body: contents.join('\n\n') });
    await addChunks(docId, contents);
    await tx((t) => backfillProject(t, ctx, store, { operationId: randomUUID() }));
    const v = (await db.select({ id: documentVersions.id }).from(documentVersions).where(and(eq(documentVersions.documentId, docId), eq(documentVersions.indexStatus, 'indexed'))))[0]!;
    return { docId, versionId: v.id };
  };

  // ---- the matrix ------------------------------------------------------------------------------
  await byteExact(`${PREFIX}available-byte-exact.md`, '# Byte exact\n\nExact source bytes retained.');
  await reconstructed(`${PREFIX}available-reconstructed.md`, ['Reconstructed indexed text, no original bytes.']);
  await byteExact(`${PREFIX}available-restricted.md`, '# Restricted\n\nSensitive demo body.', 'restricted');
  const multi = await byteExact(`${PREFIX}available-multiple-versions.md`, '# V1\n\nfirst version body');
  await tx((t) => ingestDocumentVersion(t as never, ctx, store, { documentId: multi.docId, bytes: Buffer.from('# V2\n\nsecond version body', 'utf8'), text: '# V2\n\nsecond version body', mimeType: 'text/markdown', disclosure: 'workspace_internal', chunk: chunkText }));
  const newerFailed = await byteExact(`${PREFIX}available-newer-failed.md`, '# Current\n\ncurrent good body');
  await db.insert(documentVersions).values({ orgId: ctx.orgId, projectId: ctx.projectId, documentId: newerFailed.docId, sha256: shaOf(newerFailed.docId + 'nf'), sizeBytes: 1, contentFidelity: 'reconstructed_text', indexStatus: 'failed', parserVersion: 'chunk-v1' });
  { // source disconnected: no chunks → backfill → unavailable → source_unavailable
    await insDoc(`${PREFIX}source-disconnected.md`, { source: 'local_folder', status: 'active' });
    await tx((t) => backfillProject(t, ctx, store, { operationId: randomUUID() }));
  }
  { // archived
    const a = await byteExact(`${PREFIX}archived.md`, '# Archived\n\narchived body');
    await db.update(documents).set({ status: 'archived' }).where(eq(documents.id, a.docId));
  }
  { // knowledge-referenced
    const k = await byteExact(`${PREFIX}knowledge-referenced.md`, '# Cited\n\ncited by knowledge');
    const ki = await db.insert(knowledgeItems).values({ orgId: ctx.orgId, projectId: ctx.projectId, title: '[pf-demo] cited', body: 'b', createdBy: ctx.userId }).returning({ id: knowledgeItems.id });
    await db.insert(knowledgeSources).values({ orgId: ctx.orgId, projectId: ctx.projectId, knowledgeItemId: ki[0]!.id, knowledgeVersion: 1, sourceType: 'document', sourceRef: `${PREFIX}knowledge-referenced.md`, sourceLabel: 'cited', sourceVersionHash: shaOf('h'), transformation: 'quoted', documentVersionId: k.versionId });
  }
  { // supplied to several AI operations
    const s = await byteExact(`${PREFIX}supplied-to-ai.md`, '# Supplied\n\nsupplied to runs');
    const a = await db.insert(agents).values({ orgId: ctx.orgId, projectId: ctx.projectId, name: '[pf-demo] agent', role: 'primary', provider: 'openai', model: 'm', systemPrompt: 'x' }).returning({ id: agents.id });
    for (let i = 0; i < 2; i += 1) {
      const t = await db.insert(tasks).values({ orgId: ctx.orgId, projectId: ctx.projectId, title: `[pf-demo] task ${i}`, input: 'x', providerSelection: 'openai', status: 'completed', createdBy: ctx.userId }).returning({ id: tasks.id });
      const r = await db.insert(runs).values({ orgId: ctx.orgId, projectId: ctx.projectId, taskId: t[0]!.id, status: 'completed', primaryAgentId: a[0]!.id }).returning({ id: runs.id });
      await db.insert(runDocumentVersions).values([{ orgId: ctx.orgId, projectId: ctx.projectId, runId: r[0]!.id, documentVersionId: s.versionId, chunkIndex: -1, disclosureSnapshot: 'workspace_internal' }, { orgId: ctx.orgId, projectId: ctx.projectId, runId: r[0]!.id, documentVersionId: s.versionId, chunkIndex: 0, disclosureSnapshot: 'workspace_internal' }]);
    }
  }
  { // integrity-degraded
    const g = await byteExact(`${PREFIX}integrity-degraded.md`, '# Degraded\n\ndegraded index body');
    await db.update(documentVersions).set({ indexDegraded: true }).where(eq(documentVersions.id, g.versionId));
  }
  await byteExact(`${PREFIX}no-reference-normal.md`, '# Normal\n\nordinary unreferenced source');

  // Recently-changed CONTROL PAIR (Blocker 2). `recently-changed` is created through a GENUINE ingestion
  // (ingestDocumentVersion records source_change_at = now) → it is the only expected "recently changed"
  // besides `multiple-versions` (whose V2 was also genuinely ingested). `old-unchanged` is a backfilled
  // byte_exact source (source_change_at = null) — an infrastructure-migrated version is NOT a source change,
  // so it must NOT appear in Recently Changed. This is why the lens shows a small, meaningful count rather
  // than the whole migrated inventory.
  {
    const docId = await insDoc(`${PREFIX}recently-changed.md`, { source: 'cloud_upload', status: 'active' });
    const body = '# Recently changed\n\ngenuine source ingestion — changed recently';
    await tx((t) => ingestDocumentVersion(t as never, ctx, store, { documentId: docId, bytes: Buffer.from(body, 'utf8'), text: body, mimeType: 'text/markdown', disclosure: 'workspace_internal', chunk: chunkText }));
  }
  await byteExact(`${PREFIX}old-unchanged.md`, '# Old unchanged\n\nbackfilled (migration) source — not a recent source change');

  // Pure in-progress / failed / unsupported states LAST — no backfill runs after these, so a project-wide
  // backfill (which corrects active/indexing → source_unavailable) never mutates them.
  await insDoc(`${PREFIX}processing-upload.md`, { status: 'uploaded' });
  await insDoc(`${PREFIX}processing-indexing.md`, { status: 'indexing' });
  await insDoc(`${PREFIX}initial-indexing-failed.md`, { status: 'failed' });
  await insDoc(`${PREFIX}unsupported-source.md`, { status: 'unsupported' });

  const demo = (await db.select({ id: documents.id, relativePath: documents.relativePath }).from(documents).where(and(eq(documents.orgId, ctx.orgId), eq(documents.projectId, ctx.projectId)))).filter((d) => d.relativePath.startsWith(PREFIX)).length;
  console.log(`seeded ${demo} __pf-demo- fixtures into ${key}.`);
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
