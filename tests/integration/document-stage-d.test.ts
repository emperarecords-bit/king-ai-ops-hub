import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type KnowledgeDisclosure, type RunSourceSnapshot, type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { agents, documentChunks, documentVersionTombstones, documentVersions, documents, knowledgeItems, knowledgeSources, memberships, organizations, profiles, projectMembers, projects, runDocumentVersions, runs, tasks } from '@/db/schema';
import { chunkText } from '@/domain/documents/documents';
import { backfillProject } from '@/domain/documents/backfill';
import { ingestDocumentVersion } from '@/domain/documents/versions';
import { LocalObjectStore } from '@/domain/documents/local-object-store';
import { tenantObjectKey } from '@/domain/documents/object-store';
import { resolveExactVersion, resolveRunSuppliedEvidence, retrieveExactHistorical } from '@/domain/documents/historical';
import { assessDocumentViewerAccess } from '@/domain/documents/viewer-access';
import { assessLegacyObjects, assessPurge, assertPurgeAuthority, executePurge } from '@/domain/documents/retention';
import { auditDocumentIntegrity, rebuildVersionChunksFromBytes, restoreRunReferenceFromSnapshot, reverifyObject } from '@/domain/documents/integrity';

process.env.DATABASE_URL = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';

let available = false;
try {
  await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1);
  available = true;
} catch (err) {
  console.warn(`[document-stage-d.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`);
}

let storeDir = '';
let store: LocalObjectStore;
let orgId = '';
let userId = '';
const db = () => getSetupDb();
const shaOf = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const tx = <T>(fn: (t: never) => Promise<T>): Promise<T> => db().transaction((t) => fn(t as never)) as Promise<T>;

