import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray, like } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/db/schema';
import { agents, documentChunks, documentVersions, documents, knowledgeItems, knowledgeSources, knowledgeVerificationEvents, projectMembers, projects, runDocumentVersions, runSteps, runs, tasks } from '../src/db/schema';
import { markIndexDegraded } from '../src/domain/documents/integrity';
import { archiveDocument } from '../src/domain/documents/documents';
import { writeAudit } from '../src/domain/audit/audit';
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

  // Lifecycle-safe removal of the prior demo batch. Evidence relationships use RESTRICT (deleting a
  // referenced version is refused), so dependents must go first, in order: run↔version and knowledge↔version
  // links → demo runs/tasks/agents (tagged '[pf-demo]…') → demo knowledge items → the documents (which then
  // cascade their versions + chunks). Only ever touches `__pf-demo-` docs and '[pf-demo]'-tagged rows.
  async function cleanupDemoBatch() {
    const demoDocIds = (await db.select({ id: documents.id, relativePath: documents.relativePath }).from(documents).where(and(eq(documents.orgId, ctx.orgId), eq(documents.projectId, ctx.projectId))))
      .filter((d) => d.relativePath.startsWith(PREFIX))
      .map((d) => d.id);
    if (demoDocIds.length > 0) {
      const verIds = (await db.select({ id: documentVersions.id }).from(documentVersions).where(inArray(documentVersions.documentId, demoDocIds))).map((v) => v.id);
      if (verIds.length > 0) {
        await db.delete(runDocumentVersions).where(inArray(runDocumentVersions.documentVersionId, verIds));
        await db.delete(knowledgeSources).where(inArray(knowledgeSources.documentVersionId, verIds));
      }
      // Remove the demo objects from storage too, so `clean` leaves no orphaned storage objects behind. Also
      // sweep the whole demo key prefix (catches any leftover orphan fixture that no row points at).
      const objKeys = new Set<string>();
      for (const d of await db.select({ k: documents.objectKey }).from(documents).where(inArray(documents.id, demoDocIds))) if (d.k) objKeys.add(d.k);
      if (verIds.length > 0) for (const v of await db.select({ k: documentVersions.objectKey }).from(documentVersions).where(inArray(documentVersions.id, verIds))) if (v.k) objKeys.add(v.k);
      if (typeof store.list === 'function') {
        try {
          for (const key of await store.list(`org/${ctx.orgId}/project/${ctx.projectId}/doc/${PREFIX}`)) objKeys.add(key);
        } catch { /* listing best-effort */ }
      }
      for (const k of objKeys) { try { await store.delete(k); } catch { /* best-effort object cleanup */ } }
    }
    const demoTaskIds = (await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.orgId, ctx.orgId), eq(tasks.projectId, ctx.projectId), like(tasks.title, '[pf-demo]%')))).map((t) => t.id);
    if (demoTaskIds.length > 0) {
      await db.delete(runs).where(inArray(runs.taskId, demoTaskIds)); // cascades run_steps + run_document_versions
      await db.delete(tasks).where(inArray(tasks.id, demoTaskIds));
    }
    await db.delete(agents).where(and(eq(agents.orgId, ctx.orgId), eq(agents.projectId, ctx.projectId), like(agents.name, '[pf-demo]%')));
    // Support judgments are append-only; deleting the demo knowledge items would cascade-delete them and be
    // blocked by the guard. Disable it (the seed runs as the owning migration role) only for this delete.
    const demoItemIds = (await db.select({ id: knowledgeItems.id }).from(knowledgeItems).where(and(eq(knowledgeItems.orgId, ctx.orgId), eq(knowledgeItems.projectId, ctx.projectId), like(knowledgeItems.title, '[pf-demo]%')))).map((k) => k.id);
    if (demoItemIds.length > 0) {
      await sql`alter table knowledge_verification_events disable trigger knowledge_verification_events_append_only`;
      try {
        await db.delete(knowledgeVerificationEvents).where(inArray(knowledgeVerificationEvents.knowledgeItemId, demoItemIds));
        await db.delete(knowledgeItems).where(inArray(knowledgeItems.id, demoItemIds));
      } finally {
        await sql`alter table knowledge_verification_events enable trigger knowledge_verification_events_append_only`;
      }
    }
    if (demoDocIds.length > 0) await db.delete(documents).where(inArray(documents.id, demoDocIds));
  }
  await cleanupDemoBatch();
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
  { // archived (cloud)
    const a = await byteExact(`${PREFIX}archived.md`, '# Archived\n\narchived body');
    await db.update(documents).set({ status: 'archived' }).where(eq(documents.id, a.docId));
  }
  { // archived LOCAL — an intentionally-archived local-folder source (archivedIntentAt set via the domain
    // action, so a folder refresh never silently restores it; only Restore is offered).
    const al = await reconstructed(`${PREFIX}archived-local.md`, ['archived local body']);
    await tx((t) => archiveDocument(t, ctx, al.docId));
  }
  { // knowledge-referenced — one RELIED-UPON source (named in a support judgment) + one ATTACHED-not-judged
    const k = await byteExact(`${PREFIX}knowledge-referenced.md`, '# Cited\n\ncited by knowledge');
    const ki = await db.insert(knowledgeItems).values({ orgId: ctx.orgId, projectId: ctx.projectId, title: '[pf-demo] cited', body: 'b', createdBy: ctx.userId }).returning({ id: knowledgeItems.id });
    const reliedSrc = await db.insert(knowledgeSources).values({ orgId: ctx.orgId, projectId: ctx.projectId, knowledgeItemId: ki[0]!.id, knowledgeVersion: 1, sourceType: 'document', sourceRef: `${PREFIX}knowledge-referenced.md`, sourceLabel: 'relied source', sourceVersionHash: shaOf('h'), transformation: 'quoted', documentVersionId: k.versionId }).returning({ id: knowledgeSources.id });
    await db.insert(knowledgeSources).values({ orgId: ctx.orgId, projectId: ctx.projectId, knowledgeItemId: ki[0]!.id, knowledgeVersion: 1, sourceType: 'document', sourceRef: `${PREFIX}knowledge-referenced.md`, sourceLabel: 'attached source', sourceVersionHash: shaOf('h2'), transformation: 'summarized', documentVersionId: k.versionId });
    // A recorded support judgment relies on ONLY the first source → the second stays attached_not_judged.
    await db.insert(knowledgeVerificationEvents).values({ orgId: ctx.orgId, projectId: ctx.projectId, knowledgeItemId: ki[0]!.id, knowledgeVersion: 1, judgment: 'source_supported', verifier: ctx.userId, reliedOnSourceIds: [reliedSrc[0]!.id], resolutionSnapshot: {} });
  }
  { // supplied to several AI operations, with IMMUTABLE primary + reviewer execution steps recorded
    const s = await byteExact(`${PREFIX}supplied-to-ai.md`, '# Supplied\n\nsupplied to runs');
    const a = await db.insert(agents).values({ orgId: ctx.orgId, projectId: ctx.projectId, name: '[pf-demo] agent', role: 'primary', provider: 'openai', model: 'agent-current-model', systemPrompt: 'x' }).returning({ id: agents.id });
    for (let i = 0; i < 2; i += 1) {
      const t = await db.insert(tasks).values({ orgId: ctx.orgId, projectId: ctx.projectId, title: `[pf-demo] task ${i}`, input: 'x', providerSelection: 'openai', status: 'completed', createdBy: ctx.userId }).returning({ id: tasks.id });
      const r = await db.insert(runs).values({ orgId: ctx.orgId, projectId: ctx.projectId, taskId: t[0]!.id, status: 'completed', primaryAgentId: a[0]!.id }).returning({ id: runs.id });
      // Dispatch-time facts frozen on the steps: primary (anthropic) distinct from reviewer (openai).
      await db.insert(runSteps).values([
        { orgId: ctx.orgId, projectId: ctx.projectId, runId: r[0]!.id, stepNumber: 1, kind: 'primary', agentId: a[0]!.id, provider: 'anthropic', model: 'claude-primary-dispatch', succeeded: true },
        { orgId: ctx.orgId, projectId: ctx.projectId, runId: r[0]!.id, stepNumber: 2, kind: 'review', agentId: a[0]!.id, provider: 'openai', model: 'gpt-reviewer-dispatch', succeeded: true },
      ]);
      await db.insert(runDocumentVersions).values([{ orgId: ctx.orgId, projectId: ctx.projectId, runId: r[0]!.id, documentVersionId: s.versionId, chunkIndex: -1, disclosureSnapshot: 'workspace_internal' }, { orgId: ctx.orgId, projectId: ctx.projectId, runId: r[0]!.id, documentVersionId: s.versionId, chunkIndex: 0, disclosureSnapshot: 'workspace_internal' }]);
    }
  }
  { // integrity-degraded — degraded via the domain repair path so a version-scoped audit event is recorded
    const g = await byteExact(`${PREFIX}integrity-degraded.md`, '# Degraded\n\ndegraded index body');
    await tx((t) => markIndexDegraded(t, ctx, g.versionId, 'demo: faithful rebuild could not be proven'));
  }
  { // integrity: a genuinely MISSING retained object → the read-only audit reports "degraded" for this
    // exact version (a deliberate corruption fixture for Integrity acceptance; content is intact elsewhere).
    const mo = await byteExact(`${PREFIX}integrity-missing-object.md`, '# Missing object\n\nbody whose retained object is removed');
    const vk = (await db.select({ k: documentVersions.objectKey }).from(documentVersions).where(eq(documentVersions.id, mo.versionId)))[0]?.k;
    if (vk) await store.delete(vk);
  }
  { // repairable: a corrupted chunk with an intact, hash-verified object → the Repair increment can restore
    // it from the retained bytes (a SUCCESSFUL-repair demo fixture).
    const rp = await byteExact(`${PREFIX}repairable.md`, '# Repairable\n\nfirst paragraph of the source.\n\nsecond paragraph of the source.');
    const ch = (await db.select({ id: documentChunks.id }).from(documentChunks).where(eq(documentChunks.documentVersionId, rp.versionId)).limit(1))[0];
    if (ch) await db.update(documentChunks).set({ content: 'CORRUPTED DEMO CHUNK' }).where(eq(documentChunks.id, ch.id));
  }
  { // repair-unprovable: a corrupted chunk AND a corrupted object → a faithful rebuild cannot be proven, so
    // repair must safely REFUSE (a refused-repair demo fixture).
    const ru = await byteExact(`${PREFIX}repair-unprovable.md`, '# Unprovable\n\nfirst paragraph body.\n\nsecond paragraph body.');
    const ch = (await db.select({ id: documentChunks.id }).from(documentChunks).where(eq(documentChunks.documentVersionId, ru.versionId)).limit(1))[0];
    if (ch) await db.update(documentChunks).set({ content: 'CORRUPTED DEMO CHUNK' }).where(eq(documentChunks.id, ch.id));
    const vk = (await db.select({ k: documentVersions.objectKey }).from(documentVersions).where(eq(documentVersions.id, ru.versionId)))[0]?.k;
    if (vk) await store.put(vk, Buffer.from('object bytes that no longer match the recorded hash', 'utf8'), 'text/markdown');
  }
  { // cleanup-orphan: a HEALTHY document with an extra orphaned storage object under its own key prefix
    // (a failed-upload leftover referenced by no version/document/tombstone) → the integrity audit surfaces
    // an orphan_object finding a legacy-object cleanup can safely delete (successful + refused demo fixture).
    const rel = `${PREFIX}cleanup-orphan.md`;
    await byteExact(rel, '# Cleanup orphan\n\na healthy source that also has a leftover orphan object');
    const orphanKey = tenantObjectKey({ orgId: ctx.orgId, projectId: ctx.projectId, sourceId: rel, versionHash: shaOf('__pf-demo orphan leftover from a failed upload') });
    await store.put(orphanKey, Buffer.from('orphaned bytes left by a failed upload — referenced by nothing', 'utf8'), 'text/markdown');
  }
  { // lifecycle — document-scoped (archive → restore) AND version-scoped (index degraded) history
    const lc = await byteExact(`${PREFIX}lifecycle-events.md`, '# Lifecycle\n\ndocument with a lifecycle trail');
    await tx((t) => writeAudit(t, ctx, { action: 'document.archived', entityType: 'document', entityId: lc.docId, detail: { source: 'cloud_upload' } }));
    await tx((t) => writeAudit(t, ctx, { action: 'document.restored', entityType: 'document', entityId: lc.docId, detail: { source: 'cloud_upload', versionReused: true } }));
    await tx((t) => markIndexDegraded(t, ctx, lc.versionId, 'demo: version-scoped integrity event'));
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
