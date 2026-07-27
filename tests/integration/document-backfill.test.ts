import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type KnowledgeDisclosure, type RunSourceSnapshot, type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { agents, documentChunks, documentVersions, documents, knowledgeItems, knowledgeSources, memberships, organizations, profiles, projectMembers, projects, runDocumentVersions, runs, tasks } from '@/db/schema';
import { refreshIndex, retrieveRelevant } from '@/domain/documents/documents';
import { backfillProject } from '@/domain/documents/backfill';
import { isVersionReferenced, runsReferencingVersion } from '@/domain/documents/references';
import { LocalObjectStore } from '@/domain/documents/local-object-store';
import { tenantObjectKey } from '@/domain/documents/object-store';
import { versionObjectKey } from '@/domain/documents/versions';

/**
 * Documents increment 1, Stage C1 — backfill, fidelity classification, evidence-reference reconciliation,
 * and audit. The 27 required C1 tests. Backfill runs through the migration-role connection exactly as the
 * script does; the object store is the hermetic LocalObjectStore.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';

let available = false;
try {
  await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1);
  available = true;
} catch (err) {
  console.warn(`[document-backfill.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`);
}

let storeDir = '';
let store: LocalObjectStore;
let orgId = '';
let userId = '';

const db = () => getSetupDb();
const shaOf = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

async function makeWorkspace(): Promise<TenantContext> {
  const p = await db().insert(projects).values({ orgId, key: fixtureKey('c1'), name: 'C1 WS' }).returning({ id: projects.id });
  await db().insert(projectMembers).values({ orgId, projectId: p[0]!.id, userId, role: 'admin' });
  return { userId, orgId, projectId: p[0]!.id, orgRole: 'owner', projectRole: 'admin' };
}

async function setFolder(ctx: TenantContext, path: string): Promise<void> {
  await db().update(projects).set({ documentFolderPath: path }).where(eq(projects.id, ctx.projectId));
}

async function makeDoc(
  ctx: TenantContext,
  o: { source?: 'local_folder' | 'cloud_upload'; relPath: string; body?: string; sha?: string; status?: string; objectKey?: string | null; mimeType?: string; sizeBytes?: number; disclosure?: KnowledgeDisclosure },
): Promise<string> {
  const sha = o.sha ?? (o.body ? shaOf(o.body) : 'seed');
  const ins = await db()
    .insert(documents)
    .values({
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      source: o.source ?? 'local_folder',
      sourceId: (o.source ?? 'local_folder') === 'cloud_upload' ? o.relPath : o.relPath,
      relativePath: o.relPath,
      kind: 'markdown',
      sha256: sha,
      sizeBytes: o.sizeBytes ?? (o.body ? Buffer.byteLength(o.body, 'utf8') : 10),
      status: (o.status ?? 'active') as 'active',
      objectKey: o.objectKey ?? null,
      mimeType: o.mimeType ?? 'text/markdown',
      disclosure: o.disclosure ?? 'workspace_internal',
    })
    .returning({ id: documents.id });
  return ins[0]!.id;
}

async function addLegacyChunks(ctx: TenantContext, docId: string, contents: string[]): Promise<void> {
  if (contents.length === 0) return;
  await db()
    .insert(documentChunks)
    .values(contents.map((content, i) => ({ orgId: ctx.orgId, projectId: ctx.projectId, documentId: docId, chunkIndex: i, content })));
  await db().update(documents).set({ chunkCount: contents.length, indexedAt: new Date() }).where(eq(documents.id, docId));
}

async function runBackfill(ctx: TenantContext) {
  return db().transaction((t) => backfillProject(t, ctx, store, { operationId: randomUUID() }));
}

async function versionsOf(docId: string) {
  return db()
    .select({ id: documentVersions.id, sha: documentVersions.sha256, status: documentVersions.indexStatus, fidelity: documentVersions.contentFidelity, key: documentVersions.objectKey })
    .from(documentVersions)
    .where(eq(documentVersions.documentId, docId));
}
async function versionChunksOf(versionId: string) {
  return db()
    .select({ idx: documentChunks.chunkIndex, content: documentChunks.content })
    .from(documentChunks)
    .where(eq(documentChunks.documentVersionId, versionId))
    .orderBy(documentChunks.chunkIndex);
}
async function nullVersionChunkCount(docId: string): Promise<number> {
  const r = await db().select({ id: documentChunks.id }).from(documentChunks).where(and(eq(documentChunks.documentId, docId), isNull(documentChunks.documentVersionId)));
  return r.length;
}
async function currentOf(docId: string): Promise<string | null> {
  const r = await db().select({ c: documents.currentVersionId }).from(documents).where(eq(documents.id, docId));
  return r[0]!.c ?? null;
}

async function makeKnowledgeSource(ctx: TenantContext, o: { sourceRef: string; sourceVersionHash: string }): Promise<string> {
  const ki = await db().insert(knowledgeItems).values({ orgId: ctx.orgId, projectId: ctx.projectId, title: 'k', body: 'b', createdBy: ctx.userId }).returning({ id: knowledgeItems.id });
  const ks = await db()
    .insert(knowledgeSources)
    .values({ orgId: ctx.orgId, projectId: ctx.projectId, knowledgeItemId: ki[0]!.id, knowledgeVersion: 1, sourceType: 'document', sourceRef: o.sourceRef, sourceLabel: o.sourceRef, sourceVersionHash: o.sourceVersionHash, transformation: 'quoted' })
    .returning({ id: knowledgeSources.id });
  return ks[0]!.id;
}

async function makeRun(ctx: TenantContext, snapshot: RunSourceSnapshot[]): Promise<string> {
  const a = await db().insert(agents).values({ orgId: ctx.orgId, projectId: ctx.projectId, name: 'a', role: 'primary', provider: 'openai', model: 'm', systemPrompt: 'x' }).returning({ id: agents.id });
  const t = await db().insert(tasks).values({ orgId: ctx.orgId, projectId: ctx.projectId, title: 't', input: 'x', providerSelection: 'openai', status: 'completed', createdBy: ctx.userId }).returning({ id: tasks.id });
  const r = await db().insert(runs).values({ orgId: ctx.orgId, projectId: ctx.projectId, taskId: t[0]!.id, status: 'completed', primaryAgentId: a[0]!.id, retrievedSources: snapshot }).returning({ id: runs.id });
  return r[0]!.id;
}

function snap(relativePath: string, sha256: string, chunkIndex = 0): RunSourceSnapshot {
  return { relativePath, sha256, disclosure: 'workspace_internal', chunkIndex, rank: 1, excerpt: 'x' };
}

beforeAll(async () => {
  if (!available) return;
  storeDir = await mkdtemp(join(tmpdir(), 'c1-store-'));
  process.env.LOCAL_OBJECT_STORE_DIR = storeDir;
  store = new LocalObjectStore(storeDir);
  userId = randomUUID();
  await db().insert(profiles).values({ id: userId, email: `c1-${randomUUID().slice(0, 8)}@t.local`, displayName: 'C1' });
  const org = await db().insert(organizations).values({ name: 'C1 Org', slug: `c1-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id });
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

describe.skipIf(!available)('Stage C1 — backfill + fidelity + reconciliation', () => {
  it('1. backfill is idempotent across repeated executions', async () => {
    const ctx = await makeWorkspace();
    const folder = await mkdtemp(join(tmpdir(), 'c1-f1-'));
    await setFolder(ctx, folder);
    const body = '# Doc\n\nStable content for idempotency.';
    await writeFile(join(folder, 'a.md'), body);
    const docId = await makeDoc(ctx, { relPath: 'a.md', body });
    await addLegacyChunks(ctx, docId, ['# Doc', 'Stable content for idempotency.']);

    const first = await runBackfill(ctx);
    expect(first.versions.created).toBe(1);
    const vAfter1 = await versionsOf(docId);
    const chunks1 = await versionChunksOf(vAfter1[0]!.id);

    const second = await runBackfill(ctx);
    expect(second.versions.created).toBe(0);
    expect(second.idempotency.skippedAlreadyReconciled).toBe(1);
    const vAfter2 = await versionsOf(docId);
    expect(vAfter2.length).toBe(1); // no duplicate version
    expect((await versionChunksOf(vAfter2[0]!.id)).length).toBe(chunks1.length); // no duplicate chunks
    await rm(folder, { recursive: true, force: true });
  });

  it('2. an interrupted backfill resumes without duplication', async () => {
    const ctx = await makeWorkspace();
    const docId = await makeDoc(ctx, { relPath: 'resume.md', sha: shaOf('gone') });
    await addLegacyChunks(ctx, docId, ['one', 'two', 'three']);
    // Simulate a crash mid-migration: chunks are copied while the version is still `pending` and current
    // is not yet set (that transition happens AFTER chunk copy). Construct exactly that partial state.
    const pending = await db()
      .insert(documentVersions)
      .values({ orgId: ctx.orgId, projectId: ctx.projectId, documentId: docId, sha256: shaOf('gone'), sizeBytes: 3, contentFidelity: 'reconstructed_text', indexStatus: 'pending', parserVersion: 'chunk-v1' })
      .returning({ id: documentVersions.id });
    const vId = pending[0]!.id;
    await db().insert(documentChunks).values([
      { orgId: ctx.orgId, projectId: ctx.projectId, documentId: docId, documentVersionId: vId, chunkIndex: 0, content: 'one', parserVersion: 'chunk-v1' },
      { orgId: ctx.orgId, projectId: ctx.projectId, documentId: docId, documentVersionId: vId, chunkIndex: 1, content: 'two', parserVersion: 'chunk-v1' },
    ]);
    expect((await versionChunksOf(vId)).length).toBe(2); // partial

    // Resume: the same (documentId, sha) version is reused; chunks repaired to the full legacy set,
    // status advanced to indexed, current assigned — no duplicate version.
    await runBackfill(ctx);
    expect((await versionsOf(docId)).length).toBe(1);
    const repaired = await versionChunksOf(vId);
    expect(repaired.map((c) => c.content)).toEqual(['one', 'two', 'three']);
    expect((await versionsOf(docId))[0]!.status).toBe('indexed');
    expect(await currentOf(docId)).toBe(vId);
  });

  it('3. existing cloud bytes become byte_exact only after hash verification', async () => {
    const ctx = await makeWorkspace();
    const body = '# Cloud\n\nExact bytes retained.';
    const key = tenantObjectKey({ orgId: ctx.orgId, projectId: ctx.projectId, sourceId: 'c.md', versionHash: shaOf(body) });
    await store.put(key, Buffer.from(body, 'utf8'), 'text/markdown');
    const docId = await makeDoc(ctx, { source: 'cloud_upload', relPath: 'c.md', body, objectKey: key });
    await addLegacyChunks(ctx, docId, ['# Cloud', 'Exact bytes retained.']);
    const rep = await runBackfill(ctx);
    const v = (await versionsOf(docId))[0]!;
    expect(v.fidelity).toBe('byte_exact');
    expect(rep.storage.objectsCreated).toBeGreaterThanOrEqual(1);
    // The version object holds the exact bytes.
    expect((await store.get(versionObjectKey(ctx, docId, shaOf(body)))).equals(Buffer.from(body, 'utf8'))).toBe(true);
  });

  it('4. a cloud object with a mismatched hash is NOT labeled byte_exact', async () => {
    const ctx = await makeWorkspace();
    const key = tenantObjectKey({ orgId: ctx.orgId, projectId: ctx.projectId, sourceId: 'm.md', versionHash: 'recorded' });
    await store.put(key, Buffer.from('DIFFERENT bytes than the recorded hash', 'utf8'), 'text/markdown');
    const docId = await makeDoc(ctx, { source: 'cloud_upload', relPath: 'm.md', sha: shaOf('the recorded content'), objectKey: key });
    await addLegacyChunks(ctx, docId, ['recorded chunk text']);
    const rep = await runBackfill(ctx);
    const v = (await versionsOf(docId))[0]!;
    expect(v.fidelity).toBe('reconstructed_text');
    expect(rep.storage.hashMismatches).toBeGreaterThanOrEqual(1);
  });

  it('5. a local source with matching current bytes becomes byte_exact', async () => {
    const ctx = await makeWorkspace();
    const folder = await mkdtemp(join(tmpdir(), 'c1-f5-'));
    await setFolder(ctx, folder);
    const body = '# Local\n\nMatches the indexed hash.';
    await writeFile(join(folder, 'l.md'), body);
    const docId = await makeDoc(ctx, { relPath: 'l.md', body });
    await addLegacyChunks(ctx, docId, ['# Local', 'Matches the indexed hash.']);
    await runBackfill(ctx);
    const v = (await versionsOf(docId))[0]!;
    expect(v.fidelity).toBe('byte_exact');
    expect((await store.get(versionObjectKey(ctx, docId, shaOf(body)))).equals(Buffer.from(body, 'utf8'))).toBe(true);
    await rm(folder, { recursive: true, force: true });
  });

  it('6. a local source with changed current bytes does not claim those bytes are the legacy version', async () => {
    const ctx = await makeWorkspace();
    const folder = await mkdtemp(join(tmpdir(), 'c1-f6-'));
    await setFolder(ctx, folder);
    await writeFile(join(folder, 'chg.md'), 'CURRENT on-disk content, different from indexed');
    const docId = await makeDoc(ctx, { relPath: 'chg.md', sha: shaOf('the ORIGINAL indexed content') });
    await addLegacyChunks(ctx, docId, ['original indexed chunk']);
    const rep = await runBackfill(ctx);
    const v = (await versionsOf(docId))[0]!;
    expect(v.fidelity).toBe('reconstructed_text');
    expect(rep.integrity.localChangedSinceIndex).toBeGreaterThanOrEqual(1);
    // No object was retained for the legacy hash from the changed bytes.
    await expect(store.get(versionObjectKey(ctx, docId, shaOf('the ORIGINAL indexed content')))).rejects.toThrow();
    await rm(folder, { recursive: true, force: true });
  });

  it('7. a local legacy doc with chunks but no exact bytes becomes reconstructed_text', async () => {
    const ctx = await makeWorkspace(); // no folder linked → source not readable
    const docId = await makeDoc(ctx, { relPath: 'r.md', sha: shaOf('gone') });
    await addLegacyChunks(ctx, docId, ['still-inspectable chunk text']);
    await runBackfill(ctx);
    const v = (await versionsOf(docId))[0]!;
    expect(v.fidelity).toBe('reconstructed_text');
    expect(v.key).toBeNull(); // no object masquerading as the original
  });

  it('8. a doc with neither bytes nor sufficient chunks becomes unavailable + source_unavailable', async () => {
    const ctx = await makeWorkspace();
    const docId = await makeDoc(ctx, { relPath: 'u.md', sha: shaOf('nothing'), status: 'active' });
    // no chunks
    const rep = await runBackfill(ctx);
    const v = (await versionsOf(docId))[0]!;
    expect(v.fidelity).toBe('unavailable');
    expect(v.status).toBe('failed'); // terminal version, never current
    expect(v.key).toBeNull();
    // The logical Document cannot remain active without a retrievable current version.
    const doc = (await db().select({ s: documents.status }).from(documents).where(eq(documents.id, docId)))[0]!;
    expect(doc.s).toBe('source_unavailable');
    expect(rep.stateCorrections.toSourceUnavailable).toBeGreaterThanOrEqual(1);
  });

  it('9. reconstructed chunks retain their original ordering and text', async () => {
    const ctx = await makeWorkspace();
    const docId = await makeDoc(ctx, { relPath: 'ord.md', sha: shaOf('gone') });
    const contents = ['alpha', 'bravo', 'charlie', 'delta'];
    await addLegacyChunks(ctx, docId, contents);
    await runBackfill(ctx);
    const v = (await versionsOf(docId))[0]!;
    const vc = await versionChunksOf(v.id);
    expect(vc.map((c) => c.content)).toEqual(contents);
    expect(vc.map((c) => c.idx)).toEqual([0, 1, 2, 3]);
  });

  it('10. an unavailable version does not become current', async () => {
    const ctx = await makeWorkspace();
    const docId = await makeDoc(ctx, { relPath: 'u2.md', sha: shaOf('nothing') });
    await runBackfill(ctx);
    expect(await currentOf(docId)).toBeNull();
  });

  it('11. a valid reconstructed legacy version may preserve current retrieval during transition', async () => {
    const ctx = await makeWorkspace();
    const docId = await makeDoc(ctx, { relPath: 'rc.md', sha: shaOf('gone'), status: 'active' });
    await addLegacyChunks(ctx, docId, ['reconstructable text']);
    await runBackfill(ctx);
    const v = (await versionsOf(docId))[0]!;
    expect(v.fidelity).toBe('reconstructed_text');
    expect(await currentOf(docId)).toBe(v.id); // reconstructed may be current
  });

  it('12. same path + different hash does not backfill a Knowledge pointer', async () => {
    const ctx = await makeWorkspace();
    const docId = await makeDoc(ctx, { relPath: 'k1.md', body: 'current content H1' });
    await addLegacyChunks(ctx, docId, ['H1']);
    await runBackfill(ctx); // creates a version at hash(H1)
    const ksId = await makeKnowledgeSource(ctx, { sourceRef: 'k1.md', sourceVersionHash: shaOf('an OLDER version H2') });
    const rep = await runBackfill(ctx);
    const ks = (await db().select({ v: knowledgeSources.documentVersionId }).from(knowledgeSources).where(eq(knowledgeSources.id, ksId)))[0]!;
    expect(ks.v).toBeNull();
    expect(rep.knowledgeRefs.unresolvedByReason['expected_version_unavailable']).toBeGreaterThanOrEqual(1);
    void docId;
  });

  it('13. same hash in another workspace does not backfill a pointer', async () => {
    const wsA = await makeWorkspace();
    const wsB = await makeWorkspace();
    const shared = shaOf('shared content');
    const docB = await makeDoc(wsB, { relPath: 'shared.md', body: 'shared content' });
    await addLegacyChunks(wsB, docB, ['shared content']);
    await runBackfill(wsB); // B has a version at `shared`
    // A cites the same hash but has NO such document.
    const ksId = await makeKnowledgeSource(wsA, { sourceRef: 'shared.md', sourceVersionHash: shared });
    await runBackfill(wsA);
    const ks = (await db().select({ v: knowledgeSources.documentVersionId }).from(knowledgeSources).where(eq(knowledgeSources.id, ksId)))[0]!;
    expect(ks.v).toBeNull();
  });

  it('14. an exact Knowledge identity + hash match backfills exactly one version pointer', async () => {
    const ctx = await makeWorkspace();
    const body = 'cited content';
    const docId = await makeDoc(ctx, { relPath: 'cite.md', body });
    await addLegacyChunks(ctx, docId, [body]);
    await runBackfill(ctx);
    const ksId = await makeKnowledgeSource(ctx, { sourceRef: 'cite.md', sourceVersionHash: shaOf(body) });
    await runBackfill(ctx);
    const ks = (await db().select({ v: knowledgeSources.documentVersionId }).from(knowledgeSources).where(eq(knowledgeSources.id, ksId)))[0]!;
    const v = (await versionsOf(docId))[0]!;
    expect(ks.v).toBe(v.id);
  });

  it('15. ambiguous Knowledge matches remain unresolved', async () => {
    const ctx = await makeWorkspace();
    const body = 'ambiguous content';
    // Two documents with the SAME relativePath (a cloud + a local) — path is ambiguous.
    const dLocal = await makeDoc(ctx, { source: 'local_folder', relPath: 'amb.md', body });
    await addLegacyChunks(ctx, dLocal, [body]);
    const dCloud = await makeDoc(ctx, { source: 'cloud_upload', relPath: 'amb.md', body });
    await addLegacyChunks(ctx, dCloud, [body]);
    await runBackfill(ctx);
    const ksId = await makeKnowledgeSource(ctx, { sourceRef: 'amb.md', sourceVersionHash: shaOf(body) });
    const rep = await runBackfill(ctx);
    const ks = (await db().select({ v: knowledgeSources.documentVersionId }).from(knowledgeSources).where(eq(knowledgeSources.id, ksId)))[0]!;
    expect(ks.v).toBeNull();
    expect(rep.knowledgeRefs.unresolvedByReason['ambiguous_document']).toBeGreaterThanOrEqual(1);
  });

  it('16. historical run JSON remains byte-for-byte unchanged', async () => {
    const ctx = await makeWorkspace();
    const body = 'run source content';
    const docId = await makeDoc(ctx, { relPath: 'run.md', body });
    await addLegacyChunks(ctx, docId, [body]);
    await runBackfill(ctx);
    const runId = await makeRun(ctx, [snap('run.md', shaOf(body), 0)]);
    const before = JSON.stringify((await db().select({ s: runs.retrievedSources }).from(runs).where(eq(runs.id, runId)))[0]!.s);
    await runBackfill(ctx);
    const after = JSON.stringify((await db().select({ s: runs.retrievedSources }).from(runs).where(eq(runs.id, runId)))[0]!.s);
    expect(after).toBe(before);
  });

  it('17. exact historical run matches create normalized references', async () => {
    const ctx = await makeWorkspace();
    const body = 'run evidence';
    const docId = await makeDoc(ctx, { relPath: 're.md', body });
    await addLegacyChunks(ctx, docId, [body]);
    await runBackfill(ctx);
    const runId = await makeRun(ctx, [snap('re.md', shaOf(body), 0)]);
    await runBackfill(ctx);
    const v = (await versionsOf(docId))[0]!;
    const refs = await db().select({ chunk: runDocumentVersions.chunkIndex }).from(runDocumentVersions).where(and(eq(runDocumentVersions.runId, runId), eq(runDocumentVersions.documentVersionId, v.id)));
    const idxs = refs.map((r) => r.chunk).sort((a, b) => a - b);
    expect(idxs).toEqual([-1, 0]); // version-level sentinel + chunk-level
  });

  it('18. ambiguous run matches do not create normalized references', async () => {
    const ctx = await makeWorkspace();
    const body = 'ambiguous run';
    const dLocal = await makeDoc(ctx, { source: 'local_folder', relPath: 'ar.md', body });
    await addLegacyChunks(ctx, dLocal, [body]);
    const dCloud = await makeDoc(ctx, { source: 'cloud_upload', relPath: 'ar.md', body });
    await addLegacyChunks(ctx, dCloud, [body]);
    await runBackfill(ctx);
    const runId = await makeRun(ctx, [snap('ar.md', shaOf(body), 0)]);
    const rep = await runBackfill(ctx);
    const refs = await db().select({ id: runDocumentVersions.id }).from(runDocumentVersions).where(eq(runDocumentVersions.runId, runId));
    expect(refs.length).toBe(0);
    expect(rep.runRefs.ambiguous).toBeGreaterThanOrEqual(1);
  });

  it('19. repeated run-reference backfill creates no duplicates', async () => {
    const ctx = await makeWorkspace();
    const body = 'dedupe run';
    const docId = await makeDoc(ctx, { relPath: 'dr.md', body });
    await addLegacyChunks(ctx, docId, [body]);
    await runBackfill(ctx);
    const runId = await makeRun(ctx, [snap('dr.md', shaOf(body), 0)]);
    await runBackfill(ctx);
    const n1 = (await db().select({ id: runDocumentVersions.id }).from(runDocumentVersions).where(eq(runDocumentVersions.runId, runId))).length;
    await runBackfill(ctx);
    const n2 = (await db().select({ id: runDocumentVersions.id }).from(runDocumentVersions).where(eq(runDocumentVersions.runId, runId))).length;
    expect(n2).toBe(n1);
    void docId;
  });

  it('20. version-level normalized run uniqueness holds when no chunk is specified', async () => {
    const ctx = await makeWorkspace();
    const body = 'version-level';
    const docId = await makeDoc(ctx, { relPath: 'vl.md', body });
    await addLegacyChunks(ctx, docId, [body]);
    await runBackfill(ctx);
    // Two snapshots citing the SAME version via different chunks → still ONE version-level (-1) row.
    const runId = await makeRun(ctx, [snap('vl.md', shaOf(body), 0), snap('vl.md', shaOf(body), 1)]);
    await runBackfill(ctx);
    const v = (await versionsOf(docId))[0]!;
    const sentinel = await db().select({ id: runDocumentVersions.id }).from(runDocumentVersions).where(and(eq(runDocumentVersions.runId, runId), eq(runDocumentVersions.documentVersionId, v.id), eq(runDocumentVersions.chunkIndex, -1)));
    expect(sentinel.length).toBe(1);
  });

  it('21. a Stage B dual-write gap is detected and reconciled', async () => {
    const ctx = await makeWorkspace();
    const folder = await mkdtemp(join(tmpdir(), 'c1-f21-'));
    await setFolder(ctx, folder);
    const body = '# Gap\n\nActive, indexed, but no version row (missed dual-write).';
    await writeFile(join(folder, 'gap.md'), body);
    const docId = await makeDoc(ctx, { relPath: 'gap.md', body, status: 'active' });
    await addLegacyChunks(ctx, docId, ['# Gap', 'Active, indexed, but no version row (missed dual-write).']);
    expect((await versionsOf(docId)).length).toBe(0); // the gap
    const rep = await runBackfill(ctx);
    expect(rep.dualWrite.gaps).toBeGreaterThanOrEqual(1);
    expect(rep.dualWrite.reconciled).toBeGreaterThanOrEqual(1);
    expect(await currentOf(docId)).not.toBeNull();
    await rm(folder, { recursive: true, force: true });
  });

  it('22. a missing source after a failed dual-write becomes reconstructed or unavailable honestly', async () => {
    const ctx = await makeWorkspace();
    const withChunks = await makeDoc(ctx, { relPath: 'g-recon.md', sha: shaOf('gone1'), status: 'active' });
    await addLegacyChunks(ctx, withChunks, ['salvageable']);
    const noChunks = await makeDoc(ctx, { relPath: 'g-unavail.md', sha: shaOf('gone2'), status: 'active' });
    const rep = await runBackfill(ctx);
    expect((await versionsOf(withChunks))[0]!.fidelity).toBe('reconstructed_text');
    expect(await currentOf(withChunks)).not.toBeNull(); // salvaged → active with a current version
    expect((await versionsOf(noChunks))[0]!.fidelity).toBe('unavailable');
    expect(await currentOf(noChunks)).toBeNull();
    // The unavailable one is corrected to source_unavailable — an explicit non-retrievable state, NOT an
    // active document silently missing a current version. So the active gate stays clean.
    const noChunksDoc = (await db().select({ s: documents.status }).from(documents).where(eq(documents.id, noChunks)))[0]!;
    expect(noChunksDoc.s).toBe('source_unavailable');
    expect(rep.gate.withoutValidCurrent).toBe(0);
    expect(rep.stateCorrections.toSourceUnavailable).toBe(1);
  });

  it('23. a current pointer is assigned only after version validation', async () => {
    const ctx = await makeWorkspace();
    const body = 'valid';
    const docId = await makeDoc(ctx, { relPath: 'valid.md', body });
    await addLegacyChunks(ctx, docId, [body]);
    await runBackfill(ctx);
    const v = (await versionsOf(docId))[0]!;
    expect(v.status).toBe('indexed');
    expect(await currentOf(docId)).toBe(v.id); // points only at the indexed version
  });

  it('24. object orphans are reported but not automatically deleted', async () => {
    const ctx = await makeWorkspace();
    const orphanKey = tenantObjectKey({ orgId: ctx.orgId, projectId: ctx.projectId, sourceId: 'ghost', versionHash: 'deadbeef' });
    await store.put(orphanKey, Buffer.from('orphan bytes', 'utf8'), 'text/plain');
    const rep = await runBackfill(ctx);
    expect(rep.storage.orphanObjects).toBeGreaterThanOrEqual(1);
    expect(rep.storage.orphanScan).toBe('local');
    // NOT deleted.
    expect((await store.get(orphanKey)).toString('utf8')).toBe('orphan bytes');
  });

  it('25. byte_exact rows with missing/invalid objects are reported as integrity failures', async () => {
    const ctx = await makeWorkspace();
    const body = 'to be orphaned';
    const key = tenantObjectKey({ orgId: ctx.orgId, projectId: ctx.projectId, sourceId: 'be.md', versionHash: shaOf(body) });
    await store.put(key, Buffer.from(body, 'utf8'), 'text/markdown');
    const docId = await makeDoc(ctx, { source: 'cloud_upload', relPath: 'be.md', body, objectKey: key });
    await addLegacyChunks(ctx, docId, [body]);
    await runBackfill(ctx); // byte_exact version created, object at version key
    const v = (await versionsOf(docId))[0]!;
    await store.delete(v.key!); // the version's object disappears
    const rep = await runBackfill(ctx);
    expect(rep.integrity.byteExactMissingObject).toBeGreaterThanOrEqual(1);
  });

  it('26. the final reconciliation count accounts for every logical Document', async () => {
    const ctx = await makeWorkspace();
    await makeDoc(ctx, { relPath: 'acc-be.md', body: 'a', status: 'active' }).then((id) => addLegacyChunks(ctx, id, ['a']));
    await makeDoc(ctx, { relPath: 'acc-recon.md', sha: shaOf('gone'), status: 'active' }).then((id) => addLegacyChunks(ctx, id, ['b']));
    await makeDoc(ctx, { relPath: 'acc-unavail.md', sha: shaOf('none'), status: 'active' });
    const folder = await mkdtemp(join(tmpdir(), 'c1-f26-'));
    await setFolder(ctx, folder);
    await writeFile(join(folder, 'acc-be.md'), 'a');
    const rep = await runBackfill(ctx);
    expect(rep.baseline.documents).toBe(3);
    expect(rep.counts.logicalDocuments).toBe(3);
    // Every document is accounted for by a distinct outcome: skipped-already-reconciled + created +
    // existing-version-reuse. (No transient/retryable defects in this controlled workspace.)
    expect(rep.idempotency.skippedAlreadyReconciled + rep.versions.created + rep.idempotency.duplicateVersionInsertAvoided).toBe(rep.baseline.documents);
    // Distinct end-state accounting: 1 byte_exact + 1 reconstructed current + 1 source_unavailable.
    expect(rep.versions.byFidelity.byte_exact).toBe(1);
    expect(rep.versions.byFidelity.reconstructed_text).toBe(1);
    expect(rep.versions.byFidelity.unavailable).toBe(1);
    expect(rep.counts.docsSourceUnavailable).toBe(1);
    expect(rep.counts.docsWithNoVersionRow).toBe(0);
    // Every unavailable fidelity count corresponds to an actual version row.
    expect(rep.counts.totalVersionRowsAfter).toBe(3);
    await rm(folder, { recursive: true, force: true });
  });

  it('27. legacy retrieval results remain unchanged after C1', async () => {
    const ctx = await makeWorkspace();
    const docId = await makeDoc(ctx, { relPath: 'search.md', sha: shaOf('gone'), status: 'active' });
    await addLegacyChunks(ctx, docId, ['The enterprise pricing tier costs five hundred dollars per seat.']);
    const before = await withTenant(ctx, (tx) => retrieveRelevant(tx, ctx, 'enterprise pricing per seat', 5));
    const beforeNull = await nullVersionChunkCount(docId);
    await runBackfill(ctx);
    const after = await withTenant(ctx, (tx) => retrieveRelevant(tx, ctx, 'enterprise pricing per seat', 5));
    expect(after.map((h) => `${h.relativePath}|${h.content}`)).toEqual(before.map((h) => `${h.relativePath}|${h.content}`));
    expect(await nullVersionChunkCount(docId)).toBe(beforeNull); // null-version chunks untouched
    expect(before.length).toBeGreaterThan(0);
  });

  // ---- Stage C1 review corrections: unavailable-source lifecycle + reverse-trail dedup ------------

  it('28. no Document is left active without a valid current version', async () => {
    const ctx = await makeWorkspace();
    await makeDoc(ctx, { relPath: 'ok.md', body: 'k', status: 'active' }).then((id) => addLegacyChunks(ctx, id, ['k']));
    await makeDoc(ctx, { relPath: 'gone.md', sha: shaOf('gone'), status: 'active' }); // no bytes, no chunks
    await runBackfill(ctx);
    // Query the invariant directly: an active doc must have an indexed current version.
    const actives = await db().select({ id: documents.id, cur: documents.currentVersionId }).from(documents).where(and(eq(documents.projectId, ctx.projectId), eq(documents.status, 'active')));
    for (const d of actives) {
      expect(d.cur).not.toBeNull();
      const v = (await db().select({ s: documentVersions.indexStatus }).from(documentVersions).where(eq(documentVersions.id, d.cur!)))[0]!;
      expect(v.s).toBe('indexed');
    }
  });

  it('29. an unavailable Document is excluded from legacy retrieval and has no valid current version', async () => {
    const ctx = await makeWorkspace();
    const docId = await makeDoc(ctx, { relPath: 'excl.md', sha: shaOf('kubernetes replicas gone'), status: 'active' });
    await runBackfill(ctx); // → source_unavailable, unavailable version, no current
    // Legacy retrieval returns nothing from it (status not active + no null-version chunks).
    const legacy = await withTenant(ctx, (tx) => retrieveRelevant(tx, ctx, 'kubernetes replicas', 5));
    expect(legacy.some((h) => h.relativePath === 'excl.md')).toBe(false);
    // And it has no valid current version, so a current-version-gated (versioned) retrieval excludes it too.
    expect(await currentOf(docId)).toBeNull();
    const doc = (await db().select({ s: documents.status }).from(documents).where(eq(documents.id, docId)))[0]!;
    expect(doc.s).toBe('source_unavailable');
  });

  it('30. an unavailable version preserves identity (expected hash) but exposes no preview', async () => {
    const ctx = await makeWorkspace();
    const expected = shaOf('the expected but unretrievable content');
    const docId = await makeDoc(ctx, { relPath: 'ident.md', sha: expected, status: 'active' });
    await runBackfill(ctx);
    const v = (await versionsOf(docId))[0]!;
    expect(v.fidelity).toBe('unavailable');
    expect(v.sha).toBe(expected); // identity preserved
    expect(v.key).toBeNull(); // no object
    expect((await versionChunksOf(v.id)).length).toBe(0); // no preview/chunks
  });

  it('31. reconnection ingests a new byte_exact version (even at the same hash) and restores active', async () => {
    const ctx = await makeWorkspace();
    const RECONNECT_BODY = '# Reconnected\n\nThe exact original content is back on disk.';
    const expected = shaOf(RECONNECT_BODY);
    const docId = await makeDoc(ctx, { relPath: 'reconnect.md', sha: expected, status: 'active' });
    await runBackfill(ctx); // disconnected → source_unavailable + unavailable version at `expected`
    const unavailableV = (await versionsOf(docId)).find((v) => v.fidelity === 'unavailable')!;
    expect(unavailableV).toBeTruthy();

    // The folder comes back with the exact original bytes (same hash) → normal ingestion.
    const folder = await mkdtemp(join(tmpdir(), 'c1-reconnect-'));
    await setFolder(ctx, folder);
    await writeFile(join(folder, 'reconnect.md'), RECONNECT_BODY);
    await db().transaction((t) => refreshIndex(t, ctx));

    // A genuine byte_exact version now exists at the same hash, is current, and the doc is active again.
    const byteExact = (await versionsOf(docId)).find((v) => v.fidelity === 'byte_exact');
    expect(byteExact).toBeTruthy();
    expect(await currentOf(docId)).toBe(byteExact!.id);
    const doc = (await db().select({ s: documents.status }).from(documents).where(eq(documents.id, docId)))[0]!;
    expect(doc.s).toBe('active');
    await rm(folder, { recursive: true, force: true });
  });

  it('32. reconnection does not rewrite the unavailable historical version', async () => {
    const ctx = await makeWorkspace();
    const RECONNECT_BODY = 'reconnect body two';
    const expected = shaOf(RECONNECT_BODY);
    const docId = await makeDoc(ctx, { relPath: 'preserve.md', sha: expected, status: 'active' });
    await runBackfill(ctx);
    const before = (await versionsOf(docId)).find((v) => v.fidelity === 'unavailable')!;
    const folder = await mkdtemp(join(tmpdir(), 'c1-preserve-'));
    await setFolder(ctx, folder);
    await writeFile(join(folder, 'preserve.md'), RECONNECT_BODY);
    await db().transaction((t) => refreshIndex(t, ctx));
    // The unavailable row is byte-identical (still unavailable, still failed, same object=null).
    const after = (await versionsOf(docId)).find((v) => v.id === before.id)!;
    expect(after.fidelity).toBe('unavailable');
    expect(after.status).toBe('failed');
    expect(after.key).toBeNull();
    await rm(folder, { recursive: true, force: true });
  });

  it('33. every unavailable fidelity count corresponds to an actual version row', async () => {
    const ctx = await makeWorkspace();
    await makeDoc(ctx, { relPath: 'u-a.md', sha: shaOf('a'), status: 'active' });
    await makeDoc(ctx, { relPath: 'u-b.md', sha: shaOf('b'), status: 'active' });
    const rep = await runBackfill(ctx);
    const rows = await db().select({ id: documentVersions.id }).from(documentVersions).where(and(eq(documentVersions.projectId, ctx.projectId), eq(documentVersions.contentFidelity, 'unavailable')));
    expect(rep.versions.byFidelity.unavailable).toBe(rows.length);
    expect(rows.length).toBe(2);
  });

  it('34. reconciliation counts Documents-without-versions separately from Documents-without-current', async () => {
    const ctx = await makeWorkspace();
    // An archived doc with legacy chunks: backfill makes a reconstructed version, but an ARCHIVED doc is
    // never assigned a current pointer → it lands in "has a version, no current", NOT "no version row".
    const arch = await makeDoc(ctx, { relPath: 'arch34.md', sha: shaOf('x'), status: 'archived' });
    await addLegacyChunks(ctx, arch, ['archived chunk']);
    const rep = await runBackfill(ctx);
    expect(rep.counts.logicalDocuments).toBe(1);
    // The two categories are computed as DISTINCT counters: after a complete backfill every doc has a
    // version row (so no-version = 0), while the archived doc has a version but no current pointer.
    expect(rep.counts.docsWithNoVersionRow).toBe(0);
    expect(rep.counts.docsWithVersionNoCurrentPointer).toBe(1);
  });

  it('35. reverse-trail queries deduplicate version-level and chunk-level rows for the same run', async () => {
    const ctx = await makeWorkspace();
    const body = 'reverse trail evidence';
    const docId = await makeDoc(ctx, { relPath: 'rt.md', body, status: 'active' });
    await addLegacyChunks(ctx, docId, [body, 'second chunk']);
    await runBackfill(ctx);
    // One run that cited the version via two chunks → a version-level (-1) row + two chunk rows (3 rows).
    const runId = await makeRun(ctx, [snap('rt.md', shaOf(body), 0), snap('rt.md', shaOf(body), 1)]);
    await runBackfill(ctx);
    const v = (await versionsOf(docId))[0]!;
    const rawRows = await db().select({ id: runDocumentVersions.id }).from(runDocumentVersions).where(eq(runDocumentVersions.documentVersionId, v.id));
    expect(rawRows.length).toBe(3); // 1 version-level + 2 chunk-level
    // The reverse trail deduplicates to ONE run.
    const runsRef = await withTenant(ctx, (tx) => runsReferencingVersion(tx, ctx, v.id));
    expect(runsRef).toEqual([runId]);
    // Retention stays blocked after dedup.
    expect(await withTenant(ctx, (tx) => isVersionReferenced(tx, ctx, v.id))).toBe(true);
  });
});