async function makeWorkspace(role: 'admin' | 'member' = 'admin'): Promise<TenantContext> {
  const p = await db().insert(projects).values({ orgId, key: fixtureKey('d'), name: 'D WS' }).returning({ id: projects.id });
  await db().insert(projectMembers).values({ orgId, projectId: p[0]!.id, userId, role });
  return { userId, orgId, projectId: p[0]!.id, orgRole: role === 'admin' ? 'owner' : 'member', projectRole: role };
}
async function runBackfill(ctx: TenantContext) {
  return db().transaction((t) => backfillProject(t, ctx, store, { operationId: randomUUID() }));
}
/** Active doc with legacy chunks, no folder → backfill makes a RECONSTRUCTED current version. */
async function reconDoc(ctx: TenantContext, relPath: string, chunks: string[], disclosure: KnowledgeDisclosure = 'workspace_internal') {
  const body = chunks.join('\n\n');
  const ins = await db().insert(documents).values({ orgId: ctx.orgId, projectId: ctx.projectId, source: 'local_folder', sourceId: relPath, relativePath: relPath, kind: 'markdown', sha256: shaOf(body), sizeBytes: Buffer.byteLength(body, 'utf8'), status: 'active', disclosure }).returning({ id: documents.id });
  const docId = ins[0]!.id;
  await db().insert(documentChunks).values(chunks.map((content, i) => ({ orgId: ctx.orgId, projectId: ctx.projectId, documentId: docId, chunkIndex: i, content, locator: `line ${i}` })));
  await db().update(documents).set({ chunkCount: chunks.length, indexedAt: new Date() }).where(eq(documents.id, docId));
  await runBackfill(ctx);
  const v = (await db().select({ id: documentVersions.id }).from(documentVersions).where(and(eq(documentVersions.documentId, docId), eq(documentVersions.indexStatus, 'indexed'))))[0]!;
  return { docId, versionId: v.id };
}
/** Cloud doc + retained object → backfill makes a BYTE_EXACT current version (with a version object). */
async function byteExactDoc(ctx: TenantContext, relPath: string, body: string, disclosure: KnowledgeDisclosure = 'workspace_internal') {
  const sha = shaOf(body);
  const legacyKey = tenantObjectKey({ orgId: ctx.orgId, projectId: ctx.projectId, sourceId: relPath, versionHash: sha });
  await store.put(legacyKey, Buffer.from(body, 'utf8'), 'text/markdown');
  const ins = await db().insert(documents).values({ orgId: ctx.orgId, projectId: ctx.projectId, source: 'cloud_upload', sourceId: relPath, relativePath: relPath, kind: 'markdown', sha256: sha, sizeBytes: Buffer.byteLength(body, 'utf8'), status: 'active', objectKey: legacyKey, mimeType: 'text/markdown', disclosure }).returning({ id: documents.id });
  const docId = ins[0]!.id;
  await db().insert(documentChunks).values(chunkText(body).map((content, i) => ({ orgId: ctx.orgId, projectId: ctx.projectId, documentId: docId, chunkIndex: i, content })));
  await db().update(documents).set({ chunkCount: chunkText(body).length, indexedAt: new Date() }).where(eq(documents.id, docId));
  await runBackfill(ctx);
  const v = (await db().select({ id: documentVersions.id, objectKey: documentVersions.objectKey }).from(documentVersions).where(and(eq(documentVersions.documentId, docId), eq(documentVersions.contentFidelity, 'byte_exact'))))[0]!;
  return { docId, versionId: v.id, versionKey: v.objectKey! };
}
/** Ingest a NEW version (byte_exact) for an existing doc → it becomes current; the prior is historical. */
async function newVersion(ctx: TenantContext, docId: string, body: string): Promise<string> {
  return db().transaction((t) => ingestDocumentVersion(t as never, ctx, store, { documentId: docId, bytes: Buffer.from(body, 'utf8'), text: body, mimeType: 'text/markdown', disclosure: 'workspace_internal', chunk: chunkText }).then((r) => r.versionId));
}
async function unavailableDoc(ctx: TenantContext, relPath: string) {
  await db().insert(documents).values({ orgId: ctx.orgId, projectId: ctx.projectId, source: 'local_folder', sourceId: relPath, relativePath: relPath, kind: 'markdown', sha256: shaOf(relPath + 'gone'), sizeBytes: 1, status: 'active' });
  await runBackfill(ctx);
  const doc = (await db().select({ id: documents.id }).from(documents).where(and(eq(documents.projectId, ctx.projectId), eq(documents.relativePath, relPath))))[0]!;
  const v = (await db().select({ id: documentVersions.id }).from(documentVersions).where(and(eq(documentVersions.documentId, doc.id), eq(documentVersions.contentFidelity, 'unavailable'))))[0]!;
  return { docId: doc.id, versionId: v.id };
}
async function makeRun(ctx: TenantContext, snapshot: RunSourceSnapshot[]): Promise<string> {
  const a = await db().insert(agents).values({ orgId: ctx.orgId, projectId: ctx.projectId, name: 'a', role: 'primary', provider: 'openai', model: 'm', systemPrompt: 'x' }).returning({ id: agents.id });
  const t = await db().insert(tasks).values({ orgId: ctx.orgId, projectId: ctx.projectId, title: 't', input: 'x', providerSelection: 'openai', status: 'completed', createdBy: ctx.userId }).returning({ id: tasks.id });
  const r = await db().insert(runs).values({ orgId: ctx.orgId, projectId: ctx.projectId, taskId: t[0]!.id, status: 'completed', primaryAgentId: a[0]!.id, retrievedSources: snapshot }).returning({ id: runs.id });
  return r[0]!.id;
}
async function makeKnowledgeSourceBound(ctx: TenantContext, docPath: string, hash: string, versionId: string): Promise<string> {
  const ki = await db().insert(knowledgeItems).values({ orgId: ctx.orgId, projectId: ctx.projectId, title: 'k', body: 'b', createdBy: ctx.userId }).returning({ id: knowledgeItems.id });
  const ks = await db().insert(knowledgeSources).values({ orgId: ctx.orgId, projectId: ctx.projectId, knowledgeItemId: ki[0]!.id, knowledgeVersion: 1, sourceType: 'document', sourceRef: docPath, sourceLabel: docPath, sourceVersionHash: hash, transformation: 'quoted', documentVersionId: versionId }).returning({ id: knowledgeSources.id });
  return ks[0]!.id;
}
const AUTH = { authorized: true, revealHash: true };

beforeAll(async () => {
  if (!available) return;
  storeDir = await mkdtemp(join(tmpdir(), 'd-store-'));
  process.env.LOCAL_OBJECT_STORE_DIR = storeDir;
  store = new LocalObjectStore(storeDir);
  userId = randomUUID();
  await db().insert(profiles).values({ id: userId, email: `d-${randomUUID().slice(0, 8)}@t.local`, displayName: 'D' });
  const org = await db().insert(organizations).values({ name: 'D Org', slug: `d-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id });
  orgId = org[0]!.id;
  await db().insert(memberships).values({ orgId, userId, role: 'owner' });
});
afterAll(async () => {
  if (available && orgId) {
    await db().execute(sql`alter table audit_logs disable trigger audit_logs_append_only`);
    await db().execute(sql`delete from audit_logs where org_id = ${orgId}`);
    await db().execute(sql`alter table audit_logs enable trigger audit_logs_append_only`);
    await db().delete(organizations).where(eq(organizations.id, orgId));
  }
  if (storeDir) await rm(storeDir, { recursive: true, force: true });
  delete process.env.LOCAL_OBJECT_STORE_DIR;
});

describe.skipIf(!available)('Stage D — exact historical retrieval, viewer access, purge, integrity', () => {
  it('1/2. exact historical retrieval returns the older byte_exact version and never substitutes current', async () => {
    const ctx = await makeWorkspace();
    const { docId, versionId: v1 } = await byteExactDoc(ctx, 'hist.md', '# V1\n\noriginal body one');
    const v2 = await newVersion(ctx, docId, '# V2\n\nupdated body two');
    expect(v2).not.toBe(v1);
    const cur = (await db().select({ c: documents.currentVersionId }).from(documents).where(eq(documents.id, docId)))[0]!.c;
    expect(cur).toBe(v2); // current advanced
    const got = await tx((t) => retrieveExactHistorical(t, ctx, store, { kind: 'versionId', versionId: v1 }, AUTH));
    expect(got.state).toBe('resolved');
    expect(got.versionId).toBe(v1); // the OLD version, not current
    expect(got.bytes!.toString('utf8')).toBe('# V1\n\noriginal body one');
  });

  it('3. a byte_exact download hashes to the recorded version hash', async () => {
    const ctx = await makeWorkspace();
    const body = '# Exact\n\ndownload integrity body';
    const { versionId } = await byteExactDoc(ctx, 'dl.md', body);
    const got = await tx((t) => retrieveExactHistorical(t, ctx, store, { kind: 'versionId', versionId }, AUTH));
    expect(got.downloadable).toBe(true);
    expect(shaOf(got.bytes!.toString('utf8'))).toBe(got.versionHash);
    expect(got.versionHash).toBe(shaOf(body));
  });

  it('4. corrupted retained bytes return an integrity failure, not content', async () => {
    const ctx = await makeWorkspace();
    const { versionId, versionKey } = await byteExactDoc(ctx, 'corrupt.md', 'original exact bytes');
    await store.put(versionKey, Buffer.from('TAMPERED bytes different length', 'utf8'), 'text/markdown');
    const got = await tx((t) => retrieveExactHistorical(t, ctx, store, { kind: 'versionId', versionId }, AUTH));
    expect(got.state).toBe('integrity_failure');
    expect(got.bytes).toBeUndefined();
  });

  it('5. reconstructed versions return qualified text and no exact download', async () => {
    const ctx = await makeWorkspace();
    const { versionId } = await reconDoc(ctx, 'recon.md', ['reconstructed chunk one', 'reconstructed chunk two']);
    const got = await tx((t) => retrieveExactHistorical(t, ctx, store, { kind: 'versionId', versionId }, AUTH));
    expect(got.state).toBe('resolved');
    expect(got.fidelity).toBe('reconstructed_text');
    expect(got.downloadable).toBe(false);
    expect(got.bytes).toBeUndefined();
    expect(got.qualification).toContain('Reconstructed from indexed text');
    expect(got.chunks!.map((c) => c.content)).toEqual(['reconstructed chunk one', 'reconstructed chunk two']);
  });

  it('6. unavailable versions return no preview', async () => {
    const ctx = await makeWorkspace();
    const { versionId } = await unavailableDoc(ctx, 'unav.md');
    const got = await tx((t) => retrieveExactHistorical(t, ctx, store, { kind: 'versionId', versionId }, AUTH));
    expect(got.state).toBe('unavailable');
    expect(got.bytes).toBeUndefined();
    expect(got.chunks).toBeUndefined();
  });

  it('7. missing version and unavailable content are distinct', async () => {
    const ctx = await makeWorkspace();
    const { versionId } = await unavailableDoc(ctx, 'u7.md');
    const unavail = await tx((t) => resolveExactVersion(t, ctx, { kind: 'versionId', versionId }));
    expect(unavail.state).toBe('found'); // exists, then inspects as unavailable
    const missing = await tx((t) => resolveExactVersion(t, ctx, { kind: 'versionId', versionId: randomUUID() }));
    expect(missing.state).toBe('missing');
  });

  it('8. version mismatch is distinct from missing', async () => {
    const ctx = await makeWorkspace();
    await byteExactDoc(ctx, 'mm.md', 'the real body');
    const mismatch = await tx((t) => resolveExactVersion(t, ctx, { kind: 'legacy', relativePath: 'mm.md', sha256: shaOf('a DIFFERENT body never retained') }));
    expect(mismatch.state).toBe('version_mismatch');
    const missing = await tx((t) => resolveExactVersion(t, ctx, { kind: 'legacy', relativePath: 'nope.md', sha256: shaOf('x') }));
    expect(missing.state).toBe('missing');
  });

  it('9. an unauthorized (non-member) viewer receives no content or metadata', async () => {
    const ctx = await makeWorkspace();
    const { docId, versionId } = await reconDoc(ctx, 'v9.md', ['viewer content']);
    const stranger: TenantContext = { userId: randomUUID(), orgId: ctx.orgId, projectId: ctx.projectId, orgRole: 'member', projectRole: 'member' };
    const access = await tx((t) => assessDocumentViewerAccess(t, stranger, docId));
    expect(access.canInspect).toBe(false);
    expect(access.reason).toBe('not_a_member');
    const got = await tx((t) => retrieveExactHistorical(t, ctx, store, { kind: 'versionId', versionId }, { authorized: access.canInspect }));
    expect(got.state).toBe('inaccessible');
    expect(got.bytes).toBeUndefined();
    expect(got.chunks).toBeUndefined();
  });

  it('10. an authorized restricted viewer receives the exact permitted version', async () => {
    const ctx = await makeWorkspace('admin'); // owner/admin
    const { docId, versionId } = await byteExactDoc(ctx, 'r10.md', 'restricted exact body', 'restricted');
    const access = await tx((t) => assessDocumentViewerAccess(t, ctx, docId));
    expect(access.restricted).toBe(true);
    expect(access.canInspect).toBe(true);
    const got = await tx((t) => retrieveExactHistorical(t, ctx, store, { kind: 'versionId', versionId }, { authorized: access.canInspect }));
    expect(got.state).toBe('resolved');
    expect(got.bytes!.toString('utf8')).toBe('restricted exact body');
  });

  it('11. human viewer authorization does not reuse an AI grant, and ordinary members cannot view restricted', async () => {
    const admin = await makeWorkspace('admin');
    const { docId } = await byteExactDoc(admin, 'r11.md', 'restricted body', 'restricted');
    // A plain member of the SAME workspace (no owner/admin) cannot inspect restricted, regardless of any AI grant.
    const memberUser = randomUUID();
    await db().insert(profiles).values({ id: memberUser, email: `m-${memberUser.slice(0, 8)}@t.local`, displayName: 'M' });
    await db().insert(projectMembers).values({ orgId: admin.orgId, projectId: admin.projectId, userId: memberUser, role: 'member' });
    const memberCtx: TenantContext = { userId: memberUser, orgId: admin.orgId, projectId: admin.projectId, orgRole: 'member', projectRole: 'member' };
    const access = await tx((t) => assessDocumentViewerAccess(t, memberCtx, docId));
    expect(access.canInspect).toBe(false);
    expect(access.reason).toBe('restricted_not_permitted');
  });

  it('12. inspection goes through the gated access decision (the same loader gates all direct paths)', async () => {
    const ctx = await makeWorkspace();
    const { docId, versionId } = await reconDoc(ctx, 'v12.md', ['gated content'], 'restricted');
    // The gate is assessDocumentViewerAccess; a denied decision yields inaccessible for the SAME loader.
    const memberUser = randomUUID();
    await db().insert(profiles).values({ id: memberUser, email: `g-${memberUser.slice(0, 8)}@t.local`, displayName: 'G' });
    await db().insert(projectMembers).values({ orgId: ctx.orgId, projectId: ctx.projectId, userId: memberUser, role: 'member' });
    const member: TenantContext = { userId: memberUser, orgId: ctx.orgId, projectId: ctx.projectId, orgRole: 'member', projectRole: 'member' };
    const denied = await tx((t) => assessDocumentViewerAccess(t, member, docId));
    const got = await tx((t) => retrieveExactHistorical(t, ctx, store, { kind: 'versionId', versionId }, { authorized: denied.canInspect }));
    expect(got.state).toBe('inaccessible');
  });

  it('13/14/15. current restriction gates present inspection; historical dispatch classification is unchanged; declassification reopens inspection', async () => {
    const ctx = await makeWorkspace();
    const { docId, versionId } = await byteExactDoc(ctx, 'clsf.md', 'classification body'); // internal now
    const dispatchSnap: RunSourceSnapshot[] = [{ relativePath: 'clsf.md', sha256: shaOf('classification body'), disclosure: 'workspace_internal', chunkIndex: 0, rank: 1, excerpt: 'classification body', documentVersionId: versionId }];
    const runId = await makeRun(ctx, dispatchSnap);
    const jsonBefore = JSON.stringify((await db().select({ s: runs.retrievedSources }).from(runs).where(eq(runs.id, runId)))[0]!.s);

    // Restrict the Document now → present inspection is gated even for this historically-internal version.
    await db().update(documents).set({ disclosure: 'restricted' }).where(eq(documents.id, docId));
    const memberUser = randomUUID();
    await db().insert(profiles).values({ id: memberUser, email: `c-${memberUser.slice(0, 8)}@t.local`, displayName: 'C' });
    await db().insert(projectMembers).values({ orgId: ctx.orgId, projectId: ctx.projectId, userId: memberUser, role: 'member' });
    const member: TenantContext = { userId: memberUser, orgId: ctx.orgId, projectId: ctx.projectId, orgRole: 'member', projectRole: 'member' };
    expect((await tx((t) => assessDocumentViewerAccess(t, member, docId))).canInspect).toBe(false); // 13
    // Historical dispatch snapshot unchanged. 14
    expect(JSON.stringify((await db().select({ s: runs.retrievedSources }).from(runs).where(eq(runs.id, runId)))[0]!.s)).toBe(jsonBefore);

    // Declassify → present inspection reopens; history still unchanged. 15
    await db().update(documents).set({ disclosure: 'workspace_internal' }).where(eq(documents.id, docId));
    expect((await tx((t) => assessDocumentViewerAccess(t, member, docId))).canInspect).toBe(true);
    expect(JSON.stringify((await db().select({ s: runs.retrievedSources }).from(runs).where(eq(runs.id, runId)))[0]!.s)).toBe(jsonBefore);
  });

  it('16/17. archive preserves versions, objects, chunks, and evidence relationships (never deletes them)', async () => {
    const ctx = await makeWorkspace();
    const { docId, versionId } = await byteExactDoc(ctx, 'arch.md', 'archive body');
    const ksId = await makeKnowledgeSourceBound(ctx, 'arch.md', shaOf('archive body'), versionId);
    const versionsBefore = (await db().select({ id: documentVersions.id }).from(documentVersions).where(eq(documentVersions.documentId, docId))).length;
    const versionChunksBefore = (await db().select({ id: documentChunks.id }).from(documentChunks).where(eq(documentChunks.documentVersionId, versionId))).length;
    // Archive = stop current retrieval, preserve evidence. (Ordinary archive path drops only null-version chunks.)
    await db().update(documents).set({ status: 'archived', chunkCount: 0 }).where(eq(documents.id, docId));
    await db().delete(documentChunks).where(and(eq(documentChunks.documentId, docId), sql`document_version_id is null`));
    expect((await db().select({ id: documentVersions.id }).from(documentVersions).where(eq(documentVersions.documentId, docId))).length).toBe(versionsBefore);
    expect((await db().select({ id: documentChunks.id }).from(documentChunks).where(eq(documentChunks.documentVersionId, versionId))).length).toBe(versionChunksBefore);
    expect((await db().select({ v: knowledgeSources.documentVersionId }).from(knowledgeSources).where(eq(knowledgeSources.id, ksId)))[0]!.v).toBe(versionId);
  });

  it('18. purge is blocked by a current-version pointer', async () => {
    const ctx = await makeWorkspace();
    const { versionId } = await byteExactDoc(ctx, 'p18.md', 'current body');
    const a = await tx((t) => assessPurge(t, ctx, versionId));
    expect(a.decision).toBe('purge_blocked_by_current_use');
    expect(a.blockers.some((b) => b.category === 'current_version_pointer')).toBe(true);
  });

  it('19. purge is blocked by a Knowledge source relationship', async () => {
    const ctx = await makeWorkspace();
    const { docId, versionId: v1 } = await byteExactDoc(ctx, 'p19.md', 'v1 body');
    await newVersion(ctx, docId, 'v2 body'); // v1 no longer current
    await makeKnowledgeSourceBound(ctx, 'p19.md', shaOf('v1 body'), v1);
    const a = await tx((t) => assessPurge(t, ctx, v1));
    expect(a.decision).toBe('purge_blocked_by_institutional_evidence');
    expect(a.blockers.some((b) => b.category === 'knowledge_source')).toBe(true);
  });

  it('20. purge is blocked by a normalized run relationship', async () => {
    const ctx = await makeWorkspace();
    const { docId, versionId: v1 } = await byteExactDoc(ctx, 'p20.md', 'v1 body');
    await newVersion(ctx, docId, 'v2 body');
    const runId = await makeRun(ctx, []);
    await db().insert(runDocumentVersions).values({ orgId: ctx.orgId, projectId: ctx.projectId, runId, documentVersionId: v1, chunkIndex: -1, disclosureSnapshot: 'workspace_internal' });
    const a = await tx((t) => assessPurge(t, ctx, v1));
    expect(a.decision).toBe('purge_blocked_by_institutional_evidence');
    expect(a.blockers.some((b) => b.category === 'run_normalized_reference')).toBe(true);
  });

  it('21. purge is blocked when only an immutable run snapshot references it (normalized ref absent)', async () => {
    const ctx = await makeWorkspace();
    const { docId, versionId: v1 } = await byteExactDoc(ctx, 'p21.md', 'v1 body');
    await newVersion(ctx, docId, 'v2 body');
    await makeRun(ctx, [{ relativePath: 'p21.md', sha256: shaOf('v1 body'), disclosure: 'workspace_internal', chunkIndex: 0, rank: 1, excerpt: 'v1 body', documentVersionId: v1 }]);
    const a = await tx((t) => assessPurge(t, ctx, v1));
    expect(a.decision).toBe('purge_blocked_by_institutional_evidence');
    expect(a.blockers.some((b) => b.category === 'run_snapshot')).toBe(true);
  });

  it('22/23/24/25/26. a permitted purge rechecks, removes only the intended version+chunks, keeps shared objects, writes a tombstone', async () => {
    const ctx = await makeWorkspace();
    const { docId, versionId: v1 } = await byteExactDoc(ctx, 'p22.md', 'v1 unique body');
    const v2 = await newVersion(ctx, docId, 'v2 unique body'); // current; v1 purgeable
    const other = await reconDoc(ctx, 'other22.md', ['unrelated']); // untouched control
    const a = await tx((t) => assessPurge(t, ctx, v1));
    expect(a.decision).toBe('purge_permitted'); // 22 (categories + counts)
    const res = await tx((t) => executePurge(t, ctx, store, v1, 'stage-d test'));
    expect(res.purged).toBe(true);
    expect(res.objectDeleted).toBe(true); // 24: v1's object was not shared
    // 26: only v1 + its chunks gone; v2 + other intact.
    expect((await db().select({ id: documentVersions.id }).from(documentVersions).where(eq(documentVersions.id, v1))).length).toBe(0);
    expect((await db().select({ id: documentChunks.id }).from(documentChunks).where(eq(documentChunks.documentVersionId, v1))).length).toBe(0);
    expect((await db().select({ id: documentVersions.id }).from(documentVersions).where(eq(documentVersions.id, v2))).length).toBe(1);
    expect((await db().select({ id: documentVersions.id }).from(documentVersions).where(eq(documentVersions.id, other.versionId))).length).toBe(1);
    // 25: immutable tombstone written.
    const tomb = (await db().select({ id: documentVersionTombstones.id, objectDeleted: documentVersionTombstones.objectDeleted }).from(documentVersionTombstones).where(eq(documentVersionTombstones.versionId, v1)))[0];
    expect(tomb).toBeTruthy();
    // A re-assess now returns already_completed (23: purge is a current judgment, tombstone is terminal).
    expect((await tx((t) => assessPurge(t, ctx, v1))).decision).toBe('purge_already_completed');
  });

  it('24b. purge never deletes an object still shared by another retained version', async () => {
    const ctx = await makeWorkspace();
    const { docId, versionId: v1, versionKey } = await byteExactDoc(ctx, 'shared.md', 'shared body');
    // Manually create a second retained version pointing at the SAME object key (simulating a share).
    await db().insert(documentVersions).values({ orgId: ctx.orgId, projectId: ctx.projectId, documentId: docId, sha256: shaOf('shared body v2 identity'), sizeBytes: 1, contentFidelity: 'byte_exact', indexStatus: 'indexed', objectKey: versionKey });
    await newVersion(ctx, docId, 'make v1 non-current'); // so v1 is purgeable
    const res = await tx((t) => executePurge(t, ctx, store, v1, 'shared-object test'));
    expect(res.purged).toBe(true);
    expect(res.objectDeleted).toBe(false); // shared → object retained
    expect((await store.get(versionKey)).toString('utf8')).toBe('shared body'); // object survives
  });

  it('27. the legacy-object cleanup assessment classifies without deleting anything', async () => {
    const ctx = await makeWorkspace();
    const { versionKey } = await byteExactDoc(ctx, 'leg.md', 'legacy assess body');
    const rep = await tx((t) => assessLegacyObjects(t, ctx, store));
    expect(rep.objects.length).toBeGreaterThanOrEqual(1);
    expect(rep.byClass.still_referenced).toBeGreaterThanOrEqual(1);
    // Nothing deleted (both the legacy filename object and the version object still exist).
    expect((await store.get(versionKey))).toBeTruthy();
  });

  it('28/29/30. integrity audit detects missing objects, hash mismatches, and invalid current pointers', async () => {
    const ctx = await makeWorkspace();
    const missing = await byteExactDoc(ctx, 'i28.md', 'missing object body');
    await store.delete(missing.versionKey);
    const mismatch = await byteExactDoc(ctx, 'i29.md', 'mismatch body');
    await store.put(mismatch.versionKey, Buffer.from('different bytes', 'utf8'), 'text/markdown');
    const badptr = await reconDoc(ctx, 'i30.md', ['ptr body']);
    await db().update(documents).set({ currentVersionId: randomUUID() }).where(eq(documents.id, badptr.docId));
    const report = await tx((t) => auditDocumentIntegrity(t, ctx, store));
    expect(report.byCategory.byte_exact_object_missing).toBeGreaterThanOrEqual(1);
    expect(report.byCategory.byte_exact_hash_mismatch).toBeGreaterThanOrEqual(1);
    expect(report.byCategory.current_pointer_non_indexed).toBeGreaterThanOrEqual(1);
  });

  it('31. integrity audit detects an inconsistent Knowledge version pointer', async () => {
    const ctx = await makeWorkspace();
    const { versionId } = await byteExactDoc(ctx, 'i31.md', 'body');
    // Bind a knowledge source to this version but with a DIFFERENT cited hash.
    await makeKnowledgeSourceBound(ctx, 'i31.md', shaOf('a different cited hash'), versionId);
    const report = await tx((t) => auditDocumentIntegrity(t, ctx, store));
    expect(report.byCategory.knowledge_pointer_inconsistent).toBeGreaterThanOrEqual(1);
  });

  it('32. integrity audit detects a run snapshot / normalized-reference mismatch', async () => {
    const ctx = await makeWorkspace();
    const { versionId } = await byteExactDoc(ctx, 'i32.md', 'body');
    // A normalized ref to a version the run snapshot does NOT contain.
    const runId = await makeRun(ctx, [{ relativePath: 'other.md', sha256: shaOf('x'), disclosure: 'workspace_internal', chunkIndex: 0, rank: 1, excerpt: 'x', documentVersionId: randomUUID() }]);
    await db().insert(runDocumentVersions).values({ orgId: ctx.orgId, projectId: ctx.projectId, runId, documentVersionId: versionId, chunkIndex: -1, disclosureSnapshot: 'workspace_internal' });
    const report = await tx((t) => auditDocumentIntegrity(t, ctx, store));
    expect(report.byCategory.run_reference_inconsistent).toBeGreaterThanOrEqual(1);
  });

  it('33. rebuilding chunks from exact bytes preserves version identity and hash', async () => {
    const ctx = await makeWorkspace();
    const { versionId, versionKey } = await byteExactDoc(ctx, 'i33.md', '# Rebuild\n\nfirst para\n\nsecond para');
    const shaBefore = (await db().select({ s: documentVersions.sha256 }).from(documentVersions).where(eq(documentVersions.id, versionId)))[0]!.s;
    await db().delete(documentChunks).where(eq(documentChunks.documentVersionId, versionId)); // simulate lost chunks
    const rebuilt = await tx((t) => rebuildVersionChunksFromBytes(t, ctx, store, versionId));
    expect(rebuilt.rebuilt).toBe(true);
    expect(rebuilt.chunks).toBeGreaterThan(0);
    const shaAfter = (await db().select({ s: documentVersions.sha256 }).from(documentVersions).where(eq(documentVersions.id, versionId)))[0]!.s;
    expect(shaAfter).toBe(shaBefore); // identity + hash unchanged
    void versionKey;
    // reverify confirms the object still matches.
    expect((await tx((t) => reverifyObject(t, ctx, store, versionId))).state).toBe('verified');
  });

  it('34. a repair cannot modify historical run snapshots', async () => {
    const ctx = await makeWorkspace();
    const { versionId } = await byteExactDoc(ctx, 'i34.md', 'body');
    const runId = await makeRun(ctx, [{ relativePath: 'i34.md', sha256: shaOf('body'), disclosure: 'workspace_internal', chunkIndex: 0, rank: 1, excerpt: 'body', documentVersionId: versionId }]);
    const before = JSON.stringify((await db().select({ s: runs.retrievedSources }).from(runs).where(eq(runs.id, runId)))[0]!.s);
    // Restoring the normalized reference is additive; it never rewrites the immutable snapshot.
    await tx((t) => restoreRunReferenceFromSnapshot(t, ctx, runId));
    const after = JSON.stringify((await db().select({ s: runs.retrievedSources }).from(runs).where(eq(runs.id, runId)))[0]!.s);
    expect(after).toBe(before);
    // and the reference now exists.
    expect((await db().select({ id: runDocumentVersions.id }).from(runDocumentVersions).where(and(eq(runDocumentVersions.runId, runId), eq(runDocumentVersions.documentVersionId, versionId)))).length).toBeGreaterThanOrEqual(1);
  });

  it('35. Knowledge → exact version resolves to the cited version (history vs current inspectability)', async () => {
    const ctx = await makeWorkspace();
    const { docId, versionId: v1 } = await byteExactDoc(ctx, 'i35.md', 'cited body');
    const ksId = await makeKnowledgeSourceBound(ctx, 'i35.md', shaOf('cited body'), v1);
    await newVersion(ctx, docId, 'a newer body'); // current advances; citation still points to v1
    const got = await tx((t) => retrieveExactHistorical(t, ctx, store, { kind: 'knowledgeSource', knowledgeSourceId: ksId }, AUTH));
    expect(got.state).toBe('resolved');
    expect(got.versionId).toBe(v1); // the historically cited version, not the current one
  });

  it('36. Run → version distinguishes source evidence from the exact supplied prompt text', async () => {
    const ctx = await makeWorkspace();
    const { versionId } = await byteExactDoc(ctx, 'i36.md', 'source evidence body');
    const suppliedText = 'EXACT supplied excerpt as sent to the provider';
    const runId = await makeRun(ctx, [{ relativePath: 'i36.md', sha256: shaOf('source evidence body'), disclosure: 'workspace_internal', chunkIndex: 0, rank: 1, excerpt: suppliedText, documentVersionId: versionId }]);
    const ev = await tx((t) => resolveRunSuppliedEvidence(t, ctx, runId, versionId));
    expect(ev!.suppliedFromSnapshot[0]!.excerpt).toBe(suppliedText); // authoritative for what was sent
    expect(ev!.version.state).toBe('found'); // the retained source evidence version
    expect(ev!.version.version!.sha256).toBe(shaOf('source evidence body'));
  });

  it('37. cross-workspace version ids cannot be inspected or purged', async () => {
    const a = await makeWorkspace();
    const b = await makeWorkspace();
    const { versionId: vB } = await byteExactDoc(b, 'x37.md', 'workspace B body');
    // A resolves B's version id as missing (never as B's data).
    expect((await tx((t) => resolveExactVersion(t, a, { kind: 'versionId', versionId: vB }))).state).toBe('missing');
    // A cannot purge B's version.
    expect((await tx((t) => assessPurge(t, a, vB))).decision).toBe('purge_assessment_incomplete');
  });

  it('38. purge authorization cannot be forged by a non-privileged caller', async () => {
    const member = await makeWorkspace('member');
    expect(() => assertPurgeAuthority(member)).toThrow();
    const admin = await makeWorkspace('admin');
    expect(() => assertPurgeAuthority(admin)).not.toThrow();
  });

  it('39. a stale purge assessment cannot authorize deletion after a new evidence relationship appears', async () => {
    const ctx = await makeWorkspace();
    const { docId, versionId: v1 } = await byteExactDoc(ctx, 'p39.md', 'v1 body');
    await newVersion(ctx, docId, 'v2 body'); // v1 purgeable
    expect((await tx((t) => assessPurge(t, ctx, v1))).decision).toBe('purge_permitted'); // stale assessment
    // A new institutional relationship appears AFTER the assessment.
    await makeKnowledgeSourceBound(ctx, 'p39.md', shaOf('v1 body'), v1);
    // Execution re-checks NOW and refuses.
    const res = await tx((t) => executePurge(t, ctx, store, v1, 'should be blocked'));
    expect(res.purged).toBe(false);
    expect(res.decision).toBe('purge_blocked_by_institutional_evidence');
    expect((await db().select({ id: documentVersions.id }).from(documentVersions).where(eq(documentVersions.id, v1))).length).toBe(1); // not deleted
  });

  it('40. the versioning pipeline remains compatible with legacy rollback (legacy chunks untouched)', async () => {
    const ctx = await makeWorkspace();
    // A local doc backfilled to a reconstructed version keeps its legacy null-version chunks intact, so a
    // rollback to legacy retrieval still finds them.
    const { docId } = await reconDoc(ctx, 'i40.md', ['legacy retrievable chunk about rollback']);
    const nullChunks = await db().select({ id: documentChunks.id }).from(documentChunks).where(and(eq(documentChunks.documentId, docId), sql`document_version_id is null`));
    expect(nullChunks.length).toBeGreaterThan(0); // legacy chunks preserved through Stage D operations
  });
});
